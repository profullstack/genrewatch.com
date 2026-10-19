import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * A film is three dates, and a follower is told about each one.
 *
 * The complaint (genrewatch.com/subjects/you-can-see-everything-1765072): the page
 * showed a cinema date and nothing else, and following it promised nothing about
 * the date that mattered -- when it can be watched at home. TMDB had not dated it
 * yet, which is the normal state for a film a week after it opens, so the page
 * has to say "not announced yet" and the follower has to hear the moment it is.
 */

// The page and notify modules read config on import; nothing here connects.
process.env.DATABASE_URL ??= 'postgres://test@localhost:1/test';

const read = (p) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8');
const fnBody = (src, name) => {
  const fn = src.slice(src.indexOf(`export async function ${name}(`));
  return fn.slice(0, fn.indexOf('\n}\n'));
};

describe('the subject page names all three windows', () => {
  let pages;
  beforeAll(async () => {
    pages = await import(`../apps/web/src/views/pages.jsx?t=${Date.now()}`);
  });

  const cinemaOnly = [
    { provider_key: 'tmdb:release:1765072', starts_at: '2026-10-16T12:00:00Z', venue: 'Cinemas' },
  ];

  test('an undated window says so instead of vanishing', async () => {
    const html = String(
      await pages.ReleaseWindows({ windows: cinemaOnly, following: false, signedIn: true }),
    );
    expect(html).toContain('In cinemas');
    expect(html).toContain('Fri, Oct 16');
    expect(html.match(/Not announced yet/g)?.length).toBe(2);
    expect(html).toContain('Follow to be told as soon as each date is announced');
  });

  test('a follower is told what following does', async () => {
    const html = String(
      await pages.ReleaseWindows({ windows: cinemaOnly, following: true, signedIn: true }),
    );
    expect(html).toContain('re following this');
  });

  test('every service a film streams on is listed', () => {
    const slots = pages.releaseSlots([
      ...cinemaOnly,
      { provider_key: 'tmdb:digital:1', starts_at: '2026-11-03T12:00:00Z', venue: 'Rent or buy' },
      {
        provider_key: 'tmdb:stream:1:netflix',
        starts_at: '2026-12-01T12:00:00Z',
        venue: 'Netflix',
      },
      { provider_key: 'tmdb:stream:1:hulu', starts_at: '2026-12-08T12:00:00Z', venue: 'Hulu' },
    ]);
    expect(slots.cinemas.venue).toBe('Cinemas');
    expect(slots.rent.venue).toBe('Rent or buy');
    expect(slots.stream.map((w) => w.venue)).toEqual(['Netflix', 'Hulu']);
  });

  test('a title with no film windows draws nothing', async () => {
    expect(await pages.ReleaseWindows({ windows: [], following: false, signedIn: false })).toBe(
      null,
    );
  });

  test('the route only asks for windows on a film', () => {
    expect(read('../apps/web/src/app.js')).toContain(
      "subject.category === 'film' ? q.releaseWindowsForSubject(subject.id) : []",
    );
  });
});

describe('what the notification says', () => {
  let notify;
  beforeAll(async () => {
    notify = await import('../packages/notify/src/index.js');
  });

  const film = (key, venue, startsAt = '2026-12-01T12:00:00Z') => ({
    id: 1,
    name: 'You Can See Everything',
    provider_key: key,
    venue,
    starts_at: startsAt,
    time_known: false,
  });

  test('an announcement names the window and the day', () => {
    const m = notify.messageFor(film('tmdb:stream:1:netflix', 'Netflix'), -1);
    expect(m.title).toBe('You Can See Everything');
    expect(m.body).toBe('On Netflix from Tue, Dec 1');
    expect(m.subject).toBe('You Can See Everything: on Netflix from Tue, Dec 1');
  });

  test('a window dated after it opened is "now", not a date in the past', () => {
    const m = notify.messageFor(film('tmdb:digital:1', 'Rent or buy', '2026-01-01T12:00:00Z'), -1);
    expect(m.body).toBe('To rent or buy now');
  });

  test('a date-only reminder says tomorrow and today, never "in 0 minutes"', () => {
    expect(notify.messageFor(film('tmdb:release:1', 'Cinemas'), 1440).body).toBe(
      'In cinemas tomorrow',
    );
    expect(notify.messageFor(film('tmdb:stream:1:hulu', 'Hulu'), 0).body).toBe('On Hulu today');
  });

  test('no clone-era sports field leaks into the copy', () => {
    for (const offset of [-1, 0, 1440, 60]) {
      const m = notify.messageFor({ ...film('x', null), time_known: offset === 60 }, offset);
      expect(`${m.title} ${m.body} ${m.subject}`).not.toContain('undefined');
    }
    expect(read('../packages/notify/src/index.js')).not.toContain('event.league_name');
  });
});

describe('announcing a newly dated window', () => {
  let db;
  let subjectId;
  let userId;

  const insertEvent = (key, daysFromNow) =>
    db.query(
      `insert into events (provider, provider_key, category, subject_id, kind, starts_at,
                           time_known, precision, state, name)
       values ('tmdb', $1, 'film', $2, 'release', now() + ($3 * interval '1 day'),
               false, 'day', 'upcoming', 'You Can See Everything')
       returning id`,
      [key, subjectId, daysFromNow],
    );

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const at = files.indexOf('0022_release_announcements.sql');
    for (const f of files.slice(0, at)) await db.exec(await readFile(dir + f, 'utf8'));

    const [s] = (
      await db.query(
        `insert into subjects (category, kind, provider, provider_key, slug, name, display_name,
                               search_text)
         values ('film','film','tmdb','tmdb:movie:1765072','ycse','You Can See Everything',
                 'You Can See Everything','ycse') returning id`,
      )
    ).rows;
    subjectId = s.id;
    // A cinema date that existed before this shipped.
    await insertEvent('tmdb:release:1765072', -3);

    for (const f of files.slice(at)) await db.exec(await readFile(dir + f, 'utf8'));

    const [u] = (await db.query(`insert into users (email) values ('a@example.com') returning id`))
      .rows;
    userId = u.id;
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1, 'subject', $2)`,
      [userId, subjectId],
    );
  });

  const toAnnounce = async () => {
    const sql = fnBody(read('../packages/db/src/queries.js'), 'eventsToAnnounce');
    const query = sql
      .slice(sql.indexOf('sql`') + 4, sql.lastIndexOf('`'))
      .replace('${limit}', '500');
    return (await db.query(query)).rows;
  };

  test('rows that existed before the deploy are not announced again', async () => {
    expect(await toAnnounce()).toEqual([]);
  });

  test('a streaming date dated later is picked up, for a follower', async () => {
    await insertEvent('tmdb:stream:1765072:netflix', 30);
    const rows = await toAnnounce();
    expect(rows.map((r) => r.provider_key)).toEqual(['tmdb:stream:1765072:netflix']);
    expect(rows[0].followed).toBe(true);
    expect(rows[0].recent).toBe(true);
  });

  test('an announcement and the reminders do not collide in the delivery table', async () => {
    const [{ id }] = (
      await db.query(`select id from events where provider_key like 'tmdb:stream:%'`)
    ).rows;
    for (const offset of [-1, 1440, 0]) {
      await db.query(
        `insert into reminder_deliveries (event_id, user_id, offset_minutes, channel)
         values ($1, $2, $3, 'email')`,
        [id, userId, offset],
      );
    }
    const n = (await db.query(`select count(*)::int as n from reminder_deliveries`)).rows[0].n;
    expect(n).toBe(3);
  });

  test('the scan stamps every candidate, followed or not', () => {
    const workers = read('../packages/queue/src/workers.js');
    const fn = workers.slice(workers.indexOf('async function runAnnounce('));
    expect(fn).toContain('q.markAnnounced(rows.map((e) => e.id))');
    expect(fn).toContain('jobId: `fo-${e.id}-announce`');
  });

  test('genre followers are not buzzed by every horror film getting a date', () => {
    const body = fnBody(read('../packages/db/src/queries.js'), 'subjectFollowersOfEventPage');
    expect(body).not.toContain('genre');
  });
});

describe('a followed film is re-asked first', () => {
  test('followed rows lead and use the shorter cycle', () => {
    const body = fnBody(read('../packages/db/src/queries.js'), 'eventsNeedingDigitalCheck');
    expect(body).toContain('fw.followed desc');
    expect(body).toContain('followedStaleDays');
  });
});
