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

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

describe('migrations', () => {
  test('every table the app queries exists', async () => {
    const names = (
      await rows(`select table_name from information_schema.tables where table_schema='public'`)
    ).map((r) => r.table_name);

    for (const t of [
      'users',
      'login_tokens',
      'sessions',
      'passkeys',
      'genres',
      'subjects',
      'subject_genres',
      'events',
      'event_genres',
      'follows',
      'reminder_prefs',
      'push_subscriptions',
      'reminder_deliveries',
      'comments',
      'user_playlists',
      'user_playlist_channels',
    ]) {
      expect(names).toContain(t);
    }
  });

  test('nothing from the sports model survived the port', async () => {
    const names = (
      await rows(`select table_name from information_schema.tables where table_schema='public'`)
    ).map((r) => r.table_name);
    /*
     * `entitlements` left this list when the payment rail was ported, and
     * `stream_offers` did not.
     *
     * That split is the whole point of how CoinPay came across. Taking money and
     * recording who may access what is general, and the shared payments package
     * writes both tables identically in either brand. Reselling stream slots
     * somebody else holds is not general -- nothing has ever INSERTed into
     * stream_offers even on the brand that has it -- so it stayed behind.
     */
    for (const gone of ['leagues', 'teams', 'stream_offers', 'plays']) {
      expect(names).not.toContain(gone);
    }
    for (const ported of ['payments', 'entitlements']) {
      expect(names).toContain(ported);
    }
  });

  /**
   * There WAS a rule here that no password column may exist anywhere, and it held
   * until a television needed to sign in -- a device with no mail client to open a
   * link in and no authenticator to hold a passkey, where "use another device" is
   * not an answer because the TV is the device.
   *
   * The rule it is replaced by keeps what the original was protecting. A password
   * is optional, never issued, and never required: an account has one only if
   * somebody deliberately set one from inside a session. So the check is no longer
   * "does this column exist" but "can an account still exist without it", which is
   * the property that actually mattered.
   */
  test('the only password columns are the optional ones, and they are opt-in', async () => {
    const cols = await rows(
      `select table_name, column_name, is_nullable, column_default
         from information_schema.columns
        where table_schema='public' and column_name ilike '%password%'
        order by table_name, column_name`,
    );

    expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'users.password_hash',
      'users.password_set_at',
    ]);

    for (const c of cols) {
      // Nullable and undefaulted: a new account has no password and needs none.
      expect({ col: c.column_name, nullable: c.is_nullable, def: c.column_default }).toEqual({
        col: c.column_name,
        nullable: 'YES',
        def: null,
      });
    }
  });

  test('a new account is created without a password', async () => {
    // The invariant the old rule was really defending: signing up never produces a
    // credential nobody chose.
    const u = await one(
      `insert into users (email) values ('fresh@example.test')
       returning password_hash, password_set_at`,
    );
    expect(u.password_hash).toBeNull();
    expect(u.password_set_at).toBeNull();
  });
});

/** A minimal catalogue: one genre, one subject in it, one event of that subject. */
async function seed({ timeKnown = true, precision = 'minute', startsAt = null } = {}) {
  const at = startsAt ?? new Date(Date.now() + 60 * 60_000);
  const g = await one(
    `insert into genres (category, provider, provider_key, slug, name)
     values ('tv','t',$1,$1,'Drama') returning id`,
    [`g${Math.random()}`],
  );
  const s = await one(
    `insert into subjects (category, kind, provider, provider_key, slug, name, display_name)
     values ('tv','show','t',$1,$1,'Show','Show') returning id`,
    [`s${Math.random()}`],
  );
  await db.query(`insert into subject_genres (subject_id, genre_id) values ($1,$2)`, [s.id, g.id]);
  const e = await one(
    `insert into events (provider, provider_key, category, subject_id, kind, starts_at,
                         time_known, precision, name)
     values ('t',$1,'tv',$2,'episode',$3,$4,$5,'Show 1x01') returning id`,
    [`e${Math.random()}`, s.id, at, timeKnown, precision],
  );
  await db.query(`insert into event_genres (event_id, genre_id) values ($1,$2)`, [e.id, g.id]);
  return { genreId: g.id, subjectId: s.id, eventId: e.id };
}

const mkUser = async () =>
  (await one(`insert into users (email) values ($1) returning id`, [`u${Math.random()}@e.com`])).id;

/** Mirrors followersOfEventPage. */
const followers = (eventId) =>
  rows(
    `select distinct f.user_id
     from events e
     join follows f
       on (f.subject_type = 'subject' and f.subject_id = e.subject_id)
       or (f.subject_type = 'genre'
           and f.subject_id in (select genre_id from event_genres where event_id = e.id))
     where e.id = $1
     order by f.user_id`,
    [eventId],
  );

describe('reminder fan-out', () => {
  test('reaches people who follow the genre as well as the name', async () => {
    const { genreId, subjectId, eventId } = await seed();
    const byGenre = await mkUser();
    const bySubject = await mkUser();
    const unrelated = await mkUser();

    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'genre',$2)`,
      [byGenre, genreId],
    );
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'subject',$2)`,
      [bySubject, subjectId],
    );

    const ids = (await followers(eventId)).map((r) => r.user_id);
    expect(ids).toContain(byGenre);
    expect(ids).toContain(bySubject);
    expect(ids).not.toContain(unrelated);
  });

  // Following both a genre and a name inside it is the normal case for anyone who
  // actually uses the site, and it must not buzz their phone twice.
  test('following both tiers yields one recipient, not two', async () => {
    const { genreId, subjectId, eventId } = await seed();
    const u = await mkUser();
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'genre',$2)`,
      [u, genreId],
    );
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'subject',$2)`,
      [u, subjectId],
    );

    expect((await followers(eventId)).length).toBe(1);
  });

  // The primary key IS the idempotency guard, and a failed row must be re-claimable
  // or a transient push error loses the reminder for good.
  test('a claim is once-only, but a failure can be retried', async () => {
    const { eventId } = await seed();
    const u = await mkUser();
    const claim = `insert into reminder_deliveries (event_id, user_id, offset_minutes, channel)
       values ($1,$2,60,'email')
       on conflict (event_id, user_id, offset_minutes, channel) do update
         set status='sent', sent_at=now()
         where reminder_deliveries.status='failed'
       returning event_id`;

    expect((await rows(claim, [eventId, u])).length).toBe(1);
    expect((await rows(claim, [eventId, u])).length).toBe(0);

    await db.query(
      `update reminder_deliveries set status='failed' where event_id=$1 and user_id=$2`,
      [eventId, u],
    );
    expect((await rows(claim, [eventId, u])).length).toBe(1);
  });
});

/** Mirrors eventsDueForReminder. */
const due = (offsetMinutes, timed) =>
  rows(
    `select e.id from events e
     where e.state = 'upcoming'
       and e.time_known = $2
       and e.precision in ('second','minute','hour','day')
       and e.starts_at - ($1 * interval '1 minute') <= now()
       and e.starts_at - ($1 * interval '1 minute') > now() - (300 * interval '1 second')`,
    [offsetMinutes, timed],
  );

describe('the two reminder classes', () => {
  /*
   * The single most important new invariant on this site.
   *
   * A dated release is stored at noon UTC because it needs SOME instant to be
   * ordered by. Without the time_known filter the 60-minute scan would match it
   * at 11:00 UTC and tell someone their album "starts in an hour" -- an hour
   * nobody announced, on a clock that does not exist for that row.
   */
  test('a timed scan never matches a date-only event', async () => {
    const at = new Date(Date.now() + 60 * 60_000);
    const { eventId } = await seed({ timeKnown: false, precision: 'day', startsAt: at });

    expect((await due(60, true)).map((r) => r.id)).not.toContain(eventId);
    expect((await due(60, false)).map((r) => r.id)).toContain(eventId);
  });

  test('a dated scan never matches a timed event', async () => {
    const at = new Date(Date.now() + 60 * 60_000);
    const { eventId } = await seed({ timeKnown: true, precision: 'minute', startsAt: at });

    expect((await due(60, false)).map((r) => r.id)).not.toContain(eventId);
    expect((await due(60, true)).map((r) => r.id)).toContain(eventId);
  });

  // "Sometime in 2026" is browsable and must never fire an alarm: the stored
  // instant is a representative day, not a claim about when it happens.
  test('a month- or year-precision event is never remindable', async () => {
    const at = new Date(Date.now() + 60 * 60_000);
    const year = await seed({ timeKnown: false, precision: 'year', startsAt: at });
    const month = await seed({ timeKnown: false, precision: 'month', startsAt: at });

    const ids = (await due(60, false)).map((r) => r.id);
    expect(ids).not.toContain(year.eventId);
    expect(ids).not.toContain(month.eventId);
  });
});

describe('catalogue integrity', () => {
  // A show is Drama AND Sci-Fi AND Thriller; losing that is losing the product.
  test('a subject can be filed under several genres', async () => {
    const { subjectId } = await seed();
    const g2 = await one(
      `insert into genres (category, provider, provider_key, slug, name)
       values ('tv','t',$1,$1,'Sci-Fi') returning id`,
      [`g${Math.random()}`],
    );
    await db.query(`insert into subject_genres (subject_id, genre_id) values ($1,$2)`, [
      subjectId,
      g2.id,
    ]);
    const n = await one(`select count(*)::int as n from subject_genres where subject_id=$1`, [
      subjectId,
    ]);
    expect(n.n).toBe(2);
  });

  test('deleting a subject takes its events with it', async () => {
    const { subjectId, eventId } = await seed();
    await db.query(`delete from subjects where id=$1`, [subjectId]);
    expect(await one(`select id from events where id=$1`, [eventId])).toBeUndefined();
  });
});

describe('a repeated row inside one batch', () => {
  /*
   * Postgres rejects an INSERT ... ON CONFLICT DO UPDATE whose own batch names the
   * same conflict target twice, and it fails the WHOLE statement. TMDB's discover
   * endpoint is ordered by popularity and paginated, popularity shifts between
   * requests, and a film near a page boundary comes back on two consecutive pages
   * -- which took the film category to zero events on the first production sync.
   */
  test('is what Postgres actually refuses, so the dedupe is load-bearing', async () => {
    const { subjectId } = await seed();
    const dup = [
      {
        provider: 't',
        provider_key: 'dup-1',
        category: 'tv',
        subject_id: subjectId,
        kind: 'release',
        starts_at: new Date(),
        name: 'A',
      },
      {
        provider: 't',
        provider_key: 'dup-1',
        category: 'tv',
        subject_id: subjectId,
        kind: 'release',
        starts_at: new Date(),
        name: 'B',
      },
    ];
    const stmt = `insert into events (provider, provider_key, category, subject_id, kind, starts_at, name)
       values ($1,$2,$3,$4,$5,$6,$7), ($8,$9,$10,$11,$12,$13,$14)
       on conflict (provider, provider_key) do update set name = excluded.name`;
    const params = dup.flatMap((d) => [
      d.provider,
      d.provider_key,
      d.category,
      d.subject_id,
      d.kind,
      d.starts_at,
      d.name,
    ]);

    let threw = null;
    try {
      await db.query(stmt, params);
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/cannot affect row a second time/i);
  });

  // And the fix, applied the way the query layer applies it: last occurrence wins.
  test('dedupes on the adapter shape, keeping the last occurrence', async () => {
    const rows = [
      { providerKey: 'a', name: 'first' },
      { providerKey: 'b', name: 'other' },
      { providerKey: 'a', name: 'second' },
    ];
    const unique = new Map();
    for (const row of rows) unique.set(row.providerKey ?? row.provider_key, row);
    const deduped = [...unique.values()];

    expect(deduped.length).toBe(2);
    expect(deduped.find((r) => r.providerKey === 'a').name).toBe('second');
    // Reading the snake_case key would be undefined on every row and collapse the
    // whole batch to one entry -- silently, and only in production.
    const wrong = new Map();
    for (const row of rows) wrong.set(row.provider_key, row);
    expect(wrong.size).toBe(1);
  });
});
