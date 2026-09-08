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

/*
 * The row has an id now, because a reader can hold several lists and every write
 * names the one it is about. `getPlaylistFor` is what importPlaylist asks when it
 * is EDITING a list, which is the case this probe is about: correcting the address
 * on a subscription that already exists.
 */
const ROW_ID = 1;

mock.module('@genre/db/queries', () => ({
  getPlaylist: async () => row,
  getPlaylistFor: async ({ playlistId }) => (playlistId === ROW_ID ? row : null),
  savePlaylist: async ({ userId, label, sourceUrl }) => {
    row = {
      ...(row ?? {}),
      id: ROW_ID,
      user_id: userId,
      label,
      source_url: sourceUrl,
      last_error: null,
    };
    return row;
  },
  markPlaylistError: async ({ error }) => {
    if (row) row.last_error = error;
  },
  markPlaylistFresh: async () => {},
  // A failed ADD removes the row it created. An edit never reaches this.
  deletePlaylist: async () => {
    row = null;
  },
  // genrewatch re-parses when the stored rows predate a column a fresh parse
  // would fill; nothing here is old, so nothing is stale.
  playlistNeedsReparse: async () => false,
  EmptyPlaylistError: class EmptyPlaylistError extends Error {
    constructor() {
      super('no channels found in that file');
      this.name = 'EmptyPlaylistError';
    }
  },
  /*
   * Faithful to the real contract, not a no-op.
   *
   * It takes a producer rather than an array now, and "the file parsed to
   * nothing" is signalled by throwing from in here so the transaction rolls
   * back. A stub that swallowed both would report a login page as a successful
   * import -- which is exactly the case two of these assertions are about.
   */
  replacePlaylistChannels: async ({ fill }) => {
    let stored = 0;
    await fill(async (rows) => {
      stored += rows.length;
    });
    if (stored === 0) {
      const err = new Error('no channels found in that file');
      err.name = 'EmptyPlaylistError';
      throw err;
    }
    return stored;
  },
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
    await importPlaylist({ userId: 'u1', playlistId: ROW_ID, url, label });
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
row = { id: ROW_ID, user_id: 'u1', label: 'My line', source_url: seal(GOOD), last_error: null };
globalThis.fetch = async () => new Response('<html>login</html>', { status: 200 });
out.notAPlaylistMessage = await attempt(BAD);
out.storedAfterNotAPlaylist = open(row.source_url);

// A failing refresh re-submits the address already stored. Nothing changed, so
// there is nothing to restore -- and saying otherwise would tell somebody their
// address was put back when it never moved.
row = { id: ROW_ID, user_id: 'u1', label: 'My line', source_url: seal(GOOD), last_error: null };
globalThis.fetch = async () => new Response('down', { status: 500 });
out.sameUrlMessage = await attempt(GOOD);
out.storedAfterSameUrl = open(row.source_url);

/*
 * A failed ADD, as opposed to a failed edit.
 *
 * Everything above corrects the address on a list that already exists, and the
 * rollback puts the working one back. Adding a SECOND provider has no previous
 * address to restore -- the row did not exist a moment ago -- so undoing it means
 * removing the row. Without that, one typo leaves a permanently broken line on the
 * settings page that the reader has to notice and clear out by hand.
 */
row = null;
globalThis.fetch = async () => new Response('no', { status: 404 });
out.failedAddMessage = await (async () => {
  try {
    await importPlaylist({ userId: 'u1', url: BAD, label: 'A second line' });
    return null;
  } catch (err) {
    return err.message;
  }
})();
out.rowAfterFailedAdd = row;

console.log(JSON.stringify(out));
