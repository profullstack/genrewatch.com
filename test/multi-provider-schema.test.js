import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

/**
 * The migration, and the rules that moved out of the schema into the code.
 *
 * Two kinds of thing are checked here and they fail in opposite ways. The
 * migration's statements are all guarded (`if not exists`, `if exists`), which
 * makes a wrong ORDER invisible on an existing database and fatal only on a fresh
 * one -- the worst way round for a mistake to hide, and the reason the order is
 * asserted as text rather than trusted to the test databases that happen to apply
 * it. The rest is the wording that used to be enforced by a UNIQUE and is now
 * enforced by handlers naming the row they act on.
 */

let migration;
let queries;
let app;
let playlists;
let live;
let view;

const read = (p) => readFile(new URL(p, import.meta.url).pathname, 'utf8');

beforeAll(async () => {
  migration = await read('../packages/db/migrations/0020_multiple_providers.sql');
  queries = await read('../packages/db/src/queries.js');
  app = await read('../apps/web/src/app.js');
  playlists = await read('../packages/playlists/src/index.js');
  live = await read('../packages/live/src/index.js');
  view = await read('../apps/web/src/views/pages.jsx');
});

describe('the migration', () => {
  test('drops the unique 0002 created, by the name Postgres gave it', () => {
    expect(migration).toContain(
      'alter table user_playlists drop constraint if exists user_playlists_user_id_key',
    );
  });

  test('adds the position column BEFORE the index that sorts on it', () => {
    /*
     * Guarded statements make a wrong order invisible on an existing database and
     * fatal on a fresh one. An index created over a column that does not exist yet
     * fails outright the first time somebody builds the schema from scratch, and
     * nowhere else.
     */
    const addCol = migration.indexOf('add column if not exists position');
    const addIdx = migration.indexOf('user_playlists_user_idx');
    expect(addCol).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(addCol);
  });

  test('hands the stash back as a real row before dropping the columns', () => {
    /*
     * The only destructive step in the file, and the order is the whole of it. A
     * reader part-way through a live pass has their OWN address parked in
     * stashed_source_url while our line holds source_url. Dropping first deletes a
     * subscription they gave us and expect back.
     */
    const insert = migration.indexOf('insert into user_playlists (user_id, label, source_url');
    const drop = migration.indexOf('drop column if exists stashed_source_url');
    expect(insert).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(insert);
    expect(migration).toContain('where stashed_source_url is not null');
  });

  test('does not try to make the address unique instead', () => {
    // source_url is sealed with a random nonce per write, so the same provider URL
    // encrypts to different bytes every time and a UNIQUE on it would never fire.
    expect(migration).not.toContain('unique (source_url)');
    expect(migration).not.toContain('unique(source_url)');
  });
});

describe('ownership is still part of every lookup', () => {
  test('there is no query that takes a playlist id on its own', () => {
    // The rule the block comment in queries.js states. getPlaylistFor is the only
    // lookup that takes a playlist id, and it takes the user id beside it.
    expect(queries).toContain('export async function getPlaylistFor({ userId, playlistId })');
    expect(queries).not.toContain('export async function getPlaylistById');
  });

  test('a rename, a delete and a share all name the owner as well as the row', () => {
    for (const fn of ['renamePlaylist', 'deletePlaylist', 'setPlaylistSharing']) {
      const at = queries.indexOf(`export async function ${fn}(`);
      const body = queries.slice(at, queries.indexOf('\n}\n', at));
      expect(body).toContain('user_id = ${userId}');
    }
  });
});

describe('the cap that replaced the constraint', () => {
  test('lives in the handler, where changing it needs no migration', () => {
    expect(app).toContain('const MAX_PLAYLISTS = 5');
    expect(app).toContain('(await q.playlistCount(user.id)) >= MAX_PLAYLISTS');
  });

  test('applies to adding, never to editing one that already exists', () => {
    // A reader at the limit must still be able to correct a typo in an address.
    expect(app).toContain('if (!playlistId && (await q.playlistCount(user.id)) >= MAX_PLAYLISTS)');
  });
});

describe('the writes that used to mean "their list"', () => {
  test('the refresh poller acts on the row it selected', () => {
    // playlistsDueForRefresh returns the id, and refreshPlaylist passes it on.
    // Without it the poller falls back to the reader's first list, so an account
    // with several has one polled forever and the rest never refreshed at all.
    const at = queries.indexOf('export async function playlistsDueForRefresh(');
    expect(queries.slice(at, queries.indexOf('\n}\n', at))).toContain('select id, user_id');
    expect(playlists).toContain('playlistId: row.id ?? null');
  });

  test('a refresh never manufactures a duplicate list', () => {
    /*
     * importPlaylist ADDS a list when given no id. A refresh that omitted it would
     * insert a fresh row on every cycle -- each one re-fetching the same provider
     * -- until the account hit the cap.
     */
    expect(playlists).toContain(
      'return importPlaylist({ userId, playlistId: row.id, url, label: row.label, knownHash })',
    );
  });

  test('an import names the list it is writing into', () => {
    expect(playlists).toContain('const targetId = saved?.id ?? playlistId ?? null');
    expect(playlists).toContain('playlistId: targetId,');
  });

  test('a failed add removes only the row that add created', () => {
    expect(playlists).toContain('const addedRow = !playlistId');
    expect(playlists).toContain(
      'if (addedRow && targetId) await q.deletePlaylist(userId, targetId)',
    );
  });
});

describe('what a row may hand over is a fact about the row', () => {
  test('the channel row reads managed off the entry, not off the section', () => {
    /*
     * `managed` withholds VLC, Infuse and the .m3u -- each of which hands over the
     * stream address, which on our line is the reseller credential. It was a
     * section-level prop, correct while a whole list was either ours or theirs.
     * Merged, a managed entry sits directly above one of the reader's own.
     */
    expect(view).toContain(
      'const managedRow = ch.playlistId != null ? ch.providerManaged === true : managed',
    );
    expect(view).toContain('{managedRow ? null : (');
  });

  test('an entry carries the line it came from, so the page can say which', () => {
    expect(playlists).toContain('providerLabel: byId.get(m.id)?.playlist_label ?? null');
    expect(playlists).toContain('providerManaged: byId.get(m.id)?.playlist_managed === true');
    expect(view).toContain('{ch.providerLabel ? (');
  });
});

describe('the live pass sits beside the reader lists rather than taking one', () => {
  test('the stash is gone from the code as well as the schema', () => {
    /*
     * The columns, not the word. queries.js still explains in a comment what the
     * stash was and why it went, which is worth keeping -- an empty space where a
     * mechanism used to be teaches nobody why it is not needed.
     */
    expect(live).not.toContain('stashed_source_url');
    expect(live).not.toContain('stashedSourceUrl');
    expect(app).not.toContain('stashed_source_url');
    // No SQL still reads or writes them.
    expect(queries).not.toContain('p.stashed_source_url');
    expect(queries).not.toContain('stashed_source_url =');
    expect(queries).not.toContain('stashedSourceUrl');
  });

  test('a second grant extends the line we already gave them', () => {
    // managedPlaylistFor answers "do they already have OURS among theirs", so a
    // renewal does not add a duplicate line beside the first.
    expect(live).toContain('const existing = await q.managedPlaylistFor(userId)');
  });
});

describe('settings offers adding a line as its own thing', () => {
  test('the edit form names the list it edits', () => {
    // Without the id the route reads the post as a NEW list, so correcting a typo
    // would leave a second broken line instead of a correction.
    expect(view).toContain('<input type="hidden" name="playlist_id" value={playlist.id} />');
  });

  test('the add form carries no id, which is what makes it an add', () => {
    const at = view.indexOf('id="add-line"');
    expect(at).toBeGreaterThan(-1);
    const form = view.slice(at, view.indexOf('</form>', at));
    expect(form).not.toContain('playlist_id');
    expect(form).toContain('Add line');
  });

  test('a managed line is not removable from the other-lines card', () => {
    // Deleting the row we provisioned would leave the pass paid for and nothing to
    // play it on. It goes when the pass lapses.
    const at = view.indexOf('id="other-lines"');
    expect(at).toBeGreaterThan(-1);
    expect(view.slice(at, at + 2500)).toContain('{p.managed ? null : (');
  });
});
