import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * What is out in the next few hours, on the genre index.
 *
 * Ported from tipoffwatch's "Starting soon". The interesting difference is
 * time_known, and it is not a precaution here the way it is there: TMDB and
 * MusicBrainz rows are ALWAYS date-only, padded to noon UTC. Without the filter
 * this list would be mostly albums with a month and films with a year, counting
 * down to an hour nobody announced.
 */

let db;

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
       values ('tv','show','tvmaze','k','sev','Severance','Severance','severance')
       returning id`,
    )
  ).rows;

  const ev = async (key, hours, timeKnown, precision, state = 'upcoming') =>
    db.query(
      `insert into events (provider, provider_key, category, subject_id, kind, starts_at,
                           time_known, precision, state, name)
       values ('tvmaze', $1, 'tv', $2, 'episode', now() + ($3 * interval '1 hour'),
               $4, $5, $6, $1)`,
      [key, s.id, hours, timeKnown, precision, state],
    );

  await ev('timed-soon', 2, true, 'minute');
  await ev('timed-later', 9, true, 'minute');
  await ev('dated-soon', 3, false, 'day');
  await ev('year-soon', 1, false, 'year');
  await ev('already-out', 2, true, 'minute', 'out');
});

const soon = async (hours = 4) =>
  (
    await db.query(
      `select name from events
       where state = 'upcoming' and time_known
         and starts_at > now() and starts_at <= now() + ($1 * interval '1 hour')
       order by starts_at`,
      [hours],
    )
  ).rows.map((r) => r.name);

describe('what qualifies', () => {
  test('an episode with a real air time inside the window', async () => {
    expect(await soon()).toContain('timed-soon');
  });

  test('and not one outside it', async () => {
    expect(await soon()).not.toContain('timed-later');
  });

  /*
   * The whole reason this filter is load-bearing on this site rather than a
   * precaution. A release with only a date is stored at noon UTC; putting it in a
   * countdown asserts an hour nobody announced.
   */
  test('never a release that carries only a date', async () => {
    const out = await soon();
    expect(out).not.toContain('dated-soon');
    expect(out).not.toContain('year-soon');
  });

  test('and never something already out', async () => {
    expect(await soon()).not.toContain('already-out');
  });

  test('widening the window reaches further', async () => {
    expect(await soon(12)).toContain('timed-later');
  });
});

describe('how the page says it', () => {
  const pages = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );
  const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
  const queries = readFileSync(
    new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    'utf8',
  );

  test('the query filters on time_known, not just on state', () => {
    const fn = queries.slice(queries.indexOf('export async function outSoon('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('e.time_known');
  });

  /* A short list here is a fact about what is announced, not about the site. */
  test('the page says why a date-only release is missing', () => {
    expect(pages).toContain('they have no hour to count down to');
  });

  /*
   * The cache had to come down with the list. Genres change about never, so five
   * minutes was free; a four-hour window moves by a minute in a minute, and its
   * tail is the part anybody is reading.
   */
  test('the genre page cache is short enough for the window to be true', () => {
    const route = app.slice(app.indexOf("app.get('/genres'"));
    expect(route.slice(0, route.indexOf('\n});'))).toContain("cached(c, 'page:genres', 60");
  });

  /* Nothing here is happening yet; the sibling brand's red live dot would be a
     small lie repeated on every row. */
  test('the count is not dressed as a live marker', () => {
    const css = readFileSync(
      new URL('../apps/web/public/styles.css', import.meta.url).pathname,
      'utf8',
    );
    const block = css.slice(css.indexOf('.live-count::before'));
    expect(block.slice(0, 120)).toContain('○');
    expect(block.slice(0, 120)).not.toContain('●');
  });
});
