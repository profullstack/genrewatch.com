import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * Giving the IMDb rows something to show.
 *
 * The backfill is what makes this catalogue large and what makes a third of the
 * forward calendar unreadable: title.basics has a name, a type and a year, and no
 * poster, synopsis or finer date. Measured in production, all 1,204 upcoming IMDb
 * events were missing image, summary and trailer alike -- a page that says "Star
 * Wars: New Jedi Order, 2027" and nothing else.
 *
 * The tconsts below are real, and so are the response shapes: they were checked
 * against the live /find endpoint, where six of eight upcoming titles matched.
 */

const QUERIES = readFileSync(
  new URL('../packages/db/src/queries.js', import.meta.url).pathname,
  'utf8',
);
const CATALOG = readFileSync(
  new URL('../packages/catalog/src/index.js', import.meta.url).pathname,
  'utf8',
);
const TMDB = readFileSync(
  new URL('../packages/catalog/src/tmdb.js', import.meta.url).pathname,
  'utf8',
);

describe('how the two catalogues are joined', () => {
  /*
   * The property that makes this safe to run unattended.
   *
   * There are a dozen films called Rebirth and no way to tell from a name and a
   * year which one a stranger meant, so a fuzzy match would eventually put a
   * confidently wrong poster on a film -- worse than a blank one. Both sites
   * index the tconst, so the question asked is "what is tt10300398".
   */
  test('on the IMDb id, never on the title', () => {
    const fn = TMDB.slice(TMDB.indexOf('export async function fetchByImdbIds('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('external_source=imdb_id');
    expect(body).not.toContain('/search/movie');
    expect(body).not.toContain('query=');
  });

  /* A quarter of these ids are in neither site's good graces. Without recording
     the attempt, every pass re-asks the same unmatched titles and never advances. */
  test('a miss is recorded as a result, not skipped', () => {
    const fn = TMDB.slice(TMDB.indexOf('export async function fetchByImdbIds('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('matched: false');
  });

  test('television counts too, since the dumps carry both', () => {
    const fn = TMDB.slice(TMDB.indexOf('export async function fetchByImdbIds('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('tv_results');
  });

  /* Only a full date. A partial one would be anchored as if it were exact. */
  test('a date is taken only when it is a whole one', () => {
    const fn = TMDB.slice(TMDB.indexOf('export async function fetchByImdbIds('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('^\\d{4}-\\d{2}-\\d{2}$');
  });
});

describe('where the budget goes', () => {
  /*
   * 314,000 subjects, about a thousand of which somebody is waiting for. A reader
   * meets this gap on the calendar, so the pass is restricted to titles with an
   * upcoming event rather than spread evenly over a third of a million rows.
   */
  test('the forward calendar first, not the whole catalogue', () => {
    const fn = QUERIES.slice(QUERIES.indexOf('export async function imdbSubjectsNeedingMeta('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("e.state = 'upcoming'");
    expect(body).toContain('order by soonest');
  });

  test('and never a title already illustrated', () => {
    const fn = QUERIES.slice(QUERIES.indexOf('export async function imdbSubjectsNeedingMeta('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('s.image_url is null');
  });

  test('the pass is scheduled, or it would never run', () => {
    const queue = readFileSync(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    const workers = readFileSync(
      new URL('../packages/queue/src/workers.js', import.meta.url).pathname,
      'utf8',
    );
    expect(queue).toContain("{ kind: 'imdb-meta' }");
    expect(workers).toContain("job.data?.kind === 'imdb-meta'");
  });

  test('a miss still stamps the title', () => {
    const fn = QUERIES.slice(QUERIES.indexOf('export async function saveImdbMeta('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // The else branch: nothing found, but the question is marked as asked.
    expect(body).toContain('meta_checked_at = now() where id =');
  });

  test('the pass reports what it found and what it did not', () => {
    const fn = CATALOG.slice(CATALOG.indexOf('export async function syncImdbMeta('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('not in TMDB');
  });
});

/* -------------------------------------------------------------------- sql -- */

describe('what a lookup writes', () => {
  let db;
  let subjectId;
  let eventId;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }

    const [s] = (
      await db.query(
        `insert into subjects (category, kind, provider, provider_key, slug, name, display_name,
                               search_text)
         values ('film','film','imdb','tt10300398','swnjo-tt10300398',
                 'Star Wars: New Jedi Order','Star Wars: New Jedi Order','star wars')
         returning id`,
      )
    ).rows;
    subjectId = s.id;

    // Exactly how the IMDb pass stores one: year precision, 1 January, no art.
    const [e] = (
      await db.query(
        `insert into events (provider, provider_key, category, subject_id, kind, starts_at,
                             time_known, precision, state, name)
         values ('imdb','imdb:release:tt10300398','film',$1,'release','2027-01-01T12:00:00Z',
                 false,'year','upcoming','Star Wars: New Jedi Order')
         returning id`,
        [subjectId],
      )
    ).rows;
    eventId = e.id;
  });

  const apply = async ({ image, summary, date }) => {
    await db.query(
      `update subjects set image_url = coalesce($2, image_url),
                           description = coalesce($3, description),
                           meta_checked_at = now()
       where id = $1`,
      [subjectId, image, summary],
    );
    await db.query(
      `update events set image_url = coalesce($2, image_url),
                         summary = coalesce($3, summary)
       where subject_id = $1`,
      [subjectId, image, summary],
    );
    if (date) {
      await db.query(
        `update events set starts_at = $2, precision = 'day'
         where subject_id = $1 and precision = 'year' and time_known = false`,
        [subjectId, date],
      );
    }
  };

  test('the title starts with nothing, which is the bug', async () => {
    const [row] = (
      await db.query(`select image_url, description from subjects where id = $1`, [subjectId])
    ).rows;
    expect(row.image_url).toBeNull();
    expect(row.description).toBeNull();
  });

  /*
   * Both surfaces, and this is the half-fix worth a test. A subject page renders
   * the subject's artwork and a calendar row renders the event's, so filling one
   * leaves the film illustrated on its own page and blank in every list that
   * mentions it -- which looks like a bug rather than like missing data.
   */
  test('artwork reaches the title AND the rows that list it', async () => {
    await apply({
      image: 'https://image.tmdb.org/t/p/w342/poster.jpg',
      summary: 'A new order.',
      date: null,
    });
    const [s] = (await db.query(`select image_url from subjects where id = $1`, [subjectId])).rows;
    const [e] = (await db.query(`select image_url, summary from events where id = $1`, [eventId]))
      .rows;
    expect(s.image_url).toContain('poster.jpg');
    expect(e.image_url).toContain('poster.jpg');
    expect(e.summary).toBe('A new order.');
  });

  /*
   * The most valuable field and the least obvious one. A year-precision row is
   * anchored to 1 January because a year is all it had, so the calendar shows
   * every 2027 film arriving together on New Year's Day.
   */
  test('a year becomes a day when TMDB knows one', async () => {
    await apply({ image: null, summary: null, date: '2027-12-03T12:00:00Z' });
    const [e] = (await db.query(`select starts_at, precision from events where id = $1`, [eventId]))
      .rows;
    expect(e.precision).toBe('day');
    expect(new Date(e.starts_at).toISOString().slice(0, 10)).toBe('2027-12-03');
  });

  /* A date another provider established is never overwritten by this pass -- the
     same rule the IMDb backfill itself follows. */
  test('but a date already known to the day is left alone', async () => {
    const [other] = (
      await db.query(
        `insert into events (provider, provider_key, category, subject_id, kind, starts_at,
                             time_known, precision, state, name)
         values ('tmdb','tmdb:release:9','film',$1,'release','2027-05-05T12:00:00Z',
                 false,'day','upcoming','Star Wars: New Jedi Order')
         returning id`,
        [subjectId],
      )
    ).rows;

    await db.query(
      `update events set starts_at = $2, precision = 'day'
       where subject_id = $1 and precision = 'year' and time_known = false`,
      [subjectId, '2027-09-09T12:00:00Z'],
    );

    const [row] = (await db.query(`select starts_at from events where id = $1`, [other.id])).rows;
    expect(new Date(row.starts_at).toISOString().slice(0, 10)).toBe('2027-05-05');
  });

  test('a title that was asked about is not asked again', async () => {
    const rows = (
      await db.query(
        `select s.id from subjects s
         join events e on e.subject_id = s.id and e.state = 'upcoming'
         where s.provider = 'imdb' and s.meta_checked_at is null and s.image_url is null`,
      )
    ).rows;
    expect(rows).toHaveLength(0);
  });
});
