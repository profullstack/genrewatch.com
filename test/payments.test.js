import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

/*
 * The package imports nothing from this brand, so the test wires it the same way
 * the app does.
 *
 * That is the point of the refactor rather than a cost of it: @tipoff/payments and
 * @genre/payments are now the SAME FILE, copied verbatim, which they could not be
 * while it named a scope. What used to be an implicit dependency on whichever
 * module imported config first -- the thing that made these very tests a coin flip
 * decided by the rest of the suite -- is now three explicit lines.
 */
const { configurePayments, createCheckout, verifyWebhook, settleWebhook } = await import(
  '../packages/payments/src/index.js'
);

configurePayments({
  // Not touched by signature verification. A throwing stub is a louder failure
  // than a silent no-op if that ever stops being true.
  sql: () => {
    throw new Error('the database is not part of verifying a signature');
  },
  coinpay: {
    webhookSecret: 'whsec_test_secret',
    apiKey: `cp_test_${'0'.repeat(32)}`,
    businessId: 'biz_test',
    baseUrl: 'https://coinpayportal.example',
    enabled: true,
  },
  siteUrl: 'https://example.test',
});

const sign = (body, t, secret = 'whsec_test_secret') =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('coinpay webhook verification', () => {
  const body = JSON.stringify({ id: 'pay_1', status: 'paid', metadata: { event_id: '5' } });
  const now = () => Math.floor(Date.now() / 1000);

  test('accepts a correctly signed, fresh webhook', () => {
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now()) })).toBe(true);
  });

  test('rejects a tampered body', () => {
    const header = sign(body, now());
    const tampered = body.replace('"paid"', '"refunded"');
    expect(verifyWebhook({ rawBody: tampered, signatureHeader: header })).toBe(false);
  });

  test('rejects a signature made with the wrong secret', () => {
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now(), 'wrong') })).toBe(
      false,
    );
  });

  test('rejects a replay outside the tolerance window', () => {
    // A captured webhook replayed an hour later must not settle a payment again.
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now() - 3600) })).toBe(false);
  });

  test('accepts one just inside the window and rejects one just outside', () => {
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now() - 290) })).toBe(true);
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now() - 310) })).toBe(false);
  });

  test('rejects malformed or absent headers', () => {
    for (const h of [undefined, '', 'garbage', 't=abc,v1=def', `t=${now()}`]) {
      expect(verifyWebhook({ rawBody: body, signatureHeader: h })).toBe(false);
    }
  });

  test('rejects a v1 of the wrong length without throwing', () => {
    // timingSafeEqual throws on length mismatch; the guard must swallow that.
    expect(verifyWebhook({ rawBody: body, signatureHeader: `t=${now()},v1=aa` })).toBe(false);
  });
});

describe('settlement gating', () => {
  /**
   * A fake `sql` with just enough shape for settleWebhook: a tagged template that
   * answers the payment UPDATE, and a `begin` that runs the callback.
   */
  const fakeSql = () => [{ id: 1, status: 'x' }];
  fakeSql.begin = async (fn) => {
    const tx = () => [{ id: 1, status: 'x' }];
    return fn(tx);
  };

  const settleWith = async (status) => {
    const calls = [];
    configurePayments({
      sql: fakeSql,
      coinpay: { webhookSecret: 'whsec_test_secret', enabled: true },
      siteUrl: 'https://example.test',
    });
    const result = await settleWebhook(
      { id: 'pay_1', status, metadata: { user_id: 'u1', event_id: '5' } },
      {
        grant: async () => {
          calls.push(status);
          return { ok: true };
        },
      },
    );
    return { result, granted: calls.length };
  };

  test('a settled status reaches the grant', async () => {
    for (const good of ['paid', 'completed', 'confirmed', 'succeeded', 'settled']) {
      const { result, granted } = await settleWith(good);
      expect(granted).toBe(1);
      expect(result.granted).toBe(true);
    }
  });

  /*
   * A verified signature proves the message is GENUINE, never that money arrived.
   * Granting on any verified webhook is how payment.failed hands out a free
   * stream -- and, because the caller's grant is what consumes capacity, it is
   * also how a failed payment burns a seat a real buyer then cannot have.
   *
   * Asserted by running it rather than by grepping the source: the guarantee now
   * spans two files -- the gate is in the shared package, the seat claim is in the
   * brand that has seats -- and only the behaviour is common to both.
   */
  test('an unsettled status never reaches the grant at all', async () => {
    for (const bad of ['failed', 'cancelled', 'refunded', 'pending', '']) {
      const { result, granted } = await settleWith(bad);
      expect(granted).toBe(0);
      expect(result.granted).toBe(false);
      expect(result.settled).toBe(false);
    }
  });

  test('the list of statuses that count as paid has not quietly grown', async () => {
    const src = await Bun.file(
      new URL('../packages/payments/src/index.js', import.meta.url).pathname,
    ).text();
    const listed = src.slice(src.indexOf('const SETTLED = new Set('));
    expect(listed.slice(0, listed.indexOf(']'))).toContain(
      "'paid', 'completed', 'confirmed', 'succeeded', 'settled'",
    );
  });
});

describe('createCheckout', () => {
  /*
   * The real fetch, put back after every test.
   *
   * bun:test runs every file in one process, so a global left swapped out is not
   * scoped to this file -- it is the fetch every later test gets. Leaving it
   * clobbered took out 26 unrelated tests across the espn adapter, the roster
   * sweep and the stream proxy, none of which have anything to do with payments,
   * and each of which failed in a way that pointed at itself rather than here.
   */
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const capture = () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ success: true, payment: { id: 'pay_9' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const rows = [];
    const sql = (...args) => {
      rows.push(args);
      return [];
    };
    configurePayments({
      sql,
      coinpay: {
        enabled: true,
        apiKey: 'cp_test_x',
        businessId: 'biz_1',
        baseUrl: 'https://pay.example',
        webhookSecret: 'whsec_test_secret',
      },
      siteUrl: 'https://example.test',
    });
    return calls;
  };

  const base = {
    user: { id: 'u1' },
    amountCents: 500,
    description: 'a thing',
    blockchain: 'BTC',
    payTo: 'bc1qexample',
  };

  /*
   * The upstream treats the payee as OPTIONAL and falls back to the PLATFORM
   * wallet when it is missing. That is the worst shape of failure: the payment
   * succeeds, the buyer gets what they bought, and the proceeds land somewhere the
   * seller never chose, with nothing surfacing it.
   */
  test('refuses to take money with nowhere to send it', async () => {
    capture();
    expect(createCheckout({ ...base, payTo: undefined })).rejects.toThrow(/payTo/);
  });

  test('and settling to the platform takes a deliberate flag', async () => {
    const calls = capture();
    await createCheckout({ ...base, payTo: undefined, allowPlatformSettlement: true });
    expect(calls[0].body).not.toHaveProperty('merchant_wallet_address');
  });

  test('sends the payee when it has one', async () => {
    const calls = capture();
    await createCheckout(base);
    expect(calls[0].body.merchant_wallet_address).toBe('bc1qexample');
  });

  /* The upstream refuses a crypto payment with no chain: "Invalid or missing
     cryptocurrency type". Failing at the call site beats failing at the moment a
     buyer presses pay. */
  test('a crypto checkout must name its chain', async () => {
    capture();
    expect(createCheckout({ ...base, blockchain: undefined })).rejects.toThrow(/blockchain/);
  });

  test('a card checkout does not need one', async () => {
    const calls = capture();
    await createCheckout({ ...base, blockchain: undefined, paymentMethod: 'card' });
    expect(calls[0].body.payment_method).toBe('card');
  });

  /*
   * The response is { success, payment: {...} }. Reading body.id finds nothing, so
   * the pending row would be written under an undefined reference and the webhook
   * could never match it.
   */
  test('takes the reference from the nested payment', async () => {
    capture();
    const { paymentRef } = await createCheckout(base);
    expect(paymentRef).toBe('pay_9');
  });

  /*
   * There is no generic checkout_url field. A card payment returns a Stripe
   * session; a crypto one returns an address, and the page that renders it is the
   * hosted checkout.
   */
  test('sends a crypto buyer to the hosted checkout page', async () => {
    capture();
    const { checkoutUrl } = await createCheckout(base);
    expect(checkoutUrl).toBe('https://pay.example/pay/pay_9');
  });
});
