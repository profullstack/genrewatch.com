import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  const films = [
    ['The Blair Witch Project', 1999, 22.5],
    ['Blair Witch', 2016, 11.0],
    ['Top Gun: Maverick', 2022, 90.1],
    ['Top Gun', 1986, 40.0],
    ['Maverick', 1994, 9.0],
  ];
  for (const [name, year, pop] of films) {
    const [s] = (
      await db.query(
        `insert into subjects (category,kind,provider,provider_key,slug,name,display_name,search_text,popularity)
         values ('film','film','tmdb',$1,$2,$3,$3,lower($3),$4) returning id`,
        [`k-${name}`, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, pop],
      )
    ).rows;
    await db.query(
      `insert into events (provider,provider_key,category,subject_id,kind,starts_at,name,state,time_known,precision)
       values ('tmdb',$1,'film',$2,'release',$3,$4,'out',false,'day')`,
      [`e-${name}`, s.id, new Date(`${year}-06-01T12:00:00Z`), name],
    );
  }
}, 60_000);

/** Mirrors searchCatalogue's ordering. */
const search = async (q, limit = 10) =>
  (
    await db.query(
      `select s.display_name
       from subjects s
       where s.search_text % $1 or s.search_text like $2
       order by ((similarity(s.search_text, $1) * 0.75)
                 + (least(ln(greatest(coalesce(s.popularity,0),1)) / 7.0, 1.0) * 0.25)
                 + (case when s.search_text like $3 then 0.15 else 0 end)) desc,
                s.popularity desc nulls last
       limit $4`,
      [q, `%${q}%`, `${q}%`, limit],
    )
  ).rows.map((r) => r.display_name);

describe('searching the back catalogue', () => {
  /*
   * The whole reason this exists. Every other read on the site filters to the
   * future, which is right for a calendar and useless for someone with a
   * subscription asking whether a 1999 film is available.
   */
  test('finds a film from 1999', async () => {
    expect(await search('blair witch')).toContain('The Blair Witch Project');
  });

  test('a partial title still finds it', async () => {
    expect(await search('maverick')).toContain('Top Gun: Maverick');
  });

  // People type what they remember, not what is on the poster.
  test('survives a typo', async () => {
    const r = await search('blar witch');
    expect(r.length).toBeGreaterThan(0);
    expect(r).toContain('The Blair Witch Project');
  });

  /*
   * Similarity alone puts an exact match on an obscure title above a near match
   * on a famous one, which is wrong for how people type -- someone searching
   * "top gun" means the franchise, and the popular entry should lead.
   */
  test('popularity breaks ties within a similarity band', async () => {
    const r = await search('top gun');
    expect(r[0]).toBe('Top Gun');
    expect(r).toContain('Top Gun: Maverick');
  });

  /*
   * The ranking failure this replaced.
   *
   * Ordering by similarity and only then by popularity put The Blair Witch
   * Project FOURTH for "blair witch", behind The Real Blair Witch, The Blair
   * Witch Legacy and ahead of only The Blair Witch Rejects -- three cash-ins
   * nobody was looking for, each of which matched the words slightly better.
   *
   * The exact-title match still leads, which is right: someone typing a whole
   * title means that title. What changed is that fame now separates the rest,
   * so the film people actually mean is second rather than buried.
   */
  test('a famous title outranks the cash-ins that match the words better', async () => {
    for (const [name, pop] of [
      ['The Real Blair Witch', 0.6],
      ['The Blair Witch Legacy', 0.4],
      ['The Blair Witch Rejects', 0.3],
    ]) {
      await db.query(
        `insert into subjects (category,kind,provider,provider_key,slug,name,display_name,search_text,popularity)
         values ('film','film','tmdb',$1,$1,$2,$2,lower($2),$3) on conflict do nothing`,
        [name.replace(/\W+/g, '-'), name, pop],
      );
    }

    const r = await search('blair witch');
    const project = r.indexOf('The Blair Witch Project');
    expect(project).toBeGreaterThanOrEqual(0);
    for (const cashIn of [
      'The Real Blair Witch',
      'The Blair Witch Legacy',
      'The Blair Witch Rejects',
    ]) {
      const i = r.indexOf(cashIn);
      if (i >= 0) expect(project).toBeLessThan(i);
    }
  });

  test('nothing matches nonsense rather than returning the whole table', async () => {
    expect(await search('zzzzqqq')).toEqual([]);
  });
});

describe('the back catalogue stays off the calendar', () => {
  /*
   * Four thousand old films must not drown the upcoming pages. They are stored
   * with state 'out' and every calendar read filters on it.
   */
  test('past films are marked out, not upcoming', async () => {
    const { rows } = await db.query(`select count(*)::int as n from events where state = 'out'`);
    expect(rows[0].n).toBe(5);
    const up = await db.query(`select count(*)::int as n from events where state = 'upcoming'`);
    expect(up.rows[0].n).toBe(0);
  });
});

describe('the page cursor', () => {
  test('records how far the walk got, and only ever moves forward', async () => {
    await db.query(
      `insert into catalogue_progress (provider, pages_done) values ('tmdb', 25)
       on conflict (provider) do update set pages_done = greatest(catalogue_progress.pages_done, excluded.pages_done)`,
    );
    await db.query(
      `insert into catalogue_progress (provider, pages_done) values ('tmdb', 10)
       on conflict (provider) do update set pages_done = greatest(catalogue_progress.pages_done, excluded.pages_done)`,
    );
    const { rows } = await db.query(
      `select pages_done from catalogue_progress where provider='tmdb'`,
    );
    // A pass that returns fewer pages must not rewind the cursor and re-walk.
    expect(rows[0].pages_done).toBe(25);
  });
});
