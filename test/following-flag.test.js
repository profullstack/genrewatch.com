import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The per-viewer "you follow this fixture" flag on every schedule list.
 *
 * This exists because the bug it guards against was invisible: the event page
 * fetched follow state correctly and then never passed it to the view, so both
 * follow buttons rendered "not following" for a user who followed both teams. A
 * screenshot looked fine. Only the served markup showed it.
 *
 * Rather than restate the SQL here -- which would then be free to drift from what
 * actually ships -- the test lifts the clause out of queries.js and runs that exact
 * text. If someone edits the query, this runs the edit.
 */
let db;
let clause;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const source = await readFile(
    new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    'utf8',
  );
  const matches = [
    ...source.matchAll(/exists \(\s*select 1 from follows vf[\s\S]*?\) as following/g),
  ];
  // Four list queries carry the flag; if one loses it, that is the regression.
  expect(matches.length).toBe(4);
  // Every copy must be identical, so testing one tests them all.
  const texts = new Set(matches.map((m) => m[0].replace(/\s+/g, ' ')));
  expect(texts.size).toBe(1);
  // A regex, not a string literal: the thing being replaced is a template
  // placeholder in queries.js, and writing it as text here trips the lint rule
  // that looks for accidental ones.
  clause = matches[0][0].replace(/\$\{viewerId\}/, '$1');
}, 60_000);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

/** The flag as the schedule pages compute it, for one viewer and one event. */
const followsEvent = async (userId, eventId) =>
  (
    await one(
      `select ${clause} from events e join leagues l on l.id = e.league_id where e.id = $2`,
      [userId, eventId],
    )
  ).following;

describe('viewer follow flag', () => {
  let userId;
  let eventId;
  let homeId;
  let leagueId;

  beforeAll(async () => {
    leagueId = (
      await one(
        `insert into leagues (provider, provider_key, sport, slug, name)
         values ('espn','flag/test','basketball','flag-test','Flag Test') returning id`,
      )
    ).id;
    homeId = (
      await one(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn','flag/test/1',$1,'flag-home','Home','Home') returning id`,
        [leagueId],
      )
    ).id;
    const awayId = (
      await one(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn','flag/test/2',$1,'flag-away','Away','Away') returning id`,
        [leagueId],
      )
    ).id;
    eventId = (
      await one(
        `insert into events (provider, provider_key, league_id, starts_at, name,
                             home_team_id, away_team_id)
         values ('espn','flag/test/e1',$1, now() + interval '1 day','Away at Home',$2,$3)
         returning id`,
        [leagueId, homeId, awayId],
      )
    ).id;
    userId = (await one(`insert into users (email) values ('flag@example.com') returning id`)).id;
  });

  test('a signed-out visitor never has a followed fixture', async () => {
    expect(await followsEvent(null, eventId)).toBe(false);
  });

  test('a signed-in user who follows nothing sees no star', async () => {
    expect(await followsEvent(userId, eventId)).toBe(false);
  });

  test('following either team marks the fixture', async () => {
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'team',$2)`,
      [userId, homeId],
    );
    expect(await followsEvent(userId, eventId)).toBe(true);
  });

  test('following the league marks it too', async () => {
    const other = (await one(`insert into users (email) values ('flag2@example.com') returning id`))
      .id;
    expect(await followsEvent(other, eventId)).toBe(false);
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'league',$2)`,
      [other, leagueId],
    );
    expect(await followsEvent(other, eventId)).toBe(true);
  });

  test("one user's follow never leaks into another's view", async () => {
    const stranger = (
      await one(`insert into users (email) values ('stranger@example.com') returning id`)
    ).id;
    expect(await followsEvent(stranger, eventId)).toBe(false);
  });
});
