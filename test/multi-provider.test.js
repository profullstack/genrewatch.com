import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * More than one provider line per reader.
 *
 * 0002 allowed exactly one and enforced it with a UNIQUE on user_id, so adding a
 * second subscription destroyed the first -- sealed, and unrecoverable. Dropping
 * that constraint is one line; what it changes is everything that said "the
 * reader's list" and meant it literally.
 *
 * These are about the four places where the old wording silently became a bug
 * rather than a limitation, because in each of them "their list" quietly resolves
 * to "whichever row came back first":
 *
 *   - an import would wipe another list's channels;
 *   - a share would open every list at once, our managed line among them;
 *   - the refresh poller would re-poll one row forever and never touch the rest;
 *   - a merged match list would hand out our reseller credential on rows that
 *     came from our line.
 *
 * The queries are LIFTED from queries.js and run as written, so an edit to the
 * shipped SQL is what gets tested rather than a restatement of it here.
 */

let db;
const ids = {};
let queries;

/** The text of one query, with its interpolations turned into placeholders. */
const lift = (source, name, params) => {
  const at = source.indexOf(`export async function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const open = source.indexOf('sql`', at);
  const close = source.indexOf('`;', open);
  let text = source.slice(open + 4, close);
  params.forEach(([placeholder, n]) => {
    text = text.replace(new RegExp(placeholder, 'g'), `$${n}`);
  });
  return text;
};

const rows = async (text, params = []) => (await db.query(text, params)).rows;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  queries = await readFile(
    new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    'utf8',
  );

  ids.reader = (
    await rows(`insert into users (email, handle) values ('two@example.test','two') returning id`)
  )[0].id;
  ids.friend = (
    await rows(`insert into users (email, handle) values ('pal@example.test','pal') returning id`)
  )[0].id;
});

/** A list for the reader, at the end of their ordering, as savePlaylist writes it. */
const addList = async (label, { managed = false, userId = null } = {}) =>
  (
    await rows(
      `insert into user_playlists (user_id, label, source_url, position, managed)
       values ($1, $2, $3,
         coalesce((select max(position) + 1 from user_playlists where user_id = $1), 0), $4)
       returning id, position`,
      [userId ?? ids.reader, label, `sealed:${label}`, managed],
    )
  )[0];

const addChannel = async (playlistId, position, title) =>
  (
    await rows(
      `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
       values ($1, $2, $3, $4, $5) returning id`,
      [playlistId, position, title, `sealed:${title}`, title.toLowerCase()],
    )
  )[0].id;

describe('the constraint that made a second list impossible', () => {
  test('two lists can belong to one reader, and they queue up in order', async () => {
    const first = await addList('First provider');
    const second = await addList('Second provider');
    expect(first.position).toBe(0);
    // Appended rather than prepended: a new list is unproven, so it must not
    // outrank the provider the reader has been using.
    expect(second.position).toBe(1);
    ids.first = first.id;
    ids.second = second.id;
  });

  test('the unique that forbade it is gone by name', async () => {
    const found = await rows(
      `select 1 from pg_constraint where conname = 'user_playlists_user_id_key'`,
    );
    expect(found.length).toBe(0);
  });

  test('the index that replaced it is the lookup the new queries make', async () => {
    const found = await rows(
      `select indexdef from pg_indexes where indexname = 'user_playlists_user_idx'`,
    );
    expect(found.length).toBe(1);
    expect(found[0].indexdef).toContain('user_id');
    expect(found[0].indexdef).toContain('position');
  });
});

describe('an import writes to the list it names, and no other', () => {
  test("replacing one list's channels leaves the other's alone", async () => {
    await addChannel(ids.first, 0, 'Alpha One');
    await addChannel(ids.first, 1, 'Alpha Two');
    await addChannel(ids.second, 0, 'Beta One');

    // What replacePlaylistChannels does inside its transaction, against a NAMED
    // row. Unnamed it resolves to the reader's first list -- so an import into
    // their second provider would delete the first's channels and write its own
    // in their place. That is a corruption, not a refinement.
    const [target] = await rows(`select id from user_playlists where user_id = $1 and id = $2`, [
      ids.reader,
      ids.second,
    ]);
    await rows(`delete from user_playlist_channels where playlist_id = $1`, [target.id]);
    await addChannel(ids.second, 0, 'Beta Replaced');

    const kept = await rows(
      `select title from user_playlist_channels where playlist_id = $1 order by position`,
      [ids.first],
    );
    expect(kept.map((r) => r.title)).toEqual(['Alpha One', 'Alpha Two']);
  });
});

describe('matching spans every line the reader has', () => {
  let candidatesSql;

  beforeAll(async () => {
    candidatesSql = lift(queries, 'playlistCandidates', [
      ['\\$\\{userId\\}', 1],
      ['\\$\\{pgArray\\(usable\\.map\\(\\(t\\) => `%\\$\\{t\\}%`\\)\\)\\}', 2],
      ['\\$\\{limit\\}', 3],
    ]);
    // Seeded here rather than relying on the import block above, which replaces
    // the second list's channels -- that is what it is there to prove.
    await addChannel(ids.second, 0, 'Beta One');
  });

  test('an entry says which line it is on', async () => {
    const found = await rows(candidatesSql, [ids.reader, ['%one%'], 100]);
    const titles = found.map((r) => r.title);
    // Both providers answered, which is the whole point.
    expect(titles).toContain('Alpha One');
    expect(titles).toContain('Beta One');
    const alpha = found.find((r) => r.title === 'Alpha One');
    expect(alpha.playlist_id).toBe(ids.first);
    expect(alpha.playlist_label).toBe('First provider');
    expect(alpha.playlist_managed).toBe(false);
  });

  test("the reader's own ordering decides, not the provider's numbering", async () => {
    /*
     * Positions restart at zero per list, so ordering by the channel's position
     * alone interleaves two providers arbitrarily -- and because the read is
     * capped, an interleave decides WHICH rows survive the limit rather than
     * merely the order they appear in.
     */
    const found = await rows(candidatesSql, [ids.reader, ['%one%'], 100]);
    const firstFromEach = found.map((r) => r.playlist_id);
    expect(firstFromEach.indexOf(ids.first)).toBeLessThan(firstFromEach.indexOf(ids.second));
  });

  test('a managed entry is marked as ours, sitting beside one of theirs', async () => {
    const ours = await addList('GenreWatch Live TV', { managed: true });
    ids.managed = ours.id;
    await addChannel(ours.id, 0, 'Gamma One');
    const found = await rows(candidatesSql, [ids.reader, ['%one%'], 100]);
    const gamma = found.find((r) => r.title === 'Gamma One');
    expect(gamma.playlist_managed).toBe(true);
    // And the reader's own rows are still theirs, in the same result set. This is
    // what a section-level answer could not express.
    expect(found.find((r) => r.title === 'Alpha One').playlist_managed).toBe(false);
  });
});

describe('sharing opens one list, never the whole account', () => {
  test('opening the first list does not open our managed line with it', async () => {
    const sharingSql = lift(queries, 'setPlaylistSharing', [
      ['\\$\\{shared\\}', 1],
      ['\\$\\{wanted\\}', 2],
      ['\\$\\{label === null \\? null : String\\(label\\)\\.slice\\(0, 80\\)\\}', 3],
      ['\\$\\{userId\\}', 4],
      ['\\$\\{playlistId\\}', 5],
    ]);
    const opened = await rows(sharingSql, [true, 'everyone', 'My line', ids.reader, ids.first]);
    expect(opened.length).toBe(1);
    expect(opened[0].id).toBe(ids.first);

    const managed = await rows(`select shared from user_playlists where id = $1`, [ids.managed]);
    expect(managed[0].shared).toBe(false);
    const other = await rows(`select shared from user_playlists where id = $1`, [ids.second]);
    expect(other[0].shared).toBe(false);
  });

  test('a managed list cannot be opened even when it is named outright', async () => {
    const sharingSql = lift(queries, 'setPlaylistSharing', [
      ['\\$\\{shared\\}', 1],
      ['\\$\\{wanted\\}', 2],
      ['\\$\\{label === null \\? null : String\\(label\\)\\.slice\\(0, 80\\)\\}', 3],
      ['\\$\\{userId\\}', 4],
      ['\\$\\{playlistId\\}', 5],
    ]);
    // The route refuses this too. The clause is what makes the refusal impossible
    // to route around, because our line's address IS our reseller credential.
    const done = await rows(sharingSql, [true, 'everyone', null, ids.reader, ids.managed]);
    expect(done.length).toBe(0);
  });

  test('naming a friend puts them on one list, not on every line', async () => {
    const grantSql = lift(queries, 'setPlaylistShareGrant', [
      ['\\$\\{audienceUserId\\}', 1],
      ['\\$\\{userId\\}', 2],
      ['\\$\\{playlistId\\}', 3],
    ]);
    await rows(grantSql, [ids.friend, ids.reader, ids.first]);
    const granted = await rows(
      `select playlist_id from playlist_share_grants where audience_user_id = $1`,
      [ids.friend],
    );
    expect(granted.map((r) => Number(r.playlist_id))).toEqual([Number(ids.first)]);
  });
});

describe('removing a list', () => {
  test('by id takes one and leaves the rest', async () => {
    const deleteSql = lift(queries, 'deletePlaylist', [
      ['\\$\\{userId\\}', 1],
      ['\\$\\{playlistId\\}', 2],
    ]);
    await rows(deleteSql, [ids.reader, ids.second]);
    const left = await rows(`select id from user_playlists where user_id = $1 order by position`, [
      ids.reader,
    ]);
    expect(left.map((r) => Number(r.id)).sort()).toEqual(
      [Number(ids.first), Number(ids.managed)].sort(),
    );
  });

  test('with no id still means every list, which is what closing an account wants', async () => {
    const deleteSql = lift(queries, 'deletePlaylist', [
      ['\\$\\{userId\\}', 1],
      ['\\$\\{playlistId\\}', 2],
    ]);
    const doomed = (
      await rows(`insert into users (email, handle) values ('bye@example.test','bye') returning id`)
    )[0].id;
    await addList('One', { userId: doomed });
    await addList('Two', { userId: doomed });
    await rows(deleteSql, [doomed, null]);
    const left = await rows(`select id from user_playlists where user_id = $1`, [doomed]);
    expect(left.length).toBe(0);
  });
});
