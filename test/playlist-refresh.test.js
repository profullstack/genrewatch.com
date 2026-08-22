import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Polling readers' channel lists on a schedule.
 *
 * The bookkeeping is the whole feature. There is no cheap poll -- the provider
 * offers no conditional request, so every fetch is the whole file -- which means
 * the only two levers are "don't rewrite the rows when the bytes did not change"
 * and "stop pulling from something that is failing". Both live in these columns,
 * and both are invisible from the outside, so they are pinned here.
 */
let db;
let user;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  user = (await db.query(`insert into users (email) values ('a@example.test') returning id`))
    .rows[0].id;
  await db.query(
    `insert into user_playlists (user_id, label, source_url) values ($1, 'x', 'sealed')`,
    [user],
  );
}, 60_000);

/** The statement behind q.markPlaylistError. */
const markError = async (who, error) =>
  db.query(
    `update user_playlists set
       last_error = $2,
       last_synced_at = now(),
       error_streak = least(error_streak + 1, 8),
       refresh_after = now() + (least(power(2, least(error_streak + 1, 6))::int, 60) || ' minutes')::interval
     where user_id = $1`,
    [who, error],
  );

/** The statement behind q.markPlaylistFresh. */
const markFresh = async (who, hash, nextAt) =>
  db.query(
    `update user_playlists set
       last_synced_at = now(), last_error = null, error_streak = 0,
       content_hash = $2, refresh_after = $3
     where user_id = $1`,
    [who, hash, nextAt],
  );

const due = async () =>
  (
    await db.query(
      `select user_id, content_hash from user_playlists
        where refresh_after is null or refresh_after <= now()
        order by refresh_after nulls first, last_synced_at nulls first`,
    )
  ).rows;

const row = async () =>
  (await db.query(`select * from user_playlists where user_id = $1`, [user])).rows[0];

describe('which lists are due', () => {
  test('a list that has never been polled is due immediately', async () => {
    // refresh_after is null on a row added before this migration existed, and on
    // every freshly added list. Waiting out an interval it was never scheduled
    // into would make a new list look broken for five minutes.
    expect((await due()).map((r) => r.user_id)).toContain(user);
  });

  test('a freshly polled list is not due again', async () => {
    await markFresh(user, 'hash-a', new Date(Date.now() + 5 * 60_000));
    expect(await due()).toEqual([]);
  });

  test('the stored hash travels with the due row, so the poller can skip the rewrite', async () => {
    await markFresh(user, 'hash-a', new Date(Date.now() - 1000));
    const [r] = await due();
    expect(r.content_hash).toBe('hash-a');
  });
});

describe('backing off a provider that is failing', () => {
  test('the first failure backs off, and the streak climbs', async () => {
    await markFresh(user, 'hash-a', new Date());
    await markError(user, 'the provider answered 404');

    const r = await row();
    expect(r.error_streak).toBe(1);
    expect(r.last_error).toBe('the provider answered 404');
    // Backed off into the future rather than retried on the next tick.
    expect(new Date(r.refresh_after).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(await due()).toEqual([]);
  });

  test('repeated failures back off further, and cap at an hour', async () => {
    for (let i = 0; i < 8; i++) await markError(user, 'still down');
    const r = await row();
    // The streak is capped so a week of downtime cannot overflow the exponent.
    expect(r.error_streak).toBe(8);
    const minutes = (new Date(r.refresh_after).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(50);
    expect(minutes).toBeLessThanOrEqual(61);
  });

  test('a success clears the streak and the error', async () => {
    await markFresh(user, 'hash-b', new Date(Date.now() + 5 * 60_000));
    const r = await row();
    expect(r.error_streak).toBe(0);
    expect(r.last_error).toBeNull();
    expect(r.content_hash).toBe('hash-b');
  });
});

describe('the code behind it', () => {
  const src = async (p) => readFile(new URL(p, import.meta.url).pathname, 'utf8');

  test('the poller is sequential, not fanned out', async () => {
    // Several ~800KB pulls at once from one datacenter IP is the traffic pattern
    // that gets somebody's line cut off.
    const s = await src('../packages/playlists/src/index.js');
    const body = s.slice(s.indexOf('export async function refreshDuePlaylists'));
    expect(body).toContain('for (const row of due)');
    expect(body).not.toContain('Promise.all');
  });

  test('an unchanged body skips the channel rewrite', async () => {
    const s = await src('../packages/playlists/src/index.js');
    expect(s).toContain('knownHash === contentHash');
    expect(s).toContain('unchanged: true');
  });

  test('one failing list does not stop the others', async () => {
    const s = await src('../packages/playlists/src/index.js');
    const body = s.slice(s.indexOf('export async function refreshDuePlaylists'));
    expect(body).toContain('catch');
    expect(body).toContain('failed++');
  });

  test('an idle tick still says something', async () => {
    // A poller that logs nothing when idle is indistinguishable from one that was
    // never registered, which is the exact question asked of it.
    const s = await src('../packages/playlists/src/index.js');
    expect(s).toContain('[playlists] nothing due');
  });

  test('the package depends only on other packages, so the worker can import it', async () => {
    // packages/queue cannot import from apps/web; that is why this moved out of
    // apps/web/src/lib at all.
    const pkg = JSON.parse(await src('../packages/playlists/package.json'));
    expect(Object.keys(pkg.dependencies).every((d) => d.startsWith('@genre/'))).toBe(true);
    expect(pkg.dependencies).not.toHaveProperty('@genre/web');
  });

  test('both consumers declare the dependency rather than resolving it by luck', async () => {
    // A workspace dep that resolves by accident of the linker works locally and
    // fails in the container. That is a known trap in this repo's heritage.
    for (const p of ['../apps/web/package.json', '../packages/queue/package.json']) {
      const pkg = JSON.parse(await src(p));
      expect(pkg.dependencies).toHaveProperty('@genre/playlists');
    }
  });
});
