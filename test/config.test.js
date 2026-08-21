import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

describe('coinpay credential family', () => {
  test('accepts a merchant key and rejects an OAuth client id', async () => {
    const mod = await import('../packages/config/src/index.js');

    // The two families both start `cp` and only diverge at checkout, so this is
    // asserted at boot instead.
    process.env.COINPAY_API_KEY = `cp_live_${'a'.repeat(32)}`;
    const fresh = await import(`../packages/config/src/index.js?merchant=${Date.now()}`);
    expect(() => fresh.assertCoinpayMerchantKey()).not.toThrow();

    process.env.COINPAY_API_KEY = `cp_${'b'.repeat(24)}`;
    const oauth = await import(`../packages/config/src/index.js?oauth=${Date.now()}`);
    expect(() => oauth.assertCoinpayMerchantKey()).toThrow(/merchant/i);

    expect(typeof mod.config).toBe('object');
  });
});

describe('required variables', () => {
  test('a missing DATABASE_URL fails at boot, naming itself', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      // The regression this guards: `req('DATABASE_URL', 'postgres://localhost…')`
      // silently dialled localhost instead, so a service deployed without the
      // variable died seconds later with ERR_POSTGRES_CONNECTION_CLOSED — a driver
      // error that names neither the variable nor the service.
      await expect(import(`../packages/config/src/index.js?missing=${Date.now()}`)).rejects.toThrow(
        /DATABASE_URL/,
      );
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  test('REDIS_URL stays optional', async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const mod = await import(`../packages/config/src/index.js?noredis=${Date.now()}`);
      expect(mod.config.redisUrl).toContain('redis://');
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });
});

describe('fixture backfill window', () => {
  // The trap this guards: widening SPORTS_PLAYS_CATCHUP_HOURS to two weeks moved the
  // backlog by zero rows in production, because the sweep only ever asked the
  // provider for `now - 6h` forward. The catch-up window ranks fixtures that are
  // already stored; it cannot reach one that was never fetched. So the reach-back
  // has to be its own lever, and its default has to be the old behaviour exactly.
  const load = async (tag) => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
    return import(`../packages/config/src/index.js?${tag}=${Date.now()}`);
  };

  test('defaults to zero, which leaves the six-hour floor untouched', async () => {
    const saved = process.env.SPORTS_BACKFILL_DAYS;
    delete process.env.SPORTS_BACKFILL_DAYS;
    try {
      const mod = await load('backfill-default');
      expect(mod.config.sports.backfillDays).toBe(0);
      // max() with the floor is what makes zero a no-op rather than a `from` of now.
      expect(Math.max(6 * 3600_000, mod.config.sports.backfillDays * 86_400_000)).toBe(
        6 * 3600_000,
      );
    } finally {
      if (saved === undefined) delete process.env.SPORTS_BACKFILL_DAYS;
      else process.env.SPORTS_BACKFILL_DAYS = saved;
    }
  });

  test('a fortnight reaches back a fortnight, not six hours', async () => {
    const saved = process.env.SPORTS_BACKFILL_DAYS;
    process.env.SPORTS_BACKFILL_DAYS = '14';
    try {
      const mod = await load('backfill-14');
      expect(mod.config.sports.backfillDays).toBe(14);
      expect(Math.max(6 * 3600_000, mod.config.sports.backfillDays * 86_400_000)).toBe(
        14 * 86_400_000,
      );
    } finally {
      if (saved === undefined) delete process.env.SPORTS_BACKFILL_DAYS;
      else process.env.SPORTS_BACKFILL_DAYS = saved;
    }
  });
});
