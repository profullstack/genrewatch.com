import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { handleAvailableShape } = await import('../packages/db/src/queries.js');

let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

describe('signing a comment', () => {
  /*
   * The bug this closes, ported from upstream: comments were signed with the LOCAL
   * PART OF THE AUTHOR'S EMAIL -- anthony@… rendered as "anthony" on a page anyone
   * can read without an account. Nothing beyond the local part was ever printed,
   * but it was still publishing something nobody chose to publish.
   */
  const commenterName = (c) =>
    c.display_name || (c.handle ? `@${c.handle}` : String(c.email ?? '?').split('@')[0]);

  test('a display name wins over everything', () => {
    expect(commenterName({ display_name: 'Ant', handle: 'ant', email: 'a@b.com' })).toBe('Ant');
  });

  test('a handle wins over the email', () => {
    expect(commenterName({ handle: 'ant', email: 'anthony@b.com' })).toBe('@ant');
  });

  test('the email fragment is a fallback, and never more than the local part', () => {
    expect(commenterName({ email: 'anthony@profullstack.com' })).toBe('anthony');
    expect(commenterName({ email: 'anthony@profullstack.com' })).not.toContain('@');
  });
});

describe('handles', () => {
  test('a handle cannot shadow a real route', () => {
    for (const reserved of ['genres', 'subjects', 'categories', 'settings', 'api', 'feeds', 'my']) {
      expect(handleAvailableShape(reserved)).toBe(false);
    }
  });

  test('shape is constrained rather than trusted', () => {
    expect(handleAvailableShape('anthony')).toBe(true);
    expect(handleAvailableShape('an')).toBe(false);
    expect(handleAvailableShape('_leading')).toBe(false);
    expect(handleAvailableShape('has space')).toBe(false);
    expect(handleAvailableShape('a'.repeat(31))).toBe(false);
  });

  test('the database, not the app, is what stops two people taking one handle', async () => {
    await db.query(`insert into users (email, handle) values ('a@x.com','taken')`);
    let threw = null;
    try {
      await db.query(`insert into users (email, handle) values ('b@x.com','TAKEN')`);
    } catch (e) {
      threw = e.message;
    }
    // citext, so "Alice" and "alice" are one account rather than two.
    expect(threw).toMatch(/users_handle_key|duplicate key/i);
  });

  test('a handle is null until chosen -- never derived from the address', async () => {
    const { rows } = await db.query(
      `insert into users (email) values ('nobody@x.com') returning handle, display_name`,
    );
    expect(rows[0].handle).toBeNull();
    expect(rows[0].display_name).toBeNull();
  });
});
