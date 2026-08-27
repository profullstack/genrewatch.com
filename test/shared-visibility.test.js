import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * "Another user follows me but they are not seeing my streams."
 *
 * Two separate things, and only one of them was a bug.
 *
 * FOLLOWING IS NOT SHARING. Visibility is gated on `user_playlists.shared` alone;
 * no query in this codebase joins a follow to a channel. A follower of somebody
 * who has not opened their list sees nothing, correctly.
 *
 * The bug: once a list IS shared, the viewer's read took the first 20,000 rows by
 * position and ranked those, while the OWNER's own page narrowed in SQL across the
 * whole list. On a 300,000-entry VOD catalogue the row that carries a title is
 * usually past 20,000 -- so the owner saw it and everybody they shared with did
 * not, which reads exactly like sharing being broken.
 */

let db;
const ids = {};

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const user = async (email) =>
    (await db.query('insert into users (email) values ($1) returning id', [email])).rows[0].id;
  ids.owner = await user('owner@example.com');
  ids.follower = await user('follower@example.com');

  const pl = (
    await db.query(
      // `shared` and `share_audience` are written together because the schema
      // refuses a row where they disagree -- see 0016. 'everyone' is what the
      // boolean alone used to mean.
      `insert into user_playlists (user_id, label, source_url, shared, share_audience)
       values ($1, 'big', 'sealed', true, 'everyone') returning id`,
      [ids.owner],
    )
  ).rows[0].id;

  /*
   * A catalogue-shaped list: the interesting row is deep, exactly where a real
   * VOD dump puts it. 25,000 rows is enough to sit past the old 20,000 ceiling.
   */
  await db.query(
    `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
     select $1, g, 'Filler ' || g, 'sealed', 'filler ' || g from generate_series(1, 25000) g`,
    [pl],
  );
  await db.query(
    `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
     values ($1, 30000, '4K: Top Gun: Maverick (2022)', 'sealed', 'top gun maverick')`,
    [pl],
  );
  // Twenty-five thousand rows through PGlite, plus every migration. Comfortably
  // over the 5s default once the whole suite is competing for the machine.
}, 120_000);

/** The OLD read: first N by position, unfiltered. */
const byPosition = async (viewerId, limit = 20000) =>
  (
    await db.query(
      `select c.title from user_playlists p
       join user_playlist_channels c on c.playlist_id = p.id
       where p.shared and p.user_id <> $1
       order by c.position limit $2`,
      [viewerId, limit],
    )
  ).rows.map((r) => r.title);

/** The NEW read: narrowed in SQL across the whole shared set. */
const byTerms = async (viewerId, terms) =>
  (
    await db.query(
      `select c.title from user_playlists p
       join user_playlist_channels c on c.playlist_id = p.id
       where p.shared and p.user_id <> $1
         and c.norm_title like any($2::text[])
       order by c.position limit 3000`,
      [viewerId, `{${terms.map((t) => `"%${t}%"`).join(',')}}`],
    )
  ).rows.map((r) => r.title);

describe('a follower reading a large shared list', () => {
  test('the old position-capped read never reaches the match', async () => {
    const seen = await byPosition(ids.follower);
    expect(seen).toHaveLength(20000);
    expect(seen).not.toContain('4K: Top Gun: Maverick (2022)');
  });

  test('the narrowed read finds it wherever it sits', async () => {
    expect(await byTerms(ids.follower, ['maverick'])).toEqual(['4K: Top Gun: Maverick (2022)']);
  });

  /* The owner was never affected — their own page always narrowed in SQL. */
  test('which is why the owner saw it and the follower did not', async () => {
    const ownerSaw = (
      await db.query(
        `select c.title from user_playlist_channels c
         join user_playlists p on p.id = c.playlist_id
         where p.user_id = $1 and c.norm_title like '%maverick%'`,
        [ids.owner],
      )
    ).rows.map((r) => r.title);
    expect(ownerSaw).toEqual(['4K: Top Gun: Maverick (2022)']);
  });
});

describe('following is not sharing', () => {
  /*
   * Worth pinning: there is no follow anywhere in the visibility rule, and adding
   * one silently would change who can reach somebody's provider credentials.
   */
  test('the shared reads are gated on p.shared and nothing else', () => {
    const queries = readFileSync(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    for (const fn of ['sharedPlaylistCandidates', 'sharedChannelCount', 'sharedChannelById']) {
      const i = queries.indexOf(`export async function ${fn}`);
      expect(i).toBeGreaterThan(-1);
      const body = queries.slice(i, queries.indexOf('\n}\n', i));
      expect(body).toContain('p.shared');
      expect(body).not.toContain('user_follows');
    }
  });

  test('an unshared list is invisible however many people follow its owner', async () => {
    await db.query(
      "update user_playlists set shared = false, share_audience = 'none' where user_id = $1",
      [ids.owner],
    );
    expect(await byTerms(ids.follower, ['maverick'])).toEqual([]);
    await db.query(
      "update user_playlists set shared = true, share_audience = 'everyone' where user_id = $1",
      [ids.owner],
    );
  });
});

describe('saying which kind of empty it is', () => {
  const pages = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );

  /*
   * The section used to render only when something matched, so "nobody has shared
   * a list" and "somebody has, and none of it names this title" both showed as
   * nothing at all. The second is the one that reads as a broken feature.
   */
  test('the section appears whenever a shared list exists', () => {
    expect(pages).toContain('shared?.channelCount > 0');
  });

  test('and says so plainly when nothing matched', () => {
    expect(pages).toContain('channels shared');
    expect(pages).toContain('shared.channelCount.toLocaleString');
  });
});
