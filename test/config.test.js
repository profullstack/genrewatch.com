import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

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

describe('reminder offsets', () => {
  const load = async (tag) => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
    return import(`../packages/config/src/index.js?${tag}=${Date.now()}`);
  };

  // The two lists are not interchangeable and the defaults prove it: 60 and 1 are
  // minutes before a start time, 1440 and 0 are relative to a date. Feeding either
  // list to the other class produces a reminder at an hour nobody chose, which is
  // the failure the time_known split exists to prevent.
  test('timed and dated offsets are separate lists with separate defaults', async () => {
    const mod = await load('offsets');
    expect(mod.config.reminders.defaultOffsets).toEqual([60, 1]);
    expect(mod.config.reminders.dateOffsets).toEqual([1440, 0]);
  });

  // Zero is meaningful for a dated release ("on the day") and meaningless for a
  // timed one, which already has a one-minute offset. The two filters differ by
  // exactly this, so it is worth pinning.
  test('zero is allowed for dates and rejected for times', async () => {
    const saved = [process.env.REMINDER_OFFSETS, process.env.REMINDER_DATE_OFFSETS];
    process.env.REMINDER_OFFSETS = '0,60';
    process.env.REMINDER_DATE_OFFSETS = '0,1440';
    try {
      const mod = await load('offsets-zero');
      expect(mod.config.reminders.defaultOffsets).toEqual([60]);
      expect(mod.config.reminders.dateOffsets).toEqual([0, 1440]);
    } finally {
      if (saved[0] === undefined) delete process.env.REMINDER_OFFSETS;
      else process.env.REMINDER_OFFSETS = saved[0];
      if (saved[1] === undefined) delete process.env.REMINDER_DATE_OFFSETS;
      else process.env.REMINDER_DATE_OFFSETS = saved[1];
    }
  });
});

describe('the sync sequence', () => {
  /*
   * The sync walks providers one at a time, so ordering is a real scheduling
   * decision rather than cosmetics. Spaceflight gets FIFTEEN requests an hour for
   * the whole deployment and its pass is two of them; music is one request per
   * second against an upstream that times out. On the first production sync music
   * held the queue long enough that spaceflight had still not run twenty minutes
   * later, and it only gets one chance an hour.
   */
  test('the cheap, hourly-budgeted provider runs before the slow one', async () => {
    const src = await Bun.file(
      new URL('../packages/catalog/src/index.js', import.meta.url).pathname,
    ).text();
    expect(src.indexOf("name: 'spacedevs'")).toBeLessThan(src.indexOf("name: 'musicbrainz'"));
  });

  test('music carries a wall-clock ceiling so it cannot monopolise a pass', async () => {
    const src = await Bun.file(
      new URL('../packages/catalog/src/musicbrainz.js', import.meta.url).pathname,
    ).text();
    expect(src).toContain('const outOfTime =');
    // Enforced in BOTH loops. Checking only the pager would leave the artist
    // backfill free to spend sixty seconds past the deadline, one second at a time.
    expect(src).toContain('if (outOfTime()) break;');
    expect(src).toContain('!outOfTime()');
  });
});
