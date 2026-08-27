import { describe, expect, test } from 'bun:test';
import { PremiumPage } from '../apps/web/src/views/premium.jsx';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * The two pages that talk about money.
 *
 * What is pinned here is not layout. It is that every figure on the page comes
 * from the value it was handed -- a price written into the markup is a price that
 * will one day be advertised at one number and charged at another -- and that the
 * page never offers a control it cannot honour: no checkout without an account,
 * no join button when payments are switched off.
 */

const base = {
  user: { id: 'u1', handle: 'chovy', display_name: 'Anthony' },
  membership: null,
  priceCents: 1000,
  currency: 'USD',
  termDays: 365,
  commissionBps: 2000,
  freeHistoryDays: 30,
  paymentsEnabled: true,
  inviteUrl: 'https://genrewatch.com/i/abc123',
  invited: [],
  earnings: [],
  ledger: [],
};

const render = async (props) => String(await PremiumPage({ ...base, ...props }).toString());

describe('what the page says it costs', () => {
  test('the price and the rate are the ones it was handed', async () => {
    const html = await render({});
    expect(html).toContain('$10.00');
    expect(html).toContain('20%');
    expect(html).toContain('a year');
  });

  test('a different price is a different page, with nothing hardcoded left over', async () => {
    const html = await render({ priceCents: 2500, commissionBps: 1500, termDays: 30 });
    expect(html).toContain('$25.00');
    expect(html).toContain('15%');
    expect(html).toContain('a month');
    expect(html).not.toContain('$10.00');
    expect(html).not.toContain('20%');
  });

  test('an odd term is said in days rather than rounded into a lie', async () => {
    expect(await render({ termDays: 90 })).toContain('90 days');
  });

  test('all three features are named', async () => {
    const html = await render({});
    expect(html).toContain('Share streams with your friends');
    expect(html).toContain('Private messaging history');
    expect(html).toContain('the people you invite');
  });
});

describe('controls it can actually honour', () => {
  test('no checkout is offered without an account', async () => {
    // The webhook credits an account. A signed-out checkout would take money and
    // have nowhere to put the membership.
    const html = await render({ user: null, inviteUrl: null });
    expect(html).not.toContain('action="/api/membership/buy"');
    expect(html).toContain('Sign in to join');
  });

  test('nor when payments are switched off', async () => {
    const html = await render({ paymentsEnabled: false });
    expect(html).not.toContain('action="/api/membership/buy"');
    expect(html).toContain('not switched on');
  });

  test('a member is offered a renewal, and told it stacks', async () => {
    const html = await render({
      membership: { expires_at: new Date('2027-01-01T00:00:00Z').toISOString() },
    });
    expect(html).toContain('Renew for $10.00');
    expect(html).toContain('adds another');
  });

  test('a signed-out visitor is not shown an empty earnings box', async () => {
    const html = await render({ user: null, inviteUrl: null });
    expect(html).not.toContain('Your invite link');
    expect(html).not.toContain('People you brought in');
  });
});

describe('earnings', () => {
  test('each currency is reported on its own, never added together', async () => {
    const html = await render({
      earnings: [
        { currency: 'USD', n: 3, accrued_cents: 600, paid_cents: 0 },
        { currency: 'EUR', n: 1, accrued_cents: 200, paid_cents: 0 },
      ],
    });
    expect(html).toContain('$6.00');
    expect(html).toContain('€2.00');
    // $8.00 would be the number a naive sum produces, and it is not a real amount
    // of anything.
    expect(html).not.toContain('$8.00');
  });

  test('nothing earned says why, rather than showing a zero', async () => {
    const html = await render({});
    expect(html).toContain('not when they sign up');
  });
});
