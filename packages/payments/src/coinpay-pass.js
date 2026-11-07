/**
 * Profullstack Pass: a CoinPay user who deposited $99 into their own CoinPay
 * wallet gets a free month on every Profullstack property
 * (https://coinpayportal.com/pass).
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS SHARED VERBATIM BETWEEN BRANDS. Do not import a brand package.
 * ---------------------------------------------------------------------------
 *
 * CoinPay reports the pass as a userinfo claim, which this site only sees at
 * sign-in. So the sign-in callback turns an active pass into a free Premium term
 * here: one `memberships` row from now until the pass expires, price 0, keyed on
 * grant_ref `coinpay-pass:<coinpay sub>:<expires_at>`. That row IS the persisted
 * pass: `activeMembership` already reads the furthest-out active term, so nothing
 * else needs to know a pass exists, and a later paid term stacks after it.
 *
 * Idempotent through the (user_id, grant_ref) partial unique index: signing in
 * ten times during one pass inserts one row. A renewed pass has a new expires_at
 * and therefore a new ref.
 *
 * The term does NOT stack on top of a paid term the member already holds: the
 * pass is "Premium until the pass expires", not "30 more days".
 *
 * Live TV passes are never granted from a Profullstack Pass: those pay the IPTV
 * reseller line.
 */

export const PASS_URL = 'https://coinpayportal.com/pass';
export const PASS_GRANT_PREFIX = 'coinpay-pass';

/**
 * Same rule as @profullstack/coinpay-onboard passFromUserinfo: active only when
 * `active === true` AND `expires_at` parses to a date still in the future.
 * Accepts either the raw userinfo claim (`{ active, expires_at }`) or the parsed
 * one finishSignIn returns (`{ active, expiresAt: Date }`).
 */
export function normalizePass(pass, now = new Date()) {
  if (!pass || typeof pass !== 'object') return { active: false, expiresAt: null };
  const raw = pass.expiresAt ?? pass.expires_at ?? null;
  const parsed =
    raw instanceof Date ? raw : typeof raw === 'string' && raw.trim() ? new Date(raw) : null;
  const expiresAt = parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
  const active = pass.active === true && expiresAt !== null && expiresAt.getTime() > now.getTime();
  return { active, expiresAt };
}

export function passGrantRef(sub, expiresAt) {
  return `${PASS_GRANT_PREFIX}:${sub}:${expiresAt.toISOString()}`;
}

/**
 * Grant Premium until the pass expires, once per pass. Returns null when there is
 * no active pass, else `{ started_at, expires_at, replayed }`.
 *
 * @param {Function} tx tagged-template SQL (a transaction or the pool)
 * @param {{ userId: string, sub: string, pass: object, now?: Date, currency?: string }} args
 */
export async function grantCoinpayPass(
  tx,
  { userId, sub, pass, now = new Date(), currency = 'USD' },
) {
  if (!userId || !sub) return null;
  const p = normalizePass(pass, now);
  if (!p.active) return null;
  const ref = passGrantRef(sub, p.expiresAt);
  const expiresIso = p.expiresAt.toISOString();

  const [row] = await tx`
    insert into memberships (user_id, payment_id, started_at, expires_at, price_cents, currency, grant_ref)
    select ${userId}::uuid, null, now(), ${expiresIso}::timestamptz, 0, ${currency}, ${ref}
    where ${expiresIso}::timestamptz > now()
    on conflict do nothing
    returning started_at, expires_at
  `;
  if (row) return { ...row, replayed: false };

  const [existing] = await tx`
    select started_at, expires_at from memberships
    where user_id = ${userId}::uuid and grant_ref = ${ref}
  `;
  return existing ? { ...existing, replayed: true } : null;
}
