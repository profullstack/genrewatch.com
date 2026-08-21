import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * What makes the boot decide the fixture sweep is overdue.
 *
 * The sweep is what writes venues, records, display names and new fixtures, and it
 * is triggered by data staleness rather than a timer -- because the repeatable's
 * timer restarts on every deploy and so never fires on a busy day.
 *
 * The staleness reading therefore has to come from something only the sweep itself
 * writes. It used to read events.updated_at, which the live-scores tick rewrites
 * every 60 seconds: the reading was always about a minute old, the sweep was never
 * overdue, and it silently stopped running.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  await db.query(
    `insert into leagues (provider, provider_key, slug, name, sport, active, rosters_synced_at)
     values ('espn', 'baseball/mlb', 'baseball-mlb', 'MLB', 'baseball', true, now() - interval '8 hours')`,
  );
  const { rows } = await db.query(`select id from leagues limit 1`);
  await db.query(
    `insert into events (provider, provider_key, league_id, starts_at, state, name, updated_at)
     values ('espn', 'baseball/mlb/1', $1, now() + interval '2 hours', 'pre', 'A at B', now())`,
    [rows[0].id],
  );
}, 60_000);

const readingFromLeagues = async () =>
  (await db.query(`select max(rosters_synced_at) as synced from leagues where active`)).rows[0]
    .synced;

const readingFromEvents = async () =>
  (await db.query(`select max(updated_at) as synced from events`)).rows[0].synced;

const staleBy = (ts, ms) => !ts || Date.now() - new Date(ts).getTime() > ms;

describe('fixture sweep staleness', () => {
  test('a league swept 8 hours ago reads as overdue', async () => {
    expect(staleBy(await readingFromLeagues(), 6 * 3600_000)).toBe(true);
  });

  test('the live-scores tick cannot mask it', async () => {
    // This is the regression: the event row was touched a moment ago by a score
    // update, and reading staleness from there says everything is current while the
    // sweep has not run for eight hours.
    expect(staleBy(await readingFromEvents(), 6 * 3600_000)).toBe(false);
    expect(staleBy(await readingFromLeagues(), 6 * 3600_000)).toBe(true);
  });

  test('a fresh sweep settles it, so this cannot loop', async () => {
    await db.query(`update leagues set rosters_synced_at = now() where active`);
    expect(staleBy(await readingFromLeagues(), 6 * 3600_000)).toBe(false);
  });

  test('a database that has never been swept is overdue, not current', async () => {
    await db.query(`update leagues set rosters_synced_at = null where active`);
    expect(staleBy(await readingFromLeagues(), 6 * 3600_000)).toBe(true);
  });

  test('a forced sweep does not have to wait for the window', async () => {
    // The case staleness cannot cover: code that reads a new provider field ships
    // an hour after the last sweep, so nothing is due for another five and the new
    // column is null everywhere in the meantime.
    const src = await readFile(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('config.sync.onBoot');
    expect(src).toContain('stale || forced');
    // It must bucket by minute: an hour bucket would match a sweep already run this
    // hour and skip the one that was explicitly asked for.
    expect(src).toContain('forced || rosterless > 0 || unnamed > 0');
  });

  test('the threshold is configurable rather than a literal', async () => {
    const src = await readFile(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('config.sync.staleHours');
  });

  test('the boot reads leagues, not events', async () => {
    const src = await readFile(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('max(rosters_synced_at) as synced from leagues');
    expect(src).not.toContain('max(updated_at) as synced from events');
  });
});
