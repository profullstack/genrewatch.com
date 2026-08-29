/**
 * Does a failed import put the previous address back?
 *
 * Run as a CHILD PROCESS by playlist-rollback.test.js, and that is the whole
 * reason this file exists separately. Answering the question needs the database
 * module replaced, and `mock.module` is registered process-wide rather than per
 * file -- doing it inline took twenty-two unrelated tests down with it, because
 * every other file that imports `@genre/db/queries` got this fake instead. A
 * child process is the isolation bun:test does not give.
 *
 * It prints one JSON object and exits. The assertions live in the test file.
 */

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
process.env.PLAYLIST_SECRET = 'test-secret-for-sealing-values';

const { mock } = await import('bun:test');

const ROOT = new URL('../../', import.meta.url).pathname;
const { open, seal } = await import(`${ROOT}packages/auth/src/secretbox.js`);

/** The one row this feature stores, held in memory. */
let row = null;

mock.module('@genre/db/queries', () => ({
  getPlaylist: async () => row,
  savePlaylist: async ({ userId, label, sourceUrl }) => {
    row = { ...(row ?? {}), user_id: userId, label, source_url: sourceUrl, last_error: null };
    return row;
  },
  markPlaylistError: async ({ error }) => {
    if (row) row.last_error = error;
  },
  markPlaylistFresh: async () => {},
  // genrewatch re-parses when the stored rows predate a column a fresh parse
  // would fill; nothing here is old, so nothing is stale.
  playlistNeedsReparse: async () => false,
  replacePlaylistChannels: async () => {},
}));

const { importPlaylist } = await import(`${ROOT}packages/playlists/src/index.js`);

const GOOD = 'http://line.example.test/playlist/me/secret/m3u';
const BAD = 'http://line.example.test/playlist/typo/secret/m3u';
const M3U = '#EXTM3U\n#EXTINF:-1 group-title="Movies",Blade Runner 2049\nhttp://x.test/a/b/1\n';

/** Answers only for GOOD, so BAD is a 404 the way a typo really is. */
const serveOnly = (url) => {
  globalThis.fetch = async (asked) =>
    String(asked) === url
      ? new Response(M3U, { status: 200 })
      : new Response('no', { status: 404 });
};

const attempt = async (url, label = 'My line') => {
  try {
    await importPlaylist({ userId: 'u1', url, label });
    return null;
  } catch (err) {
    return err.message;
  }
};

const out = {};

// A good first import, which everything below is measured against.
serveOnly(GOOD);
await importPlaylist({ userId: 'u1', url: GOOD, label: 'My line' });
out.storedAfterGoodImport = open(row.source_url);
out.labelAfterGoodImport = row.label;

// A typo: fails, and must not take the working address with it.
out.typoMessage = await attempt(BAD);
out.storedAfterTypo = open(row.source_url);
out.labelAfterTypo = row.label;
out.errorRecorded = row.last_error;

// A line that has expired often serves an HTML login page with a 200.
row = { user_id: 'u1', label: 'My line', source_url: seal(GOOD), last_error: null };
globalThis.fetch = async () => new Response('<html>login</html>', { status: 200 });
out.notAPlaylistMessage = await attempt(BAD);
out.storedAfterNotAPlaylist = open(row.source_url);

// A failing refresh re-submits the address already stored. Nothing changed, so
// there is nothing to restore -- and saying otherwise would tell somebody their
// address was put back when it never moved.
row = { user_id: 'u1', label: 'My line', source_url: seal(GOOD), last_error: null };
globalThis.fetch = async () => new Response('down', { status: 500 });
out.sameUrlMessage = await attempt(GOOD);
out.storedAfterSameUrl = open(row.source_url);

console.log(JSON.stringify(out));
