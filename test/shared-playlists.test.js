import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * Opening one account's channel list to everybody signed in.
 *
 * Everything about this table was built to make that impossible -- migration 0002
 * says outright that a list "belongs to exactly one account and is never pooled".
 * That is still the default and still what an account gets without asking. This
 * covers the opt-out from it, and most of these tests are about what sharing does
 * NOT do: it does not hand over the address, and it does not let a stranger take
 * a line that is already carrying something.
 */

let db;
const ids = {};

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const user = async (email, handle, name) =>
    (
      await db.query(
        'insert into users (email, handle, display_name) values ($1, $2, $3) returning id',
        [email, handle, name],
      )
    ).rows[0].id;

  ids.owner = await user('owner@example.com', 'owner', 'The Owner');
  ids.viewer = await user('viewer@example.com', 'viewer', 'A Viewer');
  ids.quiet = await user('quiet@example.com', 'quiet', 'Keeps It Private');

  const list = async (userId, label, count) =>
    (
      await db.query(
        `insert into user_playlists (user_id, label, source_url, channel_count)
         values ($1, $2, 'sealed-url', $3) returning id`,
        [userId, label, count],
      )
    ).rows[0].id;

  ids.ownerList = await list(ids.owner, 'provider.example', 2);
  ids.quietList = await list(ids.quiet, 'other.example', 1);

  const channel = async (playlistId, pos, title) =>
    (
      await db.query(
        `insert into user_playlist_channels
           (playlist_id, position, title, group_title, stream_url, norm_title)
         values ($1, $2, $3, 'Movies', 'sealed-stream', $4) returning id`,
        [playlistId, pos, title, title.toLowerCase()],
      )
    ).rows[0].id;

  ids.sharedChannel = await channel(ids.ownerList, 0, 'Dune Part Two');
  await channel(ids.ownerList, 1, 'Blade Runner 2049');
  ids.privateChannel = await channel(ids.quietList, 0, 'Dune Part Two');
}, 60_000);

/**
 * Mirrors setPlaylistSharing.
 *
 * Writes the flag and the audience together, because the schema now refuses a row
 * where they disagree -- which is the point of the constraint: a caller that sets
 * one without the other fails here rather than leaving a row some later query
 * reads as open. This helper setting only `shared` is exactly the bug it guards.
 */
const setShared = async (userId, shared, label = null, audience = 'everyone') =>
  (
    await db.query(
      `update user_playlists set
         shared = $2,
         share_audience = case when $2 then $4 else 'none' end,
         shared_at = case when $2 and not shared then now() else shared_at end,
         shared_label = $3
       where user_id = $1
       returning shared, share_audience, shared_at, shared_label`,
      [userId, shared, label, audience],
    )
  ).rows[0];

/** Mirrors sharedPlaylistChannels. */
const sharedChannels = async (viewerId) =>
  (
    await db.query(
      `select c.id, c.title,
              coalesce(p.shared_label, u.display_name, '@' || u.handle::text, 'someone') as owner_label,
              p.user_id as owner_id
       from user_playlists p
       join users u on u.id = p.user_id
       join user_playlist_channels c on c.playlist_id = p.id
       where p.shared
         and (
           p.share_audience = 'everyone'
           or (p.share_audience = 'friends' and exists (
                 select 1 from playlist_share_grants g
                 where g.playlist_id = p.id and g.audience_user_id = $1::uuid))
         )
         and ($1::uuid is null or p.user_id <> $1)
         and (c.is_live is not false or c.checked_at < now() - interval '30 minutes')
       order by c.position`,
      [viewerId],
    )
  ).rows;

describe('the default', () => {
  test('a list is private when it is created', async () => {
    const rows = (await db.query('select shared, shared_at from user_playlists')).rows;
    expect(rows.every((r) => r.shared === false)).toBe(true);
    expect(rows.every((r) => r.shared_at === null)).toBe(true);
  });

  test('and nothing is visible across accounts until somebody opts in', async () => {
    expect(await sharedChannels(ids.viewer)).toEqual([]);
  });
});

describe('opening a list', () => {
  test('makes its channels reachable by another account', async () => {
    await setShared(ids.owner, true, "Owner's line");
    const rows = await sharedChannels(ids.viewer);
    expect(rows.map((r) => r.title)).toEqual(['Dune Part Two', 'Blade Runner 2049']);
  });

  /*
   * The private label defaults to the provider's HOSTNAME, which is the one thing
   * not to publish: it names the owner's provider to everybody on the site.
   */
  test('shows the label the owner chose, never the provider hostname', async () => {
    const rows = await sharedChannels(ids.viewer);
    expect(rows[0].owner_label).toBe("Owner's line");
    expect(rows.some((r) => r.owner_label.includes('provider.example'))).toBe(false);
  });

  test('falls back to a name rather than to the hostname when no label was given', async () => {
    await setShared(ids.owner, true, null);
    expect((await sharedChannels(ids.viewer))[0].owner_label).toBe('The Owner');
    await setShared(ids.owner, true, "Owner's line");
  });

  test('leaves every other account private', async () => {
    const rows = await sharedChannels(ids.viewer);
    expect(rows.every((r) => r.owner_id === ids.owner)).toBe(true);
  });

  /* Already the first section on the page; twice reads as a duplicate. */
  test('does not show the owner their own list in the shared section', async () => {
    expect(await sharedChannels(ids.owner)).toEqual([]);
  });

  test('stamps when it started, and does not restamp on a second save', async () => {
    const first = (
      await db.query('select shared_at from user_playlists where user_id = $1', [ids.owner])
    ).rows[0];
    await setShared(ids.owner, true, 'Renamed');
    const second = (
      await db.query('select shared_at from user_playlists where user_id = $1', [ids.owner])
    ).rows[0];
    expect(second.shared_at).toEqual(first.shared_at);
    await setShared(ids.owner, true, "Owner's line");
  });
});

describe('closing it again', () => {
  test('takes the channels back out of reach immediately', async () => {
    await setShared(ids.owner, false);
    expect(await sharedChannels(ids.viewer)).toEqual([]);
    await setShared(ids.owner, true, "Owner's line");
  });

  /* A write authorised by p.shared has to stop being possible too. */
  test('and a probe verdict can no longer be written to it by a stranger', async () => {
    await setShared(ids.owner, false);
    const res = await db.query(
      `update user_playlist_channels c set is_live = true, checked_at = now()
       from user_playlists p
       where c.id = $1 and p.id = c.playlist_id and p.shared`,
      [ids.sharedChannel],
    );
    expect(res.affectedRows).toBe(0);
    await setShared(ids.owner, true, "Owner's line");
  });
});

describe('what a shared entry never gives away', () => {
  // Read synchronously: a describe body is not async, and hoisting these into a
  // beforeAll would put them out of reach of the closures below.
  const playlists = readFileSync(
    new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
    'utf8',
  );
  const views = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );

  /*
   * The whole reason this feature is offerable.
   *
   * The stream URL carries the owner's provider username and password. A shared
   * list that also handed out the address would last exactly as long as it took
   * one person to paste one, and the owner's subscription with it.
   */
  test('sharedChannelsFor returns no url at all', () => {
    // The ranking lives in sharedChannelsFor now; the Event and Subject variants
    // are thin wrappers that only choose the title. This is the one that touches
    // rows, so it is the one that must never unseal.
    const fn = playlists.slice(playlists.indexOf('export async function sharedChannelsFor('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('ownerId: row.owner_id');
    // open() is how a sealed URL becomes a usable one. It must not appear here.
    expect(body).not.toContain('open(');
  });

  test('the shared row offers Play and nothing else', () => {
    const row = views.slice(views.indexOf('export const SharedChannelRow'));
    const body = row.slice(0, row.indexOf('\n);\n'));
    expect(body).toContain('data-play={`/shared/${ch.id}/stream.ts`}');
    // Each of these works by handing over the address.
    expect(body).not.toContain('playerLinks');
    expect(body).not.toContain('playlist.m3u');
  });

  test('the directory page lists owners, never titles or addresses', () => {
    const page = views.slice(views.indexOf('export const SharedLists'));
    const body = page.slice(0, page.indexOf('\n);\n'));
    expect(body).toContain('channel_count');
    expect(body).not.toContain('stream_url');
    expect(body).not.toContain('ch.title');
  });
});

describe('whose connection is being spent', () => {
  const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
  const route = (() => {
    const i = app.indexOf("app.get('/shared/:channelId/stream.ts'");
    return app.slice(i, app.indexOf('\n});', i));
  })();

  /*
   * The ceiling is a property of the OWNER's line, not of the audience. Counting
   * against the viewer would let twenty readers open twenty connections on one
   * subscription, which is how that subscription gets terminated.
   */
  test('the slot is claimed against the owner, not the viewer', () => {
    expect(route).toContain('claimStreamSlot(row.owner_id');
    expect(route).not.toContain('claimStreamSlot(user.id');
  });

  /*
   * On the owner's own stream eviction is right: pressing Play elsewhere says
   * which entry they want now. Taking a stranger's film off them because you
   * clicked something is not the same act.
   */
  test('a busy line refuses a stranger rather than evicting whoever is watching', () => {
    expect(route).toContain('streamSlotsOpen(row.owner_id)');
    expect(route).toContain('409');
  });

  test('but never locks the owner out of their own line', () => {
    expect(route).toContain('const isOwner = row.owner_id === user.id');
    expect(route).toContain('if (!isOwner &&');
  });

  test('every shared route requires a session', () => {
    for (const path of ['/shared', '/shared/:channelId/stream.ts', '/shared/:channelId/check']) {
      const i = app.indexOf(`app.get('${path}'`);
      expect(i).toBeGreaterThan(-1);
      expect(app.slice(i, i + 260)).toContain('requireUser(c)');
    }
  });
});
