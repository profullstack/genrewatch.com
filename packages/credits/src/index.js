/**
 * Credit codes and scarce invites: @profullstack/redeem-credits and
 * @profullstack/affiliates over this site's own Postgres.
 *
 * Neither package keeps a second entitlement. A redeemed code and an accepted
 * invite both end in the insert a PAID term already takes -- `grantLivePass`
 * for Live TV days, `grantMembership` for Premium days -- with a `grant_ref`
 * that makes the grant idempotent. So "does this person hold a pass" still has
 * one answer, wherever the days came from.
 *
 * - A code grants `live_pass_days` or `premium_days` (the default is whichever
 *   can be used here: see defaultUnit). Minted by
 *   hand: `bun run credits mint --days 30`. One-off only: a monthly code would
 *   need a monthly top-up job, and both things are sold in days anyway.
 * - An invite is scarce (config.credits.inviteQuota per account, single use).
 *   When the invited person's account is CREATED by spending the emailed link
 *   (which proves the mailbox), both people get a few days: Live TV days while
 *   passes can be used, Premium days while they cannot.
 * - The older invite programme (users.invite_code, /invite, the 20%
 *   commission) is a different thing and is left exactly as it was. Its link
 *   is the affiliate link: open, unlimited, and it is what pays. These codes
 *   pay nothing; they are scarce, which is what makes them worth sending.
 *
 * Ported by hand from tipoffwatch.com #121 and watchnews.now #46 (same
 * packages, same schema): only `@genre/*` names and the brand differ.
 */

import { config } from '@genre/config';
import { sql } from '@genre/db';
import { GIFT_PLAN, grantLivePass } from '@genre/live';
import { grantMembership } from '@genre/payments/membership';
import {
  Affiliates,
  postgresStore as affiliatesStore,
  hashCode as inviteHash,
  normalizeCode as normalizeInvite,
} from '@profullstack/affiliates';
import {
  Credits,
  hashCode as codeHash,
  postgresStore as creditsStore,
  normalizeCode as normalizeCredit,
} from '@profullstack/redeem-credits';

export { affiliatesStore, creditsStore };

export const LIVE_DAYS = 'live_pass_days';
export const PREMIUM_DAYS = 'premium_days';
export const UNITS = [LIVE_DAYS, PREMIUM_DAYS];
const DAY_MS = 86_400_000;

/** Bun's SQL client in the `query(text, params) -> { rows }` shape both stores take. */
export const pgPool = (db = sql) => ({
  query: async (text, params = []) => ({ rows: await db.unsafe(text, params) }),
});

/** What a unit is called on a page. */
export const unitWord = (unit) => (unit === PREMIUM_DAYS ? 'Premium' : 'Live TV pass');

/**
 * Can days of this unit be used right now? Live TV days on a site where
 * passes are switched off would run out unseen, so they are not handed out.
 */
export const unitUsable = (unit) =>
  unit === LIVE_DAYS ? Boolean(config.live.enabled) : unit === PREMIUM_DAYS;

/**
 * The unit a code is minted in when none is named: Live TV days where passes
 * can be used, Premium days where they cannot (genrewatch sells Premium and has
 * Live TV switched off, so a Live TV code minted by default would only be refused).
 */
export const defaultUnit = () => (unitUsable(LIVE_DAYS) ? LIVE_DAYS : PREMIUM_DAYS);

/**
 * Days of `unit` for `userId`, through the same insert a paid term takes.
 * `ref` is the grant_ref ('code:<id>', 'invite:<id>:invitee', ...): one grant
 * per user per ref, so a retried call adds nothing.
 */
export async function grantDays({ userId, unit, days, ref, db = sql }) {
  const n = Math.trunc(Number(days));
  if (!(n >= 1)) throw new Error('days must be at least 1');
  if (!ref) throw new Error('a free grant needs a ref');
  if (unit === LIVE_DAYS) {
    return grantLivePass(db, {
      userId,
      paymentId: null,
      plan: GIFT_PLAN,
      days: n,
      priceCents: 0,
      currency: config.live.currency,
      grantRef: ref,
    });
  }
  if (unit === PREMIUM_DAYS) {
    return grantMembership(db, {
      userId,
      paymentId: null,
      priceCents: 0,
      currency: config.membership.currency,
      termDays: n,
      grantRef: ref,
    });
  }
  throw new Error(`no such unit ${unit}`);
}

/**
 * The bonus each side of an accepted invite gets, decided at acceptance:
 * Live TV days while passes can be used, Premium days otherwise, or nothing.
 */
export function inviteBonus() {
  const c = config.credits;
  if (unitUsable(LIVE_DAYS) && c.inviteBonusPassDays > 0)
    return { unit: LIVE_DAYS, days: c.inviteBonusPassDays };
  if (c.inviteBonusPremiumDays > 0) return { unit: PREMIUM_DAYS, days: c.inviteBonusPremiumDays };
  return null;
}

/**
 * The two services. Built once per process and lazily (nothing touches the
 * database at import time). Tests pass their own stores and db.
 */
export function makeCredits({
  creditStore,
  affiliateStore,
  db = sql,
  grant = grantDays,
  bonus = inviteBonus,
  now,
  quota = config.credits.inviteQuota,
  ttlDays = config.credits.inviteTtlDays,
} = {}) {
  const credits = new Credits(creditStore, {
    ...(now ? { now } : {}),
    onGrant: async (userId, g, source) => {
      if (!UNITS.includes(g.unit)) throw new Error(`this site grants days, not ${g.unit}`);
      await grant({ userId, unit: g.unit, days: g.amount, ref: source, db });
    },
  });
  const aff = new Affiliates(affiliateStore, {
    ...(now ? { now } : {}),
    defaultQuota: quota,
    inviteTtlMs: ttlDays > 0 ? ttlDays * DAY_MS : null,
  });
  return { credits, aff, affiliateStore, db, grant, bonus };
}

let shared = null;
export function services() {
  shared ??= makeCredits({
    creditStore: creditsStore(pgPool()),
    affiliateStore: affiliatesStore(pgPool()),
  });
  return shared;
}

/* ------------------------------------------------------------- credit codes -- */

export const REDEEM_ERRORS = {
  invalid: 'That code is not one we issued. Check it and try again.',
  expired: 'That code has expired.',
  used_up: 'That code has already been used.',
  already_redeemed: 'You have already redeemed that code.',
  revoked: 'That code was withdrawn.',
  unavailable:
    'That code is for Live TV, which is not switched on here yet. Keep it: it has not been used.',
};

const intIn = (v, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** Admin: make a code worth `days` of `unit`. The plaintext is returned once. */
export async function mintCode(
  {
    days,
    unit = defaultUnit(),
    label = '',
    maxRedemptions = 1,
    expiresInDays = null,
    createdBy = null,
  },
  svc = services(),
) {
  if (!UNITS.includes(unit)) throw bad(`unit must be one of ${UNITS.join(', ')}`);
  const d = intIn(days, 1, 3650);
  if (!d) throw bad('days must be a whole number from 1 to 3650');
  const max = intIn(maxRedemptions ?? 1, 1, 100_000);
  if (!max) throw bad('max must be from 1 to 100000');
  let expiresAt = null;
  if (expiresInDays !== null && expiresInDays !== undefined && expiresInDays !== '') {
    const e = intIn(expiresInDays, 1, 3650);
    if (!e) throw bad('expires must be 1 to 3650 days');
    expiresAt = Date.now() + e * DAY_MS;
  }
  const minted = await svc.credits.mint({
    grant: { unit, amount: d },
    label: String(label ?? '').slice(0, 120),
    maxRedemptions: max,
    expiresAt,
    createdBy: createdBy ?? undefined,
  });
  return codeOut(minted, minted.code);
}

export function codeOut(c, plaintext = undefined) {
  return {
    ...(plaintext ? { code: plaintext, url: `${config.siteUrl}/redeem?code=${plaintext}` } : {}),
    id: c.id,
    label: c.label,
    unit: c.grant.unit,
    days: c.grant.amount,
    max_redemptions: c.maxRedemptions,
    redemptions: c.redemptions ?? 0,
    expires_at: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    created_at: new Date(c.createdAt).toISOString(),
    revoked_at: c.revokedAt ? new Date(c.revokedAt).toISOString() : null,
  };
}

/** The unit a code would grant, without spending it. Null for an unknown code. */
async function unitOf(code, db) {
  const [row] = await db.unsafe('select unit from credit_codes where hash = $1', [
    codeHash(normalizeCredit(code)),
  ]);
  return row?.unit ?? null;
}

/**
 * Redeem a code for the signed-in person. `{ ok, unit, days }` or
 * `{ ok: false, reason, error }` with words a person can act on.
 */
export async function redeemCode(userId, input, svc = services()) {
  const code = String(input ?? '').trim();
  if (!code) return { ok: false, reason: 'invalid', error: 'Type the code first.' };
  if (code.length > 64) return { ok: false, reason: 'invalid', error: REDEEM_ERRORS.invalid };

  // Checked BEFORE the code is spent: a Live TV code on a site with passes
  // switched off would otherwise burn days nobody can use.
  const unit = await unitOf(code, svc.db);
  if (unit && !unitUsable(unit)) {
    return { ok: false, reason: 'unavailable', error: REDEEM_ERRORS.unavailable };
  }

  let r;
  try {
    r = await svc.credits.redeem(code, String(userId));
  } catch (err) {
    // The code is spent but the term did not save (the redemption stands, per
    // redeem-credits). grant_ref 'code:<id>' means adding it by hand later
    // still adds exactly one term.
    console.error('[credits] grant after redeem failed:', err.message);
    return {
      ok: false,
      reason: 'grant_failed',
      error: 'The code was accepted but the days did not save. Write to us and we will add them.',
    };
  }
  if (!r.ok) return { ok: false, reason: r.reason, error: REDEEM_ERRORS[r.reason] ?? 'No.' };
  return { ok: true, unit: r.grant.unit, days: r.grant.amount, code_id: r.codeId };
}

/* ------------------------------------------------------------------ invites -- */

export const INVITE_ERRORS = {
  invalid: 'That invite is not one we issued.',
  expired: 'That invite has expired.',
  used: 'That invite has already been used.',
  self: 'You cannot accept your own invite.',
  revoked: 'That invite was withdrawn.',
};

/**
 * An INV-XXXX-XXXX-XXXX invite, typed however. Strict enough that the older
 * programme's personal codes (12 base64url characters, no INV prefix) never
 * match, so /i/<code> can tell the two apart.
 */
export const looksLikeInvite = (s) =>
  /^inv[\s-]?[0-9a-z]{4}[\s-]?[0-9a-z]{4}[\s-]?[0-9a-z]{4}$/i.test(String(s ?? '').trim());

export const canonicalInvite = (s) => normalizeInvite(String(s ?? ''));

/** What an invite link is, without spending it: for the /i/<code> page. */
export async function inviteStatus(code, svc = services()) {
  if (!looksLikeInvite(code)) return 'invalid';
  const row = await svc.affiliateStore.getInviteByHash(inviteHash(canonicalInvite(code)));
  if (!row) return 'invalid';
  if (row.revokedAt !== null && row.revokedAt !== undefined) return 'revoked';
  if (row.usedBy !== null && row.usedBy !== undefined) return 'used';
  if (row.expiresAt !== null && row.expiresAt !== undefined && Date.now() >= row.expiresAt)
    return 'expired';
  return 'ok';
}

export function inviteOut(i, plaintext = undefined) {
  const status =
    i.usedBy !== null && i.usedBy !== undefined
      ? 'used'
      : i.revokedAt
        ? 'revoked'
        : i.expiresAt !== null && i.expiresAt !== undefined && Date.now() >= i.expiresAt
          ? 'expired'
          : 'open';
  return {
    ...(plaintext ? { code: plaintext, url: `${config.siteUrl}/i/${plaintext}` } : {}),
    id: i.id,
    note: i.note ?? '',
    status,
    created_at: new Date(i.createdAt).toISOString(),
    expires_at: i.expiresAt ? new Date(i.expiresAt).toISOString() : null,
    used_at: i.usedAt ? new Date(i.usedAt).toISOString() : null,
  };
}

export async function myInvites(userId, svc = services()) {
  const [quota, invites] = await Promise.all([
    svc.aff.quota(String(userId)),
    svc.aff.invites(String(userId)),
  ]);
  return { quota, invites: invites.map((i) => inviteOut(i)), bonus: svc.bonus() };
}

export async function createInvite(userId, note = '', svc = services()) {
  try {
    const made = await svc.aff.createInvite(String(userId), String(note ?? '').slice(0, 80));
    return { ok: true, invite: inviteOut(made, made.code) };
  } catch (err) {
    if (/no invites left/.test(err.message))
      return {
        ok: false,
        error: 'No invites left. Each account gets a few; they are meant to be scarce.',
      };
    throw err;
  }
}

/** Withdraw one of MY unused invites. Someone else's id answers like an unknown one. */
export async function revokeInvite(userId, inviteId, svc = services()) {
  const mine = await svc.aff.invites(String(userId));
  const invite = mine.find((i) => i.id === String(inviteId));
  if (!invite) return { ok: false, error: 'No such invite.' };
  if (invite.usedBy !== null && invite.usedBy !== undefined)
    return { ok: false, error: 'That invite was already used.' };
  await svc.aff.revokeInvite(invite.id);
  return { ok: true };
}

/**
 * A NEW account has just been created by spending its emailed link: accept
 * the invite it came with and give both people their days. The caller passes
 * `created` straight from the account upsert; an ordinary sign-in by an
 * existing account accepts nothing, so nobody collects bonuses by redeeming
 * invites on an account they already had.
 *
 * Never throws: an invite that cannot be honoured must not cost anybody their
 * sign-in.
 */
export async function acceptInvite({ userId, code, created }, svc = services()) {
  if (!created || !userId) return { ok: false, reason: 'not_new' };
  if (!code || !looksLikeInvite(code)) return { ok: false, reason: 'invalid' };
  try {
    const r = await svc.aff.redeemInvite(canonicalInvite(code), String(userId));
    if (!r.ok) return r;
    const b = svc.bonus();
    if (b) {
      for (const [who, side] of [
        [String(userId), 'invitee'],
        [r.inviterId, 'inviter'],
      ]) {
        try {
          await svc.grant({
            userId: who,
            unit: b.unit,
            days: b.days,
            ref: `invite:${r.inviteId}:${side}`,
            db: svc.db,
          });
        } catch (err) {
          // One side failing (say the inviter deleted their account) must not
          // take the other side's days with it.
          console.error(`[credits] invite ${r.inviteId} ${side} grant failed:`, err.message);
        }
      }
    }
    return { ...r, bonus: b };
  } catch (err) {
    console.error('[credits] invite accept failed:', err.message);
    return { ok: false, reason: 'error' };
  }
}
