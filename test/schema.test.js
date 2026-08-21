import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The migrations and the scale-critical queries, run against a real Postgres 18
 * in-process. No server, no Docker -- so this runs in CI and on a laptop alike.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  // Booting a WASM Postgres and running every migration overruns the 5s default on a
  // loaded machine; the work is legitimately slow rather than hung.
}, 60_000);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

describe('migrations', () => {
  test('every table the app queries exists', async () => {
    const { rows } = await db.query(
      `select table_name from information_schema.tables where table_schema='public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'users',
      'login_tokens',
      'sessions',
      'passkeys',
      'leagues',
      'teams',
      'events',
      'follows',
      'reminder_prefs',
      'push_subscriptions',
      'reminder_deliveries',
      'stream_offers',
      'payments',
      'entitlements',
    ]) {
      expect(names).toContain(t);
    }
  });

  test('there is no password column anywhere', async () => {
    const { rows } = await db.query(
      `select table_name, column_name from information_schema.columns
       where table_schema='public' and column_name ilike '%password%'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('reminder fan-out', () => {
  let eventId;
  let userIds;

  beforeAll(async () => {
    const league = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','soccer/eng.1','soccer','soccer-eng-1','Premier League') returning id`,
    );
    const home = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','soccer/1',$1,'ars','Arsenal','Arsenal') returning id`,
      [league.id],
    );
    const away = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','soccer/2',$1,'cov','Coventry','Coventry City') returning id`,
      [league.id],
    );
    const ev = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id, away_team_id)
       values ('espn','soccer/eng.1/1',$1, now() + interval '61 minutes','Arsenal v Coventry',$2,$3)
       returning id`,
      [league.id, home.id, away.id],
    );
    eventId = ev.id;

    // 250 followers: some follow the home team, some the league, some both --
    // the fan-out must count each person exactly once.
    userIds = [];
    for (let i = 0; i < 250; i++) {
      const u = await one(`insert into users (email) values ($1) returning id`, [
        `u${i}@example.com`,
      ]);
      userIds.push(u.id);
      if (i % 2 === 0) {
        await db.query(
          `insert into follows (user_id, subject_type, subject_id) values ($1,'team',$2)`,
          [u.id, home.id],
        );
      }
      if (i % 3 === 0) {
        await db.query(
          `insert into follows (user_id, subject_type, subject_id) values ($1,'league',$2)`,
          [u.id, league.id],
        );
      }
    }
  }, 60_000);

  const page = (after, limit) =>
    db.query(
      `select distinct f.user_id from events e
       join follows f on (f.subject_type='league' and f.subject_id = e.league_id)
                      or (f.subject_type='team' and f.subject_id in (e.home_team_id, e.away_team_id))
       where e.id = $1 and f.user_id > $2::uuid
       order by f.user_id limit $3`,
      [eventId, after, limit],
    );

  test('keyset paging covers every follower exactly once', async () => {
    const expected = await db.query(
      `select count(distinct f.user_id)::int as n from events e
       join follows f on (f.subject_type='league' and f.subject_id = e.league_id)
                      or (f.subject_type='team' and f.subject_id in (e.home_team_id, e.away_team_id))
       where e.id = $1`,
      [eventId],
    );
    const total = expected.rows[0].n;
    expect(total).toBeGreaterThan(150);

    let after = '00000000-0000-0000-0000-000000000000';
    const seen = new Set();
    let pages = 0;
    for (;;) {
      const { rows } = await page(after, 50);
      if (rows.length === 0) break;
      for (const r of rows) {
        // A duplicate here is the bug OFFSET paging would have introduced.
        expect(seen.has(r.user_id)).toBe(false);
        seen.add(r.user_id);
      }
      after = rows[rows.length - 1].user_id;
      pages++;
      if (rows.length < 50) break;
    }
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThan(1);
  });

  test('a person following both the team and the league is notified once', async () => {
    const { rows } = await page('00000000-0000-0000-0000-000000000000', 1000);
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(rows.length);
  });

  const claimFor = (uid) =>
    db.query(
      `insert into reminder_deliveries (event_id, user_id, offset_minutes, channel)
       values ($1,$2,60,'webpush')
       on conflict (event_id, user_id, offset_minutes, channel) do update
         set status = 'sent', sent_at = now()
         where reminder_deliveries.status = 'failed'
       returning user_id`,
      [eventId, uid],
    );

  test('claiming a delivery twice sends once', async () => {
    const uid = userIds[0];
    expect((await claimFor(uid)).rows.length).toBe(1);
    // The retry -- BullMQ redelivering the same batch -- must win nothing.
    expect((await claimFor(uid)).rows.length).toBe(0);
  });

  test('a failed delivery can be re-claimed, a sent one cannot', async () => {
    const uid = userIds[1];
    expect((await claimFor(uid)).rows.length).toBe(1);

    // The send blew up, so the row is marked failed and the job will be retried.
    await db.query(
      `update reminder_deliveries set status = 'failed'
       where event_id = $1 and user_id = $2 and offset_minutes = 60 and channel = 'webpush'`,
      [eventId, uid],
    );

    // Without the do-update clause this returns nothing and the reminder is lost
    // for good on the first transient push error.
    expect((await claimFor(uid)).rows.length).toBe(1);

    // And now that it succeeded, it is closed again.
    expect((await claimFor(uid)).rows.length).toBe(0);
  });

  test('the due window opens when the threshold is crossed, not before', async () => {
    const mk = async (minutesAway, key) => {
      const l = await one(`select id from leagues where slug = 'soccer-eng-1'`);
      const r = await one(
        `insert into events (provider, provider_key, league_id, starts_at, name)
         values ('espn',$1,$2, now() + ($3 * interval '1 minute'),'W') returning id`,
        [key, l.id, minutesAway],
      );
      return r.id;
    };

    const due = async (offset) =>
      (
        await db.query(
          `select e.id from events e
           where e.state = 'pre'
             and e.starts_at - ($1 * interval '1 minute') <= now()
             and e.starts_at - ($1 * interval '1 minute') > now() - (300 * interval '1 second')`,
          [offset],
        )
      ).rows.map((r) => r.id);

    // 61 minutes away: the 60-minute threshold is still a minute in the future.
    const early = await mk(61, 'w/early');
    expect(await due(60)).not.toContain(early);

    // 59 minutes away: crossed a minute ago, and well inside the lookback.
    const ready = await mk(59, 'w/ready');
    expect(await due(60)).toContain(ready);

    // Its 1-minute reminder is still 58 minutes off.
    expect(await due(1)).not.toContain(ready);

    // Crossed 10 minutes ago: outside the lookback, so a backlogged worker drops it
    // rather than telling someone a game starts in an hour when it already has.
    const stale = await mk(45, 'w/stale');
    expect(await due(60)).not.toContain(stale);
  });
});

describe('stream offers', () => {
  test('capacity cannot be oversold', async () => {
    const u = await one(`insert into users (email) values ('seller@example.com') returning id`);
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','x/y','soccer','x-y','L') returning id`,
    );
    const e = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name)
       values ('espn','x/y/1',$1, now() + interval '1 day','G') returning id`,
      [l.id],
    );
    const o = await one(
      `insert into stream_offers (event_id, seller_user_id, provider_ref, price_cents, capacity)
       values ($1,$2,'ref',100,2) returning id`,
      [e.id, u.id],
    );

    const buy = () =>
      db.query(
        `update stream_offers set sold = sold + 1 where id = $1 and active and sold < capacity returning id`,
        [o.id],
      );

    expect((await buy()).rows.length).toBe(1);
    expect((await buy()).rows.length).toBe(1);
    // The third buyer must get nothing rather than a seat that does not exist.
    expect((await buy()).rows.length).toBe(0);

    const row = await one(`select sold, capacity from stream_offers where id = $1`, [o.id]);
    expect(row.sold).toBe(2);
  });

  test('a person cannot buy the same game twice', async () => {
    const u = await one(`insert into users (email) values ('buyer@example.com') returning id`);
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','a/b','soccer','a-b','L2') returning id`,
    );
    const e = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name)
       values ('espn','a/b/1',$1, now() + interval '1 day','G2') returning id`,
      [l.id],
    );
    const ins = () =>
      db.query(
        `insert into entitlements (user_id, event_id, expires_at)
         values ($1,$2, now() + interval '1 day')
         on conflict (user_id, event_id) do nothing returning id`,
        [u.id, e.id],
      );
    expect((await ins()).rows.length).toBe(1);
    expect((await ins()).rows.length).toBe(0);
  });
});

describe('team ↔ league membership', () => {
  test('a club in several competitions appears in every one of them', async () => {
    const l1 = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','soccer/eng.1b','soccer','eng-1b','Premier League') returning id`,
    );
    const l2 = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','soccer/eng.fa','soccer','eng-fa','FA Cup') returning id`,
    );
    const team = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','soccer/368',$1,'eng-1b-368','Everton','Everton') returning id`,
      [l1.id],
    );

    // Both competitions claim the club, in either order.
    for (const l of [l1, l2]) {
      await db.query(
        `insert into team_leagues (team_id, league_id) values ($1,$2) on conflict do nothing`,
        [team.id, l.id],
      );
    }

    const inLeague = async (leagueId) =>
      (
        await db.query(
          `select t.display_name from team_leagues tl
           join teams t on t.id = tl.team_id where tl.league_id = $1`,
          [leagueId],
        )
      ).rows.map((r) => r.display_name);

    // The bug: teams.league_id was a single FK, so the second competition's sweep
    // overwrote the first and the club vanished from its own league page.
    expect(await inLeague(l1.id)).toContain('Everton');
    expect(await inLeague(l2.id)).toContain('Everton');
  });

  test('re-linking the same pair is idempotent', async () => {
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','x/idem','soccer','x-idem','L') returning id`,
    );
    const t = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','x/idem-1',$1,'x-idem-1','T','T') returning id`,
      [l.id],
    );
    for (let i = 0; i < 3; i++) {
      await db.query(
        `insert into team_leagues (team_id, league_id) values ($1,$2) on conflict do nothing`,
        [t.id, l.id],
      );
    }
    const { rows } = await db.query(
      `select count(*)::int as n from team_leagues where team_id = $1 and league_id = $2`,
      [t.id, l.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('fixture ↔ team re-linking', () => {
  test('an upsert re-attaches teams to a fixture whose references were cleared', async () => {
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','football/nfl','football','football-nfl','NFL') returning id`,
    );
    const home = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','football/nfl/34',$1,'nfl-34','Texans','Houston Texans') returning id`,
      [l.id],
    );
    const away = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','football/nfl/13',$1,'nfl-13','Raiders','Las Vegas Raiders') returning id`,
      [l.id],
    );
    const ev = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id, away_team_id)
       values ('espn','football/nfl/999',$1, now() + interval '2 days','Raiders at Texans',$2,$3)
       returning id`,
      [l.id, home.id, away.id],
    );

    // What migration 0005 did when it rebuilt every team row.
    await db.query(`update events set home_team_id = null, away_team_id = null where id = $1`, [
      ev.id,
    ]);

    // The next sweep re-upserts the same fixture. Without home_team_id/away_team_id
    // in the ON CONFLICT set, this updated the name and time and left the references
    // null -- the list still rendered "Raiders at Texans" from the provider's title
    // string while every team page sat empty.
    await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id, away_team_id)
       values ('espn','football/nfl/999',$1, now() + interval '2 days','Raiders at Texans',$2,$3)
       on conflict (provider, provider_key) do update set
         name = excluded.name,
         home_team_id = coalesce(excluded.home_team_id, events.home_team_id),
         away_team_id = coalesce(excluded.away_team_id, events.away_team_id)`,
      [l.id, home.id, away.id],
    );

    const row = await one(`select home_team_id, away_team_id from events where id = $1`, [ev.id]);
    expect(row.home_team_id).toBe(home.id);
    expect(row.away_team_id).toBe(away.id);

    // And the team now reports its fixture instead of "no fixtures scheduled".
    const cnt = await one(
      `select count(*)::int as n from events
       where (home_team_id = $1 or away_team_id = $1) and starts_at > now()`,
      [home.id],
    );
    expect(cnt.n).toBe(1);
  });

  test('a provider omitting one side cannot wipe a reference already resolved', async () => {
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','racing/f1b','racing','racing-f1b','F1') returning id`,
    );
    const t = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','racing/f1b/1',$1,'f1b-1','X','X') returning id`,
      [l.id],
    );
    const ev = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id)
       values ('espn','racing/f1b/1',$1, now() + interval '1 day','GP',$2) returning id`,
      [l.id, t.id],
    );
    await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id)
       values ('espn','racing/f1b/1',$1, now() + interval '1 day','GP', null)
       on conflict (provider, provider_key) do update set
         home_team_id = coalesce(excluded.home_team_id, events.home_team_id)`,
      [l.id],
    );
    const row = await one(`select home_team_id from events where id = $1`, [ev.id]);
    expect(row.home_team_id).toBe(t.id);
  });
});

/**
 * Which fixtures the play poller picks up.
 *
 * Scoped to live games alone, this lost the end of every match: the poll runs every
 * two minutes, the final score and the flip to `post` land on the one-minute score
 * tick, and the event stopped matching before the last drive was ever fetched. The
 * predicate below is the one in eventsNeedingPlays -- the guard at the bottom of
 * this block fails if the two drift apart.
 */
describe('play log selection', () => {
  const PREDICATE = `(
        (e.state = 'in'
          and e.updated_at > now() - interval '10 minutes'
          and (e.plays_synced_at is null
               or e.plays_synced_at < now() - ($1 * interval '1 second')))
        or
        (e.state = 'post'
          and e.starts_at > now() - ($4 * interval '1 hour')
          and not e.plays_final)
      )`;

  const DUE = `
    select e.id, e.plays_synced_at, (count(*) over ())::int as total_due
    from events e
    join leagues l on l.id = e.league_id
    where e.state = $3
      and l.plays_supported
      and ${PREDICATE}
    order by (case when e.state = 'post' then e.starts_at end) desc nulls last,
             e.plays_synced_at asc nulls first
    limit $2`;

  let league;
  beforeAll(async () => {
    league = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','football/nflp','football','football-nflp','NFL P') returning id`,
    );
  });

  /**
   * One fixture, positioned in time and in sync state exactly as described.
   *
   * updated_at defaults to a moment ago because that is what a genuinely live game
   * looks like: the score tick stamps it every minute.
   */
  const mk = async ({ key, state, startsHoursAgo, syncedSecondsAgo, updatedSecondsAgo = 30 }) =>
    (
      await one(
        `insert into events (provider, provider_key, league_id, starts_at, name, state,
                             plays_synced_at, updated_at)
         values ('espn',$1,$2, now() - ($3 * interval '1 hour'),'G',$4,
                 case when $5::int is null then null else now() - ($5 * interval '1 second') end,
                 now() - ($6 * interval '1 second'))
         returning id`,
        [key, league.id, startsHoursAgo, state, syncedSecondsAgo, updatedSecondsAgo],
      )
    ).id;

  const rows = async (limit = 100, state = 'in', hours = 12) =>
    (await db.query(DUE, [120, limit, state, hours])).rows;
  const due = async (limit = 100, state = 'in', hours = 12) =>
    (await rows(limit, state, hours)).map((r) => r.id);
  /** Both queues, as the worker sees them once it has drawn each separately. */
  const allDue = async () => [...(await due(100, 'in')), ...(await due(100, 'post'))];

  test('a live game is picked up once its log goes stale, and not before', async () => {
    const fresh = await mk({ key: 'a1', state: 'in', startsHoursAgo: 1, syncedSecondsAgo: 30 });
    const stale = await mk({ key: 'a2', state: 'in', startsHoursAgo: 1, syncedSecondsAgo: 300 });
    const never = await mk({ key: 'a3', state: 'in', startsHoursAgo: 1, syncedSecondsAgo: null });

    const ids = await due();
    expect(ids).not.toContain(fresh);
    expect(ids).toContain(stale);
    expect(ids).toContain(never);
  });

  test('a fixture the score tick has stopped touching is not live any more', async () => {
    // `state = 'in'` is not a claim that a game is on, only that nothing said
    // otherwise -- a fixture the provider stops returning keeps it for ever. Those
    // piled up and ate the whole cap, so genuinely live games waited behind a queue
    // of finished ones and never got a first read.
    const abandoned = await mk({
      key: 'a4',
      state: 'in',
      startsHoursAgo: 40,
      syncedSecondsAgo: null,
      updatedSecondsAgo: 7200,
    });
    expect(await due()).not.toContain(abandoned);
  });

  test('a long fixture still counts as live while the tick keeps stamping it', async () => {
    // Deliberately not a cutoff on start time: some sports legitimately run for
    // days, and the score tick is the honest signal for whether one is still on.
    const marathon = await mk({
      key: 'a5',
      state: 'in',
      startsHoursAgo: 72,
      syncedSecondsAgo: 300,
      updatedSecondsAgo: 30,
    });
    expect(await due()).toContain(marathon);
  });

  test('every row reports the full backlog, not just the capped slice', async () => {
    // 8 of 8 and 8 of 400 read identically otherwise, and the second means a live
    // fixture is hours away from its first play.
    const all = await rows(100);
    expect(all.length).toBeGreaterThan(2);

    const capped = await rows(2);
    expect(capped.length).toBe(2);
    expect(capped[0].total_due).toBe(all.length);
  });

  test('a game that just ended gets one more read, then stops matching', async () => {
    // The whistle went between polls, so the last drive is still owed.
    const ended = await mk({
      key: 'b1',
      state: 'post',
      startsHoursAgo: 3,
      syncedSecondsAgo: 300,
      updatedSecondsAgo: 60,
    });
    expect(await due(100, 'post')).toContain(ended);

    // markPlaysFinal closes it out for good.
    await db.query(`update events set plays_final = true, plays_synced_at = now() where id = $1`, [
      ended,
    ]);
    expect(await due(100, 'post')).not.toContain(ended);
  });

  test('the score tick cannot re-open a game that has been closed out', async () => {
    // This is the churn that made the catch-up queue grow instead of drain. The tick
    // writes updated_at for EVERY fixture on a league's scoreboard, finished ones
    // included, for as long as that league still has a game in progress -- so a
    // rule of "updated_at is newer than our last read" re-queued games that ended
    // hours ago, every single minute, at 500KB a pass through the metered proxy.
    const closed = await mk({
      key: 'b3',
      state: 'post',
      startsHoursAgo: 4,
      syncedSecondsAgo: 300,
      updatedSecondsAgo: 300,
    });
    await db.query(`update events set plays_final = true where id = $1`, [closed]);

    // The tick runs again for a league that still has another game on.
    await db.query(`update events set updated_at = now() where id = $1`, [closed]);
    expect(await due(100, 'post')).not.toContain(closed);
  });

  test('a fixture never closed out is still owed its read, however old the stamp', async () => {
    // Every fixture already stored predates the flag, so the default must mean
    // "still owed" rather than "already done".
    const owed = await mk({
      key: 'b4',
      state: 'post',
      startsHoursAgo: 5,
      syncedSecondsAgo: 30,
      updatedSecondsAgo: 3600,
    });
    expect(await due(100, 'post')).toContain(owed);
  });

  test('a game finished long ago is not re-read', async () => {
    // Without the window, a backfill that restates old fixtures would pull a whole
    // season of 500KB summaries through a metered proxy.
    const old = await mk({
      key: 'b2',
      state: 'post',
      startsHoursAgo: 30,
      syncedSecondsAgo: null,
      updatedSecondsAgo: 60,
    });
    expect(await due(100, 'post')).not.toContain(old);

    // The window bounds cost, it is not a claim the game has no recap -- so widening
    // it reaches back and picks the same fixture up. That is the backfill lever.
    expect(await due(100, 'post', 168)).toContain(old);
  });

  test('a fixture that has not started is never fetched', async () => {
    const upcoming = await mk({
      key: 'c1',
      state: 'pre',
      startsHoursAgo: -2,
      syncedSecondsAgo: null,
    });
    expect(await allDue()).not.toContain(upcoming);
  });

  test('the game that just finished is first in line for its recap', async () => {
    // Ordered by last-read, a game going final sorted behind every straggler still
    // owed a catch-up -- about five hours behind, at two reads a tick -- which is
    // exactly backwards: it is the one somebody has open waiting for the recap.
    const old = await mk({
      key: 'e1',
      state: 'post',
      startsHoursAgo: 9,
      syncedSecondsAgo: 9000,
      updatedSecondsAgo: 600,
    });
    const justEnded = await mk({
      key: 'e2',
      state: 'post',
      startsHoursAgo: 2,
      syncedSecondsAgo: 30,
      updatedSecondsAgo: 30,
    });

    const queue = await due(100, 'post');
    expect(queue.indexOf(justEnded)).toBeLessThan(queue.indexOf(old));
    // And with only one slot free it is the one that gets read.
    expect(await due(1, 'post')).toEqual([justEnded]);
  });

  test('live games still take turns, oldest read first', async () => {
    // The post ordering must not disturb this: the case is null for every live row,
    // so the live queue falls through to the second key unchanged.
    const queue = await rows(100, 'in');
    expect(queue.length).toBeGreaterThan(1);

    // Never-read first, then non-decreasing. Stated as an invariant rather than an
    // exact sequence, because equal stamps may legitimately come back either way.
    const stamps = queue.map((r) => r.plays_synced_at);
    const firstStamped = stamps.findIndex((s) => s !== null);
    expect(stamps.slice(0, firstStamped).every((s) => s === null)).toBe(true);
    for (let i = firstStamped + 1; i < stamps.length; i++) {
      expect(+new Date(stamps[i])).toBeGreaterThanOrEqual(+new Date(stamps[i - 1]));
    }
  });

  test('the two queues can be drawn separately, so neither can shut the other out', async () => {
    // Pooled, the games that ended in the last twelve hours win on age alone: 252 of
    // them held every slot for an hour while the fixtures being played got nothing.
    await mk({
      key: 'd1',
      state: 'post',
      startsHoursAgo: 2,
      syncedSecondsAgo: 600,
      updatedSecondsAgo: 60,
    });

    const liveOnly = await rows(100, 'in');
    const endedOnly = await rows(100, 'post');
    expect(liveOnly.length).toBeGreaterThan(0);
    expect(endedOnly.length).toBeGreaterThan(0);

    // Each queue counts only its own backlog, which is what the worker logs.
    expect(liveOnly[0].total_due).toBe(liveOnly.length);
    expect(endedOnly[0].total_due).toBe(endedOnly.length);

    // And together they are exactly the unfiltered set, nothing dropped or doubled.
    const both = [...liveOnly, ...endedOnly].map((r) => r.id).sort();
    expect(both).toEqual((await allDue()).sort());
  });

  test('a sport with no play data never takes a slot', async () => {
    // Ten of the sixteen sports either return a boxscore and nothing else or have no
    // summary for the kind of id we store. Their fixtures were being read every
    // cycle to come back empty, ahead of leagues that do have a log.
    const dry = await one(
      `insert into leagues (provider, provider_key, sport, slug, name, plays_supported)
       values ('espn','rugby/1','rugby','rugby-1','Rugby', false) returning id`,
    );
    const ev = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name, state, updated_at)
       values ('espn','rugby/1/1',$1, now() - interval '1 hour','R','in', now())
       returning id`,
      [dry.id],
    );
    expect(await due(100, 'in')).not.toContain(ev.id);

    // Opting one back in is a single UPDATE, with no deploy and no code change.
    await db.query(`update leagues set plays_supported = true where id = $1`, [dry.id]);
    expect(await due(100, 'in')).toContain(ev.id);
  });

  test('a competition we have never seen is tried, not written off', async () => {
    // Leagues added later must be opted in by default: failing open costs one empty
    // read, failing closed hides a whole sport silently.
    const fresh = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','handball/1','handball','handball-1','Handball') returning id`,
    );
    const row = await one(`select plays_supported from leagues where id = $1`, [fresh.id]);
    expect(row.plays_supported).toBe(true);
  });

  test('the sports that do have play logs are opted in', async () => {
    // Measured against the live provider on 2026-08-21. If one of these is ever
    // switched off, a whole sport loses its action log with nothing in the logs.
    const { rows } = await db.query(
      `select sport, bool_and(plays_supported) as on from leagues
       where sport = any($1::text[]) group by sport`,
      [['baseball', 'basketball', 'football', 'soccer', 'hockey', 'australian-football']],
    );
    for (const r of rows)
      expect({ sport: r.sport, on: r.on }).toEqual({ sport: r.sport, on: true });
  });

  test('the predicate under test is still the one the query uses', async () => {
    const src = await Bun.file(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    ).text();
    const normalise = (s) =>
      s
        .replace(/\$\d+|\$\{[^}]+\}/g, '?')
        .replace(/\s+/g, ' ')
        .trim();
    expect(normalise(src)).toContain(normalise(PREDICATE));
    // Drawn one state at a time, so neither queue can shut the other out.
    expect(normalise(src)).toContain('where e.state = ?');
    // And the backlog count really is taken before the limit applies.
    expect(normalise(src)).toContain('(count(*) over ())::int as total_due');
  });
});
