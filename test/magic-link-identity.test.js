import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * A magic link must sign you into YOUR account.
 *
 * consumeLoginToken returned the whole row instead of its `email` column, and
 * consumeLoginLink hands whatever it gets straight to findOrCreateUser, which
 * interpolates it into `insert into users (email)`. An object stringifies to the
 * text "[object Object]" -- a perfectly valid citext value -- so the upsert
 * conflicted on it every single time and EVERY magic-link sign-in landed in one
 * shared account. Two strangers would have each other's lists, follows and
 * settings, and the account they landed in was not the one they proved they
 * could read the mail for.
 *
 * Found in production on 2026-08-24: one such row, created by a real sign-in.
 * The whole defect is a missing `?.email`, and nothing about the SQL looks
 * wrong, so these tests assert on the VALUE that crosses the boundary.
 */

let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 120_000);

/*
 * token_hash is bytea and the app stores a raw sha256 digest, so the tests hash
 * the same way rather than passing a bare string the column would reject.
 */
const hashToken = (t) => createHash('sha256').update(t).digest();

/** The shape of the real query, so the test fails for the real reason. */
const consume = async (hash) => {
  const { rows } = await db.query(
    `update login_tokens set consumed_at = now()
     where token_hash = $1 and consumed_at is null and expires_at > now()
     returning email`,
    [hashToken(hash)],
  );
  const row = rows[0];
  return row?.email ?? null;
};

const mint = async (email, hash) =>
  db.query(
    `insert into login_tokens (token_hash, email, expires_at)
     values ($1, $2, now() + interval '15 minutes')`,
    [hashToken(hash), email],
  );

const findOrCreateUser = async (email) => {
  const { rows } = await db.query(
    `insert into users (email) values ($1)
     on conflict (email) do update set last_seen_at = now()
     returning id, email::text as email, (xmax = 0) as created`,
    [email],
  );
  return rows[0];
};

describe('the real query', () => {
  /*
   * The tests below model the boundary; this one pins the actual line, because
   * the whole defect was `row` where `row?.email` belonged and nothing else in
   * the function changed. A model alone would have kept passing through it.
   */
  test('hands back the email column, not the row', () => {
    const src = readFileSync(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const i = src.indexOf('export async function consumeLoginToken');
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf('\n}\n', i));
    expect(body).toContain('return row?.email ?? null;');
    expect(body).not.toContain('return row ?? null;');
  });
});

describe('consuming a sign-in link', () => {
  test('returns the address as a string, never the row', async () => {
    await mint('reader@example.com', 'h1');
    const got = await consume('h1');
    expect(typeof got).toBe('string');
    expect(got).toBe('reader@example.com');
  });

  test('a spent link cannot be spent twice', async () => {
    await mint('reader@example.com', 'h2');
    expect(await consume('h2')).toBe('reader@example.com');
    expect(await consume('h2')).toBeNull();
  });

  test('two different people get two different accounts', async () => {
    await mint('alice@example.com', 'a1');
    await mint('bob@example.com', 'b1');

    const alice = await findOrCreateUser(await consume('a1'));
    const bob = await findOrCreateUser(await consume('b1'));

    expect(alice.email).toBe('alice@example.com');
    expect(bob.email).toBe('bob@example.com');
    expect(alice.id).not.toBe(bob.id);
  });

  /*
   * The bug reproduced exactly, so the consequence is on the record rather than
   * inferred. Handing the ROW to the upsert conflates every caller into one
   * account -- and it does it silently, because "[object Object]" is a legal
   * citext value and the insert succeeds.
   */
  test('handing the row through instead would merge them into one account', async () => {
    const asRow = (email) => ({ email });
    const first = await findOrCreateUser(asRow('carol@example.com'));
    const second = await findOrCreateUser(asRow('dave@example.com'));

    expect(first.email).toBe('[object Object]');
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
  });

  test('and no real address is ever stored as that string', async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from users where email::text = '[object Object]'`,
    );
    // One, from the reproduction above. The production row this test exists for
    // was created by the code path, not by a test.
    expect(rows[0].n).toBe(1);
  });
});
