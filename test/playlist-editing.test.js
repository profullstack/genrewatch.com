import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

// The PURE module, deliberately: importing source.js would load the real query
// module and re-register it over password-verify.test.js's mock.module, which
// sends ten unrelated tests at a Postgres that is not running.
const { maskPlaylistUrl } = await import('../packages/playlists/src/mask.js');

/**
 * Seeing and changing the list you already gave us.
 *
 * The address is sealed because it carries a provider username and password, and
 * that was read for a while as "never show it, never let it be edited" -- so the
 * only way to change anything was Remove and paste the whole credentialed URL
 * again, which forced a copy of it to be kept somewhere less careful than here.
 *
 * These tests hold the two halves of the fix apart: what is rendered into a page
 * must still be masked, and what is stored must be editable in place.
 */

describe('masking an address', () => {
  test('the host survives, the credentials do not', () => {
    const masked = maskPlaylistUrl('http://line.example.test:8080/playlist/anthony/hunter2/m3u');
    expect(masked).toContain('line.example.test:8080');
    expect(masked).toContain('playlist');
    expect(masked).not.toContain('hunter2');
    expect(masked).not.toContain('anthony');
  });

  test('enough of a segment is kept to recognise which line it is', () => {
    // Two accounts on the same panel are told apart by this and nothing else.
    expect(maskPlaylistUrl('http://h.test/playlist/anthony/hunter2/m3u')).toContain('an');
  });

  test('the get.php form is masked in its query string', () => {
    const masked = maskPlaylistUrl(
      'http://h.test/get.php?username=anthony&password=hunter2&type=m3u',
    );
    expect(masked).not.toContain('hunter2');
    expect(masked).not.toContain('anthony');
    // What is NOT a credential stays readable, so the shape is still recognisable.
    expect(masked).toContain('type=m3u');
  });

  test('an unrecognised shape is masked rather than guessed at', () => {
    const masked = maskPlaylistUrl('http://h.test/a/verysecretthing');
    expect(masked).not.toContain('verysecretthing');
  });

  test('a single-segment path is masked too', () => {
    // With one segment there is no leading route to keep, so it is all secret.
    expect(maskPlaylistUrl('http://h.test/supersecret')).not.toContain('supersecret');
  });

  test('junk is null rather than a throw', () => {
    expect(maskPlaylistUrl('not a url')).toBeNull();
  });
});

describe('editing in place', () => {
  let db;
  let user;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    user = (await db.query(`insert into users (email) values ('edit@example.test') returning id`))
      .rows[0].id;
    await db.query(
      `insert into user_playlists (user_id, label, source_url, channel_count, content_hash, error_streak)
       values ($1, 'old name', 'sealed', 7059, 'abc123', 3)`,
      [user],
    );
    const pl = (await db.query(`select id from user_playlists where user_id = $1`, [user])).rows[0];
    await db.query(
      `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title, is_live)
       values ($1, 0, 'NFL 01', 'sealed-url', 'nfl 01', true)`,
      [pl.id],
    );
  }, 60_000);

  test('a rename touches the name and nothing else', async () => {
    // The point of a separate statement: renaming must not disturb the sealed
    // address, the content hash that keeps a refresh cheap, or the back-off state.
    await db.query(`update user_playlists set label = $2 where user_id = $1`, [user, 'new name']);
    const { rows } = await db.query(`select * from user_playlists where user_id = $1`, [user]);
    expect(rows[0].label).toBe('new name');
    expect(rows[0].source_url).toBe('sealed');
    expect(rows[0].content_hash).toBe('abc123');
    expect(rows[0].error_streak).toBe(3);
  });

  test('a rename keeps the channels and their probe verdicts', async () => {
    const { rows } = await db.query(
      `select c.title, c.is_live from user_playlist_channels c
         join user_playlists p on p.id = c.playlist_id
        where p.user_id = $1`,
      [user],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_live).toBe(true);
  });
});

describe('the routes that make it editable', () => {
  let src = '';
  let view = '';

  beforeAll(async () => {
    src = await readFile(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
    view = await readFile(
      new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
      'utf8',
    );
  });

  test('the address can be read back by the account that stored it', () => {
    expect(src).toContain("app.get('/api/playlist/source'");
    expect(src).toContain('playlistSource(user.id)');
  });

  test('a credential is never cached', () => {
    const route = src.slice(src.indexOf("app.get('/api/playlist/source'"));
    expect(route.slice(0, 600)).toContain("c.header('cache-control', 'no-store')");
  });

  test('the reveal is keyed on the session, with no id from the request', () => {
    const route = src.slice(
      src.indexOf("app.get('/api/playlist/source'"),
      src.indexOf("app.post('/api/playlist/refresh'"),
    );
    expect(route).not.toContain('c.req.param');
    expect(route).not.toContain('c.req.query');
  });

  test('a blank address on an existing list is a rename, not a wipe', () => {
    expect(src).toContain('q.renamePlaylist(');
  });

  test('re-submitting the same address does not rewrite every channel row', () => {
    expect(src).toContain('knownHash: same ?');
  });

  test('an unchanged import no longer reports NaN channels', () => {
    // `channels` is null when the provider's file hashed the same, and
    // Number(null) rendered as "Imported NaN channels" on a save that worked.
    expect(src).toContain('playlistNoticeFor');
    expect(src).toContain("added === 'unchanged'");
  });

  test('settings renders the masked address, never the sealed column', () => {
    expect(view).toContain('data-playlist-url');
    expect(view).toContain('playlistMasked');
    expect(view).not.toContain('playlist.source_url');
  });

  test('the form edits rather than demanding the whole URL again', () => {
    expect(view).toContain('required={!playlist}');
    expect(view).toContain('Leave blank to keep the current address');
    expect(view).not.toContain('Replace list');
  });
});

describe('the Show button', () => {
  /**
   * app.js is a classic script that runs its bootstrap on load, so the reveal is
   * sliced out and evaluated against a small fake DOM -- the same approach
   * own-channel-actions.test.js takes, and for the same reason: importing the file
   * would start the whole page.
   */
  let handler;
  let field;
  let input;
  let button;
  let fetched;
  let response;

  const mkEl = () => ({
    dataset: {},
    hidden: true,
    disabled: false,
    textContent: 'Show',
    value: '',
    select() {},
    closest(sel) {
      return sel === '[data-playlist-reveal]' && this === button ? button : null;
    },
  });

  beforeAll(async () => {
    const src = await readFile(
      new URL('../apps/web/public/app.js', import.meta.url).pathname,
      'utf8',
    );
    const start = src.indexOf('function initPlaylistReveal');
    const end = src.indexOf(
      '/* ------------------------------------------------------------------ ajax -- */',
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    field = mkEl();
    input = mkEl();
    button = mkEl();

    const doc = {
      addEventListener: (type, fn) => {
        if (type === 'click') handler = fn;
      },
      querySelector: (sel) =>
        sel === '[data-playlist-url]' ? field : sel === '[data-playlist-input]' ? input : null,
      querySelectorAll: (sel) => (sel === '[data-playlist-reveal]' ? [button] : []),
    };

    const fakeFetch = async (url) => {
      fetched = url;
      return response;
    };

    // The bootstrap that calls it lives at the bottom of the file, outside this
    // slice, so the call is appended here -- otherwise the delegated listener is
    // registered and the button is never unhidden.
    new Function('document', 'fetch', `${src.slice(start, end)}\ninitPlaylistReveal(document);`)(
      doc,
      fakeFetch,
    );

    // What the page rendered, before anything is pressed.
    field.value =
      'http://line.example.test:8080/playlist/an\u2022\u2022\u2022/\u2022\u2022\u2022/m3\u2022';
  });

  test('the button is hidden until script runs, then shown', () => {
    // With script off there is nothing to press, which is honest: the reveal
    // cannot work without a fetch.
    expect(button.hidden).toBe(false);
  });

  test('pressing it asks the no-store route and fills the field', async () => {
    response = {
      ok: true,
      json: async () => ({ url: 'http://line.example.test:8080/playlist/anthony/hunter2/m3u' }),
    };
    await handler({ target: button });
    expect(fetched).toBe('/api/playlist/source');
    expect(field.value).toBe('http://line.example.test:8080/playlist/anthony/hunter2/m3u');
    expect(button.textContent).toBe('Hide');
  });

  test('it also fills the edit form, so changing it needs no retyping', () => {
    expect(input.value).toBe('http://line.example.test:8080/playlist/anthony/hunter2/m3u');
  });

  test("pressing it again puts the server's mask back", async () => {
    // The mask the server sent, not one computed here -- there is only one place
    // that decides how much of a password is safe to show.
    await handler({ target: button });
    expect(field.value).toContain('\u2022\u2022');
    expect(field.value).not.toContain('hunter2');
    expect(button.textContent).toBe('Show');
  });

  test('a refused request says so rather than silently doing nothing', async () => {
    response = { ok: false, json: async () => ({ error: 'You have not added a list.' }) };
    await handler({ target: button });
    expect(button.textContent).toBe('Unavailable');
  });
});
