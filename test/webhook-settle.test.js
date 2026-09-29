import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { configurePayments, settleWebhook } from '../packages/payments/src/index.js';
import { grantMembership, MEMBERSHIP_KIND } from '../packages/payments/src/membership.js';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * CoinPay settlement against the real schema: nested body in, one grant out.
 *
 * CoinPay sends payment.confirmed and then payment.forwarded for the same payment,
 * and retries either. Only `forwarded` sits in CoinPay's durable retry queue
 * (webhook_deliveries), so a receiver that ignores it loses a buyer for good the
 * first time `confirmed` fails. These pin both halves of that: forwarded on its
 * own grants, and every mix of the two grants exactly once.
 *
 * The SQL is the production SQL, run on PGlite with every migration applied, so
 * the idempotency being asserted is the unique index on payment_id -- not a
 * paraphrase of it.
 */

let db;
let user;

/** postgres.js-shaped tagged template over a PGlite connection. */
const adapt =
  (conn) =>
  async (strings, ...values) => {
    let text = '';
    strings.forEach((part, i) => {
      text += part;
      if (i < values.length) text += `$${i + 1}`;
    });
    const params = values.map((v) =>
      v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v,
    );
    return (await conn.query(text, params)).rows;
  };

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  const sql = adapt(db);
  sql.begin = (fn) => db.transaction((t) => fn(adapt(t)));
  configurePayments({
    sql,
    coinpay: { webhookSecret: 'whsec_test_secret', enabled: true },
    siteUrl: 'https://example.test',
  });
}, 60_000);

beforeEach(async () => {
  const email = `buyer-${crypto.randomUUID()}@example.test`;
  const handle = `b${crypto.randomUUID().slice(0, 8)}`;
  user = (
    await db.query('insert into users (email, handle) values ($1, $2) returning id', [
      email,
      handle,
    ])
  ).rows[0].id;
});

/** What createCheckout writes: our own record of what was charged. */
const checkout = async (cents = 1000, ref = crypto.randomUUID()) => {
  await db.query(
    `insert into payments (user_id, provider, provider_ref, amount_cents, currency, status)
     values ($1, 'coinpay', $2, $3, 'USD', 'pending')`,
    [user, ref, cents],
  );
  return ref;
};

/** The envelope CoinPay signs. The top-level id is the EVENT, never the payment. */
const nested = (paymentId, status, metadata) => ({
  id: `evt_${paymentId}_${Math.floor(Date.now() / 1000)}`,
  type: `payment.${status}`,
  data: {
    payment_id: paymentId,
    status,
    amount: 10,
    amount_usd: 10,
    currency: 'USDC_ETH',
    metadata: { user_id: user, ...metadata },
  },
  created_at: new Date().toISOString(),
  business_id: 'biz_test',
});

/*
 * The app's membership grant. Not the live pass: importing packages/live pulls the
 * real db queries in through @genre/auth, which defeats password-verify.test.js's
 * mock.module in the shared test process. Both rows dedupe the same way, on a
 * unique payment_id, so the membership stands for both.
 */
const grant = async (tx, { meta, payment }) =>
  grantMembership(tx, {
    userId: meta.user_id,
    paymentId: payment.id,
    priceCents: payment.amount_cents,
    currency: payment.currency,
    termDays: 365,
  });

const count = async (table) =>
  Number(
    (await db.query(`select count(*)::int as n from ${table} where user_id = $1`, [user])).rows[0]
      .n,
  );

describe('payment.forwarded', () => {
  test('on its own grants a membership', async () => {
    // The live case: confirmed failed once and is gone; forwarded is what retries.
    const ref = await checkout();
    const result = await settleWebhook(nested(ref, 'forwarded', { kind: MEMBERSHIP_KIND }), {
      grant,
    });
    expect(result.settled).toBe(true);
    expect(result.granted).toBe(true);
    expect(await count('memberships')).toBe(1);
  });
});

describe('confirmed, forwarded and their retries', () => {
  const deliveries = ['confirmed', 'forwarded', 'forwarded', 'confirmed'];

  test('grant one membership term, not four', async () => {
    const ref = await checkout();
    for (const status of deliveries) {
      await settleWebhook(nested(ref, status, { kind: MEMBERSHIP_KIND }), { grant });
    }
    expect(await count('memberships')).toBe(1);
    const [{ days }] = (
      await db.query(
        `select round(extract(epoch from (max(expires_at) - min(started_at))) / 86400)::int as days
         from memberships where user_id = $1`,
        [user],
      )
    ).rows;
    expect(days).toBe(365);
  });

  test('two different payments still grant two terms', async () => {
    // Idempotent per payment, not per buyer: a renewal is real money.
    for (const ref of [await checkout(), await checkout()]) {
      await settleWebhook(nested(ref, 'confirmed', { kind: MEMBERSHIP_KIND }), { grant });
      await settleWebhook(nested(ref, 'forwarded', { kind: MEMBERSHIP_KIND }), { grant });
    }
    expect(await count('memberships')).toBe(2);
  });
});

describe('what still grants nothing', () => {
  test('a payment we never checked out is answered, not thrown, and grants nothing', async () => {
    const result = await settleWebhook(
      nested(crypto.randomUUID(), 'forwarded', { kind: MEMBERSHIP_KIND }),
      { grant },
    );
    expect(result).toMatchObject({ settled: false, granted: false });
    expect(result.reason).toContain('unknown payment');
    expect(await count('memberships')).toBe(0);
  });

  test('pending, expired and failed grant nothing', async () => {
    const ref = await checkout();
    for (const status of ['pending', 'expired', 'failed', 'cancelled']) {
      const result = await settleWebhook(nested(ref, status, { kind: MEMBERSHIP_KIND }), {
        grant,
      });
      expect(result.granted).toBe(false);
    }
    expect(await count('memberships')).toBe(0);
  });
});
