import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { candidateFrom, matchKey } from '../packages/catalog/src/imdb.js';
import { normaliseTitle } from '../packages/catalog/src/slug.js';
import { intOf, streamTsvGz } from '../packages/catalog/src/tsv.js';

/**
 * Backfilling the catalogue from IMDb's daily dumps.
 *
 * The rules that decide what the catalogue CONTAINS are the interesting part, and
 * they are pure -- so they are tested directly rather than through a network. The
 * streaming reader is tested against a real gzip stream, because the bug it exists
 * to avoid (a chunk boundary landing mid-line) cannot be reproduced any other way.
 */

const THIS_YEAR = 2026;
const OPTS = { thisYear: THIS_YEAR, recentYears: 2 };

/** IMDb packs a rating and a vote count into one integer; this mirrors it. */
const packed = (rating, votes) => Math.round(rating * 10) * 10_000_000 + votes;

const basics = (over = {}) => ({
  tconst: 'tt0000001',
  titleType: 'movie',
  primaryTitle: 'The Matrix',
  originalTitle: 'The Matrix',
  isAdult: '0',
  startYear: '1999',
  endYear: null,
  runtimeMinutes: '136',
  genres: 'Action,Sci-Fi',
  ...over,
});

/* ------------------------------------------------------ what gets kept in -- */

describe('which titles are worth holding', () => {
  test('a well-known film is kept whenever it came out', () => {
    const c = candidateFrom(basics(), { ...OPTS, rated: packed(8.7, 2_000_000) });
    expect(c).not.toBeNull();
    expect(c.title).toBe('The Matrix');
    expect(c.year).toBe(1999);
    expect(c.rating).toBe(8.7);
    expect(c.ratingCount).toBe(2_000_000);
  });

  /*
   * The half of the filter that exists for the actual problem.
   *
   * A film released last month has almost no votes, so a vote threshold alone
   * would exclude exactly the titles sitting unmatched in somebody's VOD folder --
   * which is the entire reason for this importer.
   */
  test('a brand new film with no votes at all is still kept', () => {
    const c = candidateFrom(basics({ startYear: String(THIS_YEAR), tconst: 'tt9' }), {
      ...OPTS,
      rated: undefined,
    });
    expect(c).not.toBeNull();
  });

  test('an old film nobody has rated is not', () => {
    expect(candidateFrom(basics({ startYear: '1974' }), { ...OPTS, rated: undefined })).toBeNull();
  });

  test('a film just outside the recent window needs votes', () => {
    const old = String(THIS_YEAR - 3);
    expect(candidateFrom(basics({ startYear: old }), { ...OPTS, rated: undefined })).toBeNull();
    expect(
      candidateFrom(basics({ startYear: old }), { ...OPTS, rated: packed(6, 500) }),
    ).not.toBeNull();
  });

  /*
   * Eight and a half million rows, and every one of them only interesting through
   * the show it belongs to -- which TVmaze already gives us with a real air time,
   * where IMDb would give a year.
   */
  test('an episode is never kept', () => {
    expect(
      candidateFrom(basics({ titleType: 'tvEpisode' }), { ...OPTS, rated: packed(9, 50_000) }),
    ).toBeNull();
  });

  test('nor a short or a video game', () => {
    for (const titleType of ['short', 'videoGame']) {
      expect(
        candidateFrom(basics({ titleType }), { ...OPTS, rated: packed(9, 50_000) }),
      ).toBeNull();
    }
  });

  test('adult titles are excluded outright', () => {
    expect(
      candidateFrom(basics({ isAdult: '1' }), { ...OPTS, rated: packed(9, 50_000) }),
    ).toBeNull();
  });

  test('a series lands in the tv category and a film in film', () => {
    expect(candidateFrom(basics(), { ...OPTS, rated: packed(8, 900) }).category).toBe('film');
    expect(
      candidateFrom(basics({ titleType: 'tvSeries' }), { ...OPTS, rated: packed(8, 900) }).category,
    ).toBe('tv');
  });

  test('a title with no year at all can still be kept on votes', () => {
    const c = candidateFrom(basics({ startYear: null }), { ...OPTS, rated: packed(7, 900) });
    expect(c).not.toBeNull();
    expect(c.year).toBeNull();
  });

  /* Genres this site does not carry are dropped rather than becoming rows. */
  test('genres we do not carry are filtered out', () => {
    const c = candidateFrom(basics({ genres: 'Drama,Talk-Show,Adult' }), {
      ...OPTS,
      rated: packed(7, 900),
    });
    expect(c.genres).toEqual(['Drama']);
  });

  test('a row with no title is skipped rather than stored blank', () => {
    expect(
      candidateFrom(basics({ primaryTitle: null }), { ...OPTS, rated: packed(9, 9999) }),
    ).toBeNull();
  });
});

/* --------------------------------------------------------------- matching -- */

describe('linking a candidate to something we already hold', () => {
  /*
   * Both sides of the match have to go through the SAME normaliser. A SQL
   * approximation would be close enough to look right and wrong often enough to
   * create duplicate pages, which is the outcome the whole linking pass exists to
   * prevent.
   */
  test('the key is built from the normalised title, the year and the category', () => {
    const c = candidateFrom(basics(), { ...OPTS, rated: packed(8.7, 900) });
    expect(matchKey(c)).toBe('film the matrix 1999');
  });

  test('punctuation and case cannot separate two spellings of one title', () => {
    const a = candidateFrom(basics({ primaryTitle: 'WALL·E' }), { ...OPTS, rated: packed(8, 900) });
    const b = candidateFrom(basics({ primaryTitle: 'Wall E' }), { ...OPTS, rated: packed(8, 900) });
    expect(matchKey(a)).toBe(matchKey(b));
  });

  test('a show and a film of the same name in the same year stay two things', () => {
    const film = candidateFrom(basics(), { ...OPTS, rated: packed(8, 900) });
    const show = candidateFrom(basics({ titleType: 'tvSeries' }), { ...OPTS, rated: packed(8, 9) });
    expect(matchKey(film)).not.toBe(matchKey(show));
  });

  test('and two films of the same name in different years do too', () => {
    const a = candidateFrom(basics({ startYear: '1999' }), { ...OPTS, rated: packed(8, 900) });
    const b = candidateFrom(basics({ startYear: '2016' }), { ...OPTS, rated: packed(6, 900) });
    expect(matchKey(a)).not.toBe(matchKey(b));
  });
});

/* ------------------------------------------------------------ the reader -- */

describe('reading a gzipped TSV off the wire', () => {
  const rows = (text) =>
    new Response(new Blob([Bun.gzipSync(Buffer.from(text))]), {
      headers: { 'content-type': 'application/gzip' },
    });

  let server;
  let body = '';
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => rows(body) });
  });

  const read = async (text) => {
    body = text;
    const out = [];
    for await (const row of streamTsvGz(`http://localhost:${server.port}/x.tsv.gz`)) out.push(row);
    return out;
  };

  test('the header names the columns', async () => {
    const out = await read('tconst\tprimaryTitle\ntt1\tDune\n');
    expect(out).toEqual([{ tconst: 'tt1', primaryTitle: 'Dune' }]);
  });

  /*
   * IMDb's null is the two characters backslash-N, not an empty field. Treating it
   * as a string is how a startYear of "\N" becomes NaN three layers down.
   */
  test('IMDb nulls arrive as null, not as the string', async () => {
    const out = await read('tconst\tstartYear\ntt1\t\\N\n');
    expect(out[0].startYear).toBeNull();
    expect(intOf(out[0].startYear)).toBeNull();
  });

  /*
   * The bug this reader exists to avoid, and it cannot be reproduced with a small
   * fixture: a decoded chunk ends wherever the network split it, so the last
   * fragment has to be carried into the next chunk. Yielding it as a row instead
   * produces a stream of rows that are each fine and occasionally truncated.
   */
  test('a line split across chunk boundaries is not truncated', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `tt${i}\tA title long enough to span ${i}`);
    const out = await read(`tconst\tprimaryTitle\n${many.join('\n')}\n`);
    expect(out).toHaveLength(5000);
    expect(out[4999]).toEqual({
      tconst: 'tt4999',
      primaryTitle: 'A title long enough to span 4999',
    });
    expect(out.every((r) => r.tconst?.startsWith('tt'))).toBe(true);
  });

  test('a final line with no trailing newline is still yielded', async () => {
    const out = await read('tconst\tprimaryTitle\ntt1\tDune');
    expect(out).toHaveLength(1);
  });

  test('an upstream failure is named rather than yielding nothing', async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response('no', { status: 503 }) });
    const run = async () => {
      for await (const _ of streamTsvGz(`http://localhost:${dead.port}/x`)) break;
    };
    expect(run()).rejects.toThrow('503');
    dead.stop(true);
  });
});

/* -------------------------------------------------------------- the writes -- */

describe('what the writes do to a real database', () => {
  let db;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }

    // A film TMDB already gave us, exactly as upsertSubjects would have written it.
    await db.query(
      `insert into subjects
         (category, kind, provider, provider_key, slug, name, display_name, search_text,
          norm_title, year, popularity, description)
       values ('film','film','tmdb','tmdb:603','the-matrix','The Matrix','The Matrix',
               'the matrix', $1, 1999, 88.2, 'A hacker learns the truth.')`,
      [normaliseTitle('The Matrix')],
    );
  }, 60_000);

  /** Mirrors subjectsByNormTitle. */
  const lookup = async (norms) =>
    (
      await db.query(
        `select id, category, norm_title, year from subjects where norm_title = any($1::text[])`,
        [`{${norms.map((n) => `"${n}"`).join(',')}}`],
      )
    ).rows;

  test('an existing row is found by the key the importer builds', async () => {
    const c = candidateFrom(basics(), { ...OPTS, rated: packed(8.7, 2_000_000) });
    const rows = await lookup([c.norm]);
    expect(rows).toHaveLength(1);
    expect(`${rows[0].category} ${rows[0].norm_title} ${rows[0].year ?? ''}`).toBe(matchKey(c));
  });

  /** Mirrors linkImdbToSubjects, including the coalesce rules. */
  const link = async (subjectId, tconst, rating, votes) =>
    db.query(
      `update subjects s set
         imdb_id = case when s.imdb_id is null then $2 else s.imdb_id end,
         rating = coalesce(s.rating, $3::numeric),
         rating_count = coalesce(s.rating_count, $4::int),
         popularity = coalesce(s.popularity, $4::numeric)
       where s.id = $1
         and not exists (select 1 from subjects o where o.imdb_id = $2 and o.id <> s.id)`,
      [subjectId, tconst, rating, votes],
    );

  test('linking adds the id and the ratings', async () => {
    const [row] = (await db.query("select id from subjects where slug = 'the-matrix'")).rows;
    await link(row.id, 'tt0133093', 8.7, 2_000_000);
    const [after] = (await db.query('select * from subjects where id = $1', [row.id])).rows;
    expect(after.imdb_id).toBe('tt0133093');
    expect(Number(after.rating)).toBe(8.7);
    expect(after.rating_count).toBe(2_000_000);
  });

  /*
   * A linking pass must never make an existing page worse. TMDB's popularity and
   * description are better than IMDb's absence of them.
   */
  test('and never overwrites what another provider already established', async () => {
    const [after] = (await db.query("select * from subjects where slug = 'the-matrix'")).rows;
    expect(Number(after.popularity)).toBe(88.2);
    expect(after.description).toBe('A hacker learns the truth.');
  });

  test('a second tconst cannot steal a subject that already has one', async () => {
    const [row] = (await db.query("select id from subjects where slug = 'the-matrix'")).rows;
    await link(row.id, 'tt9999999', 1, 1);
    const [after] = (await db.query('select imdb_id from subjects where id = $1', [row.id])).rows;
    expect(after.imdb_id).toBe('tt0133093');
  });

  /* The index is what makes a duplicate impossible rather than merely unlikely. */
  test('two subjects cannot claim the same IMDb id', async () => {
    const insert = db.query(
      `insert into subjects (category, kind, provider, provider_key, slug, name, display_name,
                             search_text, imdb_id)
       values ('film','film','imdb','tt0133093','the-matrix-1999','The Matrix','The Matrix',
               'the matrix','tt0133093')`,
    );
    expect(insert).rejects.toThrow();
  });

  test('the progress row is a single row by construction', async () => {
    await db.query('insert into imdb_progress (id, cursor) values (1, $1)', ['tt0001']);
    const second = db.query('insert into imdb_progress (id, cursor) values (2, $1)', ['tt0002']);
    expect(second).rejects.toThrow();
  });

  /*
   * The multi-row update shape, run for real.
   *
   * Two set-returning functions in one select list are zipped in lockstep by
   * Postgres 10 and later, which is what makes this a legal substitute for a
   * VALUES list -- and a VALUES list is not an option here, because a JS array
   * handed to Bun's parameter serialiser arrives as `a,b` and is rejected as a
   * malformed array literal. That trap silently broke passkey registration and the
   * reminder fan-out before it was found, so the shape is worth pinning.
   */
  test('unnest over parallel arrays updates each row with its own values', async () => {
    const rows = (
      await db.query(
        `insert into subjects (category, kind, provider, provider_key, slug, name, display_name,
                               search_text)
         values ('film','film','x','k1','s1','A','A','a'),
                ('film','film','x','k2','s2','B','B','b')
         returning id`,
      )
    ).rows;

    await db.query(
      `update subjects s set
         imdb_id = coalesce(s.imdb_id, v.imdb_id),
         year = coalesce(s.year, v.year),
         rating_count = coalesce(s.rating_count, v.rating_count)
       from (
         select unnest($1::bigint[]) as id,
                unnest($2::text[]) as imdb_id,
                unnest($3::int[]) as year,
                unnest($4::int[]) as rating_count
       ) v
       where s.id = v.id`,
      [`{${rows.map((r) => r.id).join(',')}}`, '{"tt111","tt222"}', '{1999,NULL}', '{4000,9000}'],
    );

    const after = (
      await db.query('select slug, imdb_id, year, rating_count from subjects where id = any($1)', [
        `{${rows.map((r) => r.id).join(',')}}`,
      ])
    ).rows.sort((a, b) => a.slug.localeCompare(b.slug));

    expect(after[0]).toMatchObject({ imdb_id: 'tt111', year: 1999, rating_count: 4000 });
    // The NULL travelled as a real SQL null, not as the string "NULL" -- which is
    // what makes the coalesces above mean what they say.
    expect(after[1]).toMatchObject({ imdb_id: 'tt222', year: null, rating_count: 9000 });
  });
});
