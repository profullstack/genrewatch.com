import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const { config } = await import('../packages/config/src/index.js');
const credits = await import('../packages/credits/src/index.js');

/**
 * Credit codes and scarce invites, on a fully migrated PGlite.
 *
 * What is pinned: a code's days land as a real live_passes / memberships row
 * (the paid path, so every entitlement check sees them), a grant is exactly
 * once per ref, a Live TV code is refused WITHOUT being spent while passes are
 * off, and an invite pays both sides only for an account it created.
 */

let pg;
/** Tagged template (what grantLivePass/grantMembership take) plus .unsafe (what the stores take). */
let db;
let svc;
const ids = {};

const liveEnabled = (on) =>
  Object.defineProperty(config.live, 'enabled', { get: () => on, configurable: true });

beforeAll(async () => {
  pg = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(await readFile(dir + f, 'utf8'));
  }
  db = async (strings, ...values) => {
    let text = '';
    strings.forEach((part, i) => {
      text += part;
      if (i < values.length) text += `$${i + 1}`;
    });
    return (await pg.query(text, values)).rows;
  };
  db.unsafe = async (text, params = []) => (await pg.query(text, params)).rows;

  const pool = credits.pgPool(db);
  svc = credits.makeCredits({
    creditStore: credits.creditsStore(pool),
    affiliateStore: credits.affiliatesStore(pool),
    db,
    quota: 3,
    ttlDays: 30,
  });

  for (const name of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    ids[name] = (
      await pg.query('insert into users (email) values ($1) returning id', [`${name}@example.test`])
    ).rows[0].id;
  }
}, 60_000);

afterAll(() => liveEnabled(false));

const passes = async (userId) =>
  (
    await pg.query(
      'select plan, grant_ref, price_cents, expires_at - started_at as len from live_passes where user_id = $1 order by started_at',
      [userId],
    )
  ).rows;
const memberships = async (userId) =>
  (
    await pg.query(
      'select grant_ref, price_cents, expires_at - started_at as len from memberships where user_id = $1 order by started_at',
      [userId],
    )
  ).rows;
const days = (interval) => interval?.days ?? Number.parseInt(String(interval), 10);

describe('minting', () => {
  test('a code is CR-, shown once, stored as a hash', async () => {
    liveEnabled(true);
    const c = await credits.mintCode({ days: 30, label: 'for Kim' }, svc);
    expect(c.code).toMatch(/^CR-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(c.unit).toBe('live_pass_days');
    expect(c.url).toContain(`/redeem?code=${c.code}`);
    const stored = (await pg.query('select hash, label from credit_codes where id = $1', [c.id]))
      .rows[0];
    expect(stored.label).toBe('for Kim');
    expect(stored.hash).not.toContain(c.code.slice(3));
  });

  test('with no unit named, a code is Premium days while Live TV is off', async () => {
    liveEnabled(false);
    expect(credits.defaultUnit()).toBe('premium_days');
    const c = await credits.mintCode({ days: 7 }, svc);
    expect(c.unit).toBe('premium_days');
    liveEnabled(true);
    expect(credits.defaultUnit()).toBe('live_pass_days');
  });

  test('refuses nonsense', async () => {
    await expect(credits.mintCode({ days: 0 }, svc)).rejects.toThrow('days');
    await expect(credits.mintCode({ days: 5, unit: 'usd_cents' }, svc)).rejects.toThrow('unit');
    await expect(credits.mintCode({ days: 5, maxRedemptions: 0 }, svc)).rejects.toThrow('max');
  });
});

describe('redeeming', () => {
  test('a Live TV code while passes are off is refused and NOT spent', async () => {
    liveEnabled(false);
    const c = await credits.mintCode({ days: 10, unit: 'live_pass_days' }, svc);
    const r = await credits.redeemCode(ids.alice, c.code, svc);
    expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
    const row = (await pg.query('select redemptions from credit_codes where id = $1', [c.id]))
      .rows[0];
    expect(row.redemptions).toBe(0);
    expect(await passes(ids.alice)).toEqual([]);

    // ...and works once Live TV is on.
    liveEnabled(true);
    const ok = await credits.redeemCode(ids.alice, c.code.toLowerCase().replaceAll('-', ' '), svc);
    expect(ok).toMatchObject({ ok: true, unit: 'live_pass_days', days: 10 });
    const rows = await passes(ids.alice);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plan: 'gift', price_cents: 0, grant_ref: `code:${c.id}` });
    expect(days(rows[0].len)).toBe(10);
  });

  test('a second code stacks after the pass already held', async () => {
    liveEnabled(true);
    const c = await credits.mintCode({ days: 5, unit: 'live_pass_days' }, svc);
    expect((await credits.redeemCode(ids.alice, c.code, svc)).ok).toBe(true);
    const [first, second] = await pass2(ids.alice);
    expect(new Date(second.started_at).getTime()).toBe(new Date(first.expires_at).getTime());
  });

  test('a Premium code writes a memberships term', async () => {
    const c = await credits.mintCode({ days: 14, unit: 'premium_days' }, svc);
    const r = await credits.redeemCode(ids.bob, c.code, svc);
    expect(r).toMatchObject({ ok: true, unit: 'premium_days', days: 14 });
    const rows = await memberships(ids.bob);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grant_ref: `code:${c.id}`, price_cents: 0 });
    expect(days(rows[0].len)).toBe(14);
  });

  test('the refusals, in words', async () => {
    liveEnabled(true);
    expect((await credits.redeemCode(ids.carol, 'CR-0000-0000-0000-0000', svc)).reason).toBe(
      'invalid',
    );
    expect((await credits.redeemCode(ids.carol, '', svc)).reason).toBe('invalid');
    const c = await credits.mintCode({ days: 1 }, svc);
    expect((await credits.redeemCode(ids.carol, c.code, svc)).ok).toBe(true);
    expect((await credits.redeemCode(ids.carol, c.code, svc)).reason).toBe('already_redeemed');
    expect((await credits.redeemCode(ids.dave, c.code, svc)).reason).toBe('used_up');
    const r = await credits.mintCode({ days: 1 }, svc);
    await svc.credits.revoke(r.id);
    const revoked = await credits.redeemCode(ids.dave, r.code, svc);
    expect(revoked.reason).toBe('revoked');
    expect(revoked.error).toBe(credits.REDEEM_ERRORS.revoked);
  });

  test('a grant is once per ref, however often it is retried', async () => {
    await credits.grantDays({ userId: ids.erin, unit: 'premium_days', days: 3, ref: 'test:x', db });
    const again = await credits.grantDays({
      userId: ids.erin,
      unit: 'premium_days',
      days: 3,
      ref: 'test:x',
      db,
    });
    expect(again.replayed).toBe(true);
    expect(await memberships(ids.erin)).toHaveLength(1);
    await credits.grantDays({
      userId: ids.erin,
      unit: 'live_pass_days',
      days: 2,
      ref: 'test:y',
      db,
    });
    expect(
      await credits.grantDays({
        userId: ids.erin,
        unit: 'live_pass_days',
        days: 2,
        ref: 'test:y',
        db,
      }),
    ).toBeNull();
    expect(await passes(ids.erin)).toHaveLength(1);
  });
});

async function pass2(userId) {
  return (
    await pg.query(
      'select started_at, expires_at from live_passes where user_id = $1 order by started_at',
      [userId],
    )
  ).rows;
}

describe('invites', () => {
  test('three each, single use, a withdrawn unused one comes back', async () => {
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await credits.createInvite(ids.dave, `n${i}`, svc));
    expect(made.every((m) => m.ok)).toBe(true);
    expect(made[0].invite.code).toMatch(/^INV-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(made[0].invite.url).toContain(`/i/${made[0].invite.code}`);
    const fourth = await credits.createInvite(ids.dave, '', svc);
    expect(fourth.ok).toBe(false);
    expect((await credits.revokeInvite(ids.dave, made[2].invite.id, svc)).ok).toBe(true);
    expect((await credits.createInvite(ids.dave, '', svc)).ok).toBe(true);
    // Somebody else's id answers like an unknown one.
    expect((await credits.revokeInvite(ids.alice, made[0].invite.id, svc)).ok).toBe(false);
  });

  test('accepted by a NEW account: both get Live TV days when passes are on', async () => {
    liveEnabled(true);
    const { invite } = await credits.createInvite(ids.carol, 'for a new one', svc);
    expect(await credits.inviteStatus(invite.code, svc)).toBe('ok');
    const fresh = (
      await pg.query(`insert into users (email) values ('new1@example.test') returning id`)
    ).rows[0].id;
    const r = await credits.acceptInvite({ userId: fresh, code: invite.code, created: true }, svc);
    expect(r.ok).toBe(true);
    expect(r.bonus).toEqual({ unit: 'live_pass_days', days: config.credits.inviteBonusPassDays });
    expect((await passes(fresh)).map((p) => p.grant_ref)).toEqual([`invite:${r.inviteId}:invitee`]);
    expect((await passes(ids.carol)).map((p) => p.grant_ref)).toContain(
      `invite:${r.inviteId}:inviter`,
    );
    expect(await credits.inviteStatus(invite.code, svc)).toBe('used');
  });

  test('Premium days instead while Live TV is off', async () => {
    liveEnabled(false);
    expect(credits.inviteBonus()).toEqual({
      unit: 'premium_days',
      days: config.credits.inviteBonusPremiumDays,
    });
    const { invite } = await credits.createInvite(ids.bob, '', svc);
    const fresh = (
      await pg.query(`insert into users (email) values ('new2@example.test') returning id`)
    ).rows[0].id;
    const r = await credits.acceptInvite({ userId: fresh, code: invite.code, created: true }, svc);
    expect(r.ok).toBe(true);
    expect(await memberships(fresh)).toHaveLength(1);
    expect(await passes(fresh)).toEqual([]);
  });

  test('an existing account accepts nothing, and the invite stays usable', async () => {
    const { invite } = await credits.createInvite(ids.alice, '', svc);
    const r = await credits.acceptInvite(
      { userId: ids.erin, code: invite.code, created: false },
      svc,
    );
    expect(r.ok).toBe(false);
    expect(await credits.inviteStatus(invite.code, svc)).toBe('ok');
  });

  test('self, used, and junk', async () => {
    const { invite } = await credits.createInvite(ids.erin, '', svc);
    expect(
      (await credits.acceptInvite({ userId: ids.erin, code: invite.code, created: true }, svc))
        .reason,
    ).toBe('self');
    expect(
      (await credits.acceptInvite({ userId: ids.bob, code: 'nonsense', created: true }, svc))
        .reason,
    ).toBe('invalid');
    expect(await credits.inviteStatus('INV-0000-0000-0000', svc)).toBe('invalid');
  });

  test("the older programme's personal codes never look like a scarce invite", () => {
    // users.invite_code: 9 random bytes as base64url, 12 characters.
    expect(credits.looksLikeInvite('aB3_x-9QzK1m')).toBe(false);
    expect(credits.looksLikeInvite('ABCDEFGHJKMN')).toBe(false);
    expect(credits.looksLikeInvite('INV-7K3M-QX9D-2F8H')).toBe(true);
    expect(credits.looksLikeInvite('inv 7k3m qx9d 2f8h')).toBe(true);
  });
});
