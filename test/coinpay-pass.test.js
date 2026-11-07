import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  grantCoinpayPass,
  normalizePass,
  passGrantRef,
} from '../packages/payments/src/coinpay-pass.js';
import { grantMembership } from '../packages/payments/src/membership.js';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/** Profullstack Pass -> Premium until the pass expires, once per pass. */

let db;
let tx;
let alice;
let bob;
const DAY = 86_400_000;
const inDays = (n) => new Date(Date.now() + n * DAY);
const activeTerm = async (userId) =>
  (
    await db.query(
      `select expires_at from memberships
       where user_id = $1 and status = 'active' and expires_at > now()
       order by expires_at desc limit 1`,
      [userId],
    )
  ).rows[0] ?? null;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  tx = async (strings, ...values) => {
    let text = '';
    strings.forEach((part, i) => {
      text += part;
      if (i < values.length) text += `$${i + 1}`;
    });
    return (await db.query(text, values)).rows;
  };
  const mk = async (email, handle) =>
    (
      await db.query(`insert into users (email, handle) values ($1, $2) returning id`, [
        email,
        handle,
      ])
    ).rows[0].id;
  alice = await mk('pass-alice@example.test', 'passalice');
  bob = await mk('pass-bob@example.test', 'passbob');
}, 60_000);

describe('reading the pass claim', () => {
  test('active needs active === true and a future expires_at', () => {
    const exp = inDays(10).toISOString();
    expect(normalizePass({ active: true, expires_at: exp }).active).toBe(true);
    expect(normalizePass({ active: true, expiresAt: new Date(exp) }).active).toBe(true);
    expect(normalizePass({ active: 'true', expires_at: exp }).active).toBe(false);
    expect(normalizePass({ active: true }).active).toBe(false);
    expect(normalizePass({ active: true, expires_at: 'garbage' }).active).toBe(false);
    expect(normalizePass({ active: true, expires_at: inDays(-1).toISOString() }).active).toBe(
      false,
    );
    expect(normalizePass({ active: false, expires_at: exp }).active).toBe(false);
    expect(normalizePass(undefined).active).toBe(false);
  });

  test('the grant ref names the CoinPay sub and the pass expiry', () => {
    expect(passGrantRef('sub-1', new Date('2026-12-07T18:00:00.000Z'))).toBe(
      'coinpay-pass:sub-1:2026-12-07T18:00:00.000Z',
    );
  });
});

describe('granting Premium from a pass', () => {
  test('no pass, an inactive pass or an expired pass grants nothing', async () => {
    expect(await grantCoinpayPass(tx, { userId: bob, sub: 'b', pass: undefined })).toBeNull();
    expect(
      await grantCoinpayPass(tx, { userId: bob, sub: 'b', pass: { active: false } }),
    ).toBeNull();
    expect(
      await grantCoinpayPass(tx, {
        userId: bob,
        sub: 'b',
        pass: { active: true, expires_at: inDays(-2).toISOString() },
      }),
    ).toBeNull();
    expect(await activeTerm(bob)).toBeNull();
  });

  test('an active pass makes a member until it expires, once', async () => {
    const exp = inDays(30);
    const pass = { active: true, expiresAt: exp };
    const first = await grantCoinpayPass(tx, { userId: alice, sub: 'a', pass });
    expect(first.replayed).toBe(false);
    expect(new Date(first.expires_at).getTime()).toBe(exp.getTime());
    const again = await grantCoinpayPass(tx, { userId: alice, sub: 'a', pass });
    expect(again.replayed).toBe(true);
    const rows = (
      await db.query(`select count(*)::int n from memberships where user_id = $1`, [alice])
    ).rows[0].n;
    expect(rows).toBe(1);
    expect(new Date((await activeTerm(alice)).expires_at).getTime()).toBe(exp.getTime());
  });

  test('a paid term bought during the pass stacks after it', async () => {
    const g = await grantMembership(tx, {
      userId: alice,
      paymentId: null,
      priceCents: 0,
      currency: 'USD',
      termDays: 365,
      grantRef: 'test:stack',
    });
    expect(new Date(g.started_at).getTime()).toBeGreaterThanOrEqual(inDays(30).getTime() - 5_000);
  });
});
