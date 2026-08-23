import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { entryKind, rankChannelsForTitle } from '../packages/catalog/src/m3u.js';

/**
 * "I found Top Gun: Maverick in a search, but it didn't look in my stream."
 *
 * It didn't. Three separate defects, and the reported one was the third:
 *
 *   1. entryKind was being handed the SEALED stream URL at match time, so it never
 *      found "/movie/" or ".mkv" and answered 'live' for every entry ever
 *      imported. The on-demand tier could not populate for anybody.
 *   2. The kind was computed at import and thrown away, which is why (1) had to
 *      guess in the first place.
 *   3. The matcher only ever ran on EVENT pages. A search result links to a
 *      SUBJECT, and a 2022 film has no upcoming event -- so the page a reader
 *      actually lands on never consulted their list at all, and said "Nothing
 *      scheduled".
 *
 * From the outside all three look identical to a provider that does not carry the
 * film, which is exactly how it was read.
 */

const pages = readFileSync(
  new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
  'utf8',
);
const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
const playlists = readFileSync(
  new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
  'utf8',
);

/* ------------------------------------------------- the tier, and the seal -- */

describe('deciding whether an entry is a file or a channel', () => {
  const film = { id: 1, title: 'Top Gun Maverick (2022)', url: 'http://line/movie/9.mkv' };
  const chan = { id: 2, title: 'Top Gun Channel', url: 'http://line/live/9.ts' };

  test('a VOD file lands in the on-demand tier when its kind is known', () => {
    const ranked = rankChannelsForTitle([{ ...film, kind: entryKind(film) }], {
      title: 'Top Gun: Maverick',
    });
    expect(ranked.onDemand.map((c) => c.id)).toEqual([1]);
    expect(ranked.certain).toEqual([]);
  });

  test('and a live channel of the same name does not', () => {
    const ranked = rankChannelsForTitle([{ ...chan, kind: entryKind(chan) }], {
      title: 'Top Gun',
    });
    expect(ranked.onDemand).toEqual([]);
  });

  /*
   * The bug, reproduced exactly.
   *
   * The stream URL is encrypted at rest, so the row handed to the ranker carried a
   * base64 blob where a path used to be. entryKind found no "/movie/" in it and
   * fell through to 'live' -- so a film in somebody's VOD folder was filed under
   * live channels and "Available on demand" was empty for every reader on every
   * title, forever.
   */
  test('a sealed url makes every entry look live, which is why kind is stored', () => {
    const sealed = { id: 1, title: 'Top Gun Maverick (2022)', url: 'v1.aGVsbG8gd29ybGQ=' };
    expect(entryKind(sealed)).toBe('live');

    const guessing = rankChannelsForTitle([sealed], { title: 'Top Gun: Maverick' });
    expect(guessing.onDemand).toEqual([]);

    // With the stored kind travelling alongside, the same row is filed correctly.
    const knowing = rankChannelsForTitle([{ ...sealed, kind: 'vod' }], {
      title: 'Top Gun: Maverick',
    });
    expect(knowing.onDemand.map((c) => c.id)).toEqual([1]);
  });

  test('the matcher still matches on TITLES, never on urls', () => {
    // The url decides the tier and nothing else. A file whose title does not match
    // is not offered, however obviously on-demand its path looks.
    const ranked = rankChannelsForTitle(
      [{ id: 3, title: 'Casablanca', url: 'http://line/movie/1.mkv', kind: 'vod' }],
      { title: 'Top Gun: Maverick' },
    );
    expect(ranked.onDemand).toEqual([]);
    expect(ranked.certain).toEqual([]);
  });
});

/* ------------------------------------------------ the kind reaches the db -- */

describe('the kind survives the round trip', () => {
  let db;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);

  test('the column exists and is nullable', async () => {
    const [col] = (
      await db.query(
        `select is_nullable from information_schema.columns
         where table_name = 'user_playlist_channels' and column_name = 'kind'`,
      )
    ).rows;
    expect(col).toBeDefined();
    /*
     * Null is a real state: rows imported before the column existed have no kind,
     * and defaulting them to 'live' would re-assert the exact falsehood this
     * migration fixes. They repair themselves on the next refresh.
     */
    expect(col.is_nullable).toBe('YES');
  });

  test('the importer stores it rather than recomputing it', () => {
    expect(playlists).toContain('kind: c.kind ?? null');
  });

  test('and the matcher reads the stored value rather than the sealed url', () => {
    const fn = playlists.slice(playlists.indexOf('export async function ownChannelsFor('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('kind: r.kind ?? null');
    expect(body).toContain('group: r.group_title ?? null');
  });
});

/* --------------------------------------------- the page a reader lands on -- */

describe('a subject page answers "can I watch this"', () => {
  /*
   * The reported bug. A search result links to /subjects/<slug>, and that route
   * fetched upcoming events, genres and a follow flag -- and nothing else. There
   * was no code path from a search result to a reader's own list at all.
   */
  test('the subject route consults the reader’s own list', () => {
    const route = app.slice(
      app.indexOf("app.get('/subjects/:slug'"),
      app.indexOf("app.get('/search'"),
    );
    expect(route).toContain('ownChannelsForSubject');
    expect(route).toContain('sharedChannelsForSubject');
  });

  test('and the page renders the same section the event page does', () => {
    const view = pages.slice(pages.indexOf('export const SubjectPage'));
    const body = view.slice(0, view.indexOf('\n);\n'));
    expect(body).toContain('<OwnLine');
    expect(body).toContain('own={ownChannels}');
  });

  /*
   * The other half of the dead end: upcomingForSubject filters to the future, so
   * a 2022 film had no events either -- no list, and nothing to click into.
   */
  test('a back-catalogue title shows what has already come out', () => {
    const route = app.slice(
      app.indexOf("app.get('/subjects/:slug'"),
      app.indexOf("app.get('/search'"),
    );
    expect(route).toContain('q.pastForSubject');
    const view = pages.slice(pages.indexOf('export const SubjectPage'));
    expect(view.slice(0, view.indexOf('\n);\n'))).toContain('Already out');
  });

  test('the empty state points at the list rather than trailing off', () => {
    // "None of your 7,059 entries look like they carry this" is an answer; it now
    // also says where to go and check what you actually have.
    expect(pages).toContain('browse your list');
  });
});

/* ------------------------------------------------- what is on this line -- */

describe('saying what is actually in a list', () => {
  /*
   * The question underneath the whole report: "my provider may not have VOD at
   * all". Nothing on the site could answer it, so a list of seven thousand live
   * channels and a broken matcher looked the same from the outside.
   */
  test('the channels page counts entries by kind', () => {
    const route = app.slice(app.indexOf("app.get('/my/channels'"));
    expect(route.slice(0, route.indexOf('\n});'))).toContain('q.playlistKindCounts');
  });

  test('and says so outright when a line carries no files at all', () => {
    expect(pages).toContain("k.kind === 'vod' || k.kind === 'series'");
    expect(pages).toContain('it is all live channels');
  });

  test('rows of unknown kind are shown rather than folded into live', () => {
    expect(pages).toContain('not yet classified');
  });
});
