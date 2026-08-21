import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The near-window refresh: what it selects, and what it must not touch.
 *
 * The full sweep asks every league for a fortnight at two requests each. Almost all
 * of that is spent re-reading competitions that are out of season -- measured
 * against production on 2026-08-21, 48 of 359 leagues had a fixture that day and 74
 * within 48 hours. This pass asks only those, so it can run often enough to catch a
 * postponement or a late broadcast assignment before kickoff.
 *
 * The dangerous half is what it leaves alone. It does not fetch rosters, so it must
 * not stamp rosters_synced_at -- that column is the ONLY thing telling the boot the
 * full sweep is overdue, and a partial refresh writing it would make the catalogue
 * look permanently fresh. That failure has already happened once, from
 * events.updated_at, and froze the sweep for months.
 */
let db;
const leagues = {};

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const mk = async (slug, sport, priority, active = true) => {
    const { rows } = await db.query(
      `insert into leagues (provider, provider_key, slug, name, sport, active, priority,
                            rosters_synced_at)
       values ('espn', $1, $2, $2, $3, $4, $5, now() - interval '30 hours')
       returning id`,
      [`${sport}/${slug}`, slug, sport, active, priority],
    );
    leagues[slug] = rows[0].id;
    return rows[0].id;
  };

  await mk('tonight', 'baseball', 1);
  await mk('tomorrow', 'soccer', 2);
  await mk('next-week', 'hockey', 3);
  await mk('finished-earlier', 'basketball', 4);
  await mk('dormant', 'cricket', 100);
  await mk('inactive-but-playing', 'tennis', 5, false);

  const ev = (league, offset, name) =>
    db.query(
      `insert into events (provider, provider_key, league_id, starts_at, state, name)
       values ('espn', $1, $2, now() + $3::interval, 'pre', $4)`,
      [`espn/${name}`, leagues[league], offset, name],
    );

  await ev('tonight', '3 hours', 'tonight-a');
  // Two fixtures in one league: one request answers a whole league's window, so
  // this must not produce two rows.
  await ev('tonight', '5 hours', 'tonight-b');
  await ev('tomorrow', '30 hours', 'tomorrow-a');
  await ev('next-week', '9 days', 'next-week-a');
  await ev('finished-earlier', '-3 hours', 'earlier-a');
  await ev('inactive-but-playing', '4 hours', 'inactive-a');
}, 60_000);

/** The query the pass runs, with the same window syncNear() builds. */
const inWindow = async (hours) => {
  const { rows } = await db.query(
    `select distinct l.slug, l.priority
       from leagues l
       join events e on e.league_id = l.id
      where l.active
        and e.starts_at >= now() - interval '6 hours'
        and e.starts_at < now() + ($1 || ' hours')::interval
      order by l.priority`,
    [hours],
  );
  return rows.map((r) => r.slug);
};

describe('which leagues the near pass asks about', () => {
  test('only the ones with a game inside the window', async () => {
    expect(await inWindow(48)).toEqual(['tonight', 'tomorrow', 'finished-earlier']);
  });

  test('a league with several games in the window is still one request', async () => {
    const picked = await inWindow(48);
    expect(picked.filter((s) => s === 'tonight')).toHaveLength(1);
  });

  test('next week belongs to the full sweep, not this pass', async () => {
    expect(await inWindow(48)).not.toContain('next-week');
  });

  test('a game that finished a few hours ago is still read, to close it out', async () => {
    // The six-hour reach-back is why: a fixture played since the last pass still
    // needs its final state written.
    expect(await inWindow(48)).toContain('finished-earlier');
  });

  test('an inactive league is skipped even with a fixture tonight', async () => {
    expect(await inWindow(48)).not.toContain('inactive-but-playing');
  });

  test('a dormant competition costs nothing', async () => {
    expect(await inWindow(48)).not.toContain('dormant');
  });

  test('narrowing the window narrows the work', async () => {
    // 6h reaches tonight but not tomorrow, which is the knob SPORTS_NEAR_WINDOW_HOURS
    // turns if the request budget ever needs cutting further.
    expect(await inWindow(6)).toEqual(['tonight', 'finished-earlier']);
  });
});

describe('what the near pass must not do', () => {
  test('it leaves rosters_synced_at alone, so the daily sweep still comes due', async () => {
    // Simulates the pass: fixtures updated, roster timestamp untouched.
    const before = await db.query(`select rosters_synced_at from leagues where slug = 'tonight'`);
    await db.query(`update events set updated_at = now() where league_id = $1`, [leagues.tonight]);
    const after = await db.query(`select rosters_synced_at from leagues where slug = 'tonight'`);
    expect(after.rows[0].rosters_synced_at).toEqual(before.rows[0].rosters_synced_at);

    // And that untouched reading is what still reports the sweep as overdue.
    const { rows } = await db.query(
      `select (now() - max(rosters_synced_at)) > interval '24 hours' as overdue
         from leagues where active`,
    );
    expect(rows[0].overdue).toBe(true);
  });
});
