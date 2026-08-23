import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Every queue that has a worker must also have something that enqueues to it.
 *
 * Ported from tipoffwatch, where the playlist refresh silently never ran: the
 * queue was declared, the worker was registered and consuming, and the one line in
 * installSchedules that actually creates the repeatable was lost in a rebase.
 *
 * Nothing failed. A consumer with no producer does not error, it waits -- so the
 * logs were empty, the app was healthy, and the feature was simply absent. That is
 * the shape of bug worth a test: not a wrong answer, a missing one. It is ported
 * alongside the feature rather than after the same bug happens here.
 */

const dir = new URL('../packages/queue/src/', import.meta.url).pathname;
const INDEX = readFileSync(`${dir}index.js`, 'utf8');
const WORKERS = readFileSync(`${dir}workers.js`, 'utf8');

/** The keys of the QUEUES table, e.g. sync, scan, fanout, batch, playlists. */
function queueKeys() {
  const block = INDEX.slice(INDEX.indexOf('export const QUEUES'), INDEX.indexOf('const defaults'));
  return [...block.matchAll(/^\s{2}(\w+):\s*'/gm)].map((m) => m[1]);
}

describe('every queue is wired at both ends', () => {
  const keys = queueKeys();

  test('the queue table is not empty, so this test cannot pass vacuously', () => {
    expect(keys.length).toBeGreaterThan(4);
    expect(keys).toContain('playlists');
  });

  for (const key of keys) {
    // fanout and batch are enqueued by other jobs at runtime rather than by a
    // repeatable, so they are producers-on-demand and exempt from the schedule
    // half of this check.
    const onDemand = ['fanout', 'batch'].includes(key);

    test(`${key}: something enqueues to it`, () => {
      if (onDemand) return;
      expect(INDEX).toContain(`queues.${key}.add(`);
    });

    test(`${key}: something consumes it`, () => {
      expect(WORKERS).toContain(`QUEUES.${key}`);
    });
  }
});

describe('the refresh that went missing upstream', () => {
  test('the playlist repeatable is registered', () => {
    expect(INDEX).toContain('queues.playlists.add(');
  });

  test('its interval comes from configuration, not a literal', () => {
    // So it can be slowed down without a deploy when a provider objects to the
    // traffic, which is the lever that matters for this one.
    expect(INDEX).toContain('config.playlists.refreshMinutes');
  });

  test('its queue is cleared on boot like the others, so the interval can change', () => {
    // BullMQ keys a repeatable by its pattern; changing the interval without
    // removing the old one leaves both running forever.
    // Searched forward FROM the loop, not from the start of the file: the first
    // `])` in the module belongs to something else entirely.
    const from = INDEX.indexOf('for (const queue of [');
    expect(from).toBeGreaterThan(-1);
    const clearLine = INDEX.slice(from, INDEX.indexOf('])', from) + 2);
    expect(clearLine).toContain('queues.playlists');
  });

  /*
   * The backfill has to start on the deploy that ships it.
   *
   * A repeatable first fires one INTERVAL from now, so a six-hourly job on a fresh
   * deployment does nothing for six hours -- and on a day of frequent deploys the
   * timer is reset each time and it may never fire at all. That is the trap this
   * file exists to guard, and the IMDb pass is the newest thing to fall into it.
   *
   * Enqueuing unconditionally is safe because the WORKER decides: it reads the
   * progress row and returns immediately when a full pass completed within the day.
   */
  test('an IMDb pass is enqueued on boot, not only on the repeatable', () => {
    expect(INDEX).toContain("queues.imdb.add('imdb', {}, { jobId: `imdb-");
    expect(INDEX).toContain("queues.imdb.add('imdb', {}, { repeat:");
  });

  /*
   * A BullMQ job id containing a colon is parsed as a structured key and crashes at
   * runtime rather than at deploy. Every id built here uses '-'.
   */
  test('no scheduled job id contains a colon', () => {
    for (const m of INDEX.matchAll(/jobId: `([^`]+)`/g)) {
      expect(m[1]).not.toContain(':');
    }
  });
});
