import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { passwordProblem } from '../packages/auth/src/password.js';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * The optional password, and the properties that make it safe to have at all.
 *
 * It exists for televisions, which cannot open an emailed link or hold a passkey.
 * Everything here is about keeping that convenience from becoming the weakest point
 * of the whole account: it is opt-in, set only from inside a session, tells an
 * attacker nothing about who has an account, and its rate limit can never lock the
 * real owner out, because the emailed link is not subject to it.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  await db.query(`insert into users (email) values ('has@example.test')`);
}, 60_000);

describe('what a password has to be', () => {
  test('too short is refused, and says the number', () => {
    expect(passwordProblem('short')).toContain('10');
  });

  test('a long enough one is accepted', () => {
    expect(passwordProblem('correct horse battery')).toBeNull();
  });

  test('spaces alone are not a password', () => {
    expect(passwordProblem('            ')).toBe('A password cannot be only spaces.');
  });

  test('your own address is refused, whole or local part', () => {
    expect(passwordProblem('anthony', { email: 'anthony@example.test' })).toBeTruthy();
    expect(passwordProblem('anthony@example.test', { email: 'anthony@example.test' })).toBe(
      'That is your email address, not a password.',
    );
  });

  test('something absurdly long is refused rather than hashed', () => {
    // Argon2 on a megabyte of input is a denial of service somebody can post for
    // free.
    expect(passwordProblem('x'.repeat(5000))).toBe('That password is longer than we store.');
  });
});

describe('hashing', () => {
  test('argon2id, and never the password itself', async () => {
    const hash = await Bun.password.hash('correct horse battery', { algorithm: 'argon2id' });
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse battery');
    expect(await Bun.password.verify('correct horse battery', hash)).toBe(true);
    expect(await Bun.password.verify('wrong', hash)).toBe(false);
  });

  test('two accounts with the same password get different hashes', async () => {
    const a = await Bun.password.hash('the same one', { algorithm: 'argon2id' });
    const b = await Bun.password.hash('the same one', { algorithm: 'argon2id' });
    expect(a).not.toBe(b);
  });
});

describe('the rate limit', () => {
  /** The statement behind q.recentFailedLogins. */
  const failures = async (email) =>
    (
      await db.query(
        `select count(*)::int as n from login_attempts
          where email = $1 and not ok
            and at > now() - interval '15 minutes'
            and at > coalesce((select max(at) from login_attempts where email = $1 and ok),
                              'epoch'::timestamptz)`,
        [email],
      )
    ).rows[0].n;

  const attempt = async (email, ok) =>
    db.query(`insert into login_attempts (email, ok) values ($1, $2)`, [email, ok]);

  test('counts wrong guesses for an address', async () => {
    for (let i = 0; i < 3; i++) await attempt('rate@example.test', false);
    expect(await failures('rate@example.test')).toBe(3);
  });

  test('a success clears the slate', async () => {
    // Otherwise somebody else guessing at your address leaves you one typo from a
    // lockout you did nothing to earn.
    await attempt('rate@example.test', true);
    expect(await failures('rate@example.test')).toBe(0);
  });

  test('one address does not throttle another', async () => {
    for (let i = 0; i < 12; i++) await attempt('victim@example.test', false);
    expect(await failures('victim@example.test')).toBe(12);
    expect(await failures('bystander@example.test')).toBe(0);
  });

  test('an attempt against an address with no account is still counted', async () => {
    // That is the kind we most want counted, and it has no user row to hang off --
    // which is why the column is an address and not a foreign key.
    await attempt('nobody@example.test', false);
    expect(await failures('nobody@example.test')).toBe(1);
  });

  test('attempts are countable without a users row existing', async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from login_attempts where email = 'nobody@example.test'`,
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('what the account carries', () => {
  test('an account starts with no password', async () => {
    const { rows } = await db.query(
      `select password_hash, password_set_at from users where email = 'has@example.test'`,
    );
    expect(rows[0].password_hash).toBeNull();
    expect(rows[0].password_set_at).toBeNull();
  });

  test('setting one stamps when, and removing it clears both', async () => {
    await db.query(
      `update users set password_hash = 'x', password_set_at = now() where email = 'has@example.test'`,
    );
    let r = (await db.query(`select password_set_at from users where email = 'has@example.test'`))
      .rows[0];
    expect(r.password_set_at).not.toBeNull();

    await db.query(
      `update users set password_hash = null, password_set_at = null where email = 'has@example.test'`,
    );
    r = (
      await db.query(
        `select password_hash, password_set_at from users where email = 'has@example.test'`,
      )
    ).rows[0];
    expect(r.password_hash).toBeNull();
    expect(r.password_set_at).toBeNull();
  });
});

describe('the properties that keep this from being the weak point', () => {
  const src = (p) => readFile(new URL(p, import.meta.url).pathname, 'utf8');

  test('every failure is worded identically, so the form is not an address checker', async () => {
    const s = await src('../packages/auth/src/password.js');
    const body = s.slice(s.indexOf('export async function verifyPassword'));
    // One generic message, returned from every failure path.
    expect(body).toContain('That email and password do not match.');
    expect(body).not.toContain('no such account');
    expect(body).not.toContain('no password set');
  });

  test('a missing account still costs a verify, so timing does not answer either', async () => {
    const s = await src('../packages/auth/src/password.js');
    expect(s).toContain('decoy');
    const body = s.slice(s.indexOf('export async function verifyPassword'));
    expect(body).toContain('await decoy()');
    // And the decoy must never be able to authenticate anything.
    expect(body).toContain('if (!user?.password_hash) matched = false;');
  });

  test('throttling points at the link, which the counter does not affect', async () => {
    // This is what stops a flood of guesses at somebody's address from locking them
    // out of their own account: the limit takes away the password, never the account.
    const s = await src('../packages/auth/src/password.js');
    expect(s).toContain('use a sign-in link');
  });

  test('a password can only be set from inside a session', async () => {
    const s = await src('../apps/web/src/app.js');
    const route = s.slice(s.indexOf("app.post('/api/auth/password/set'"));
    expect(route.slice(0, 300)).toContain('requireUser(c)');
  });

  test('setPassword takes a user id, never an address', async () => {
    // An address would make it a way to claim somebody else's account.
    const s = await src('../packages/auth/src/password.js');
    expect(s).toContain('export async function setPassword({ userId, email, password })');
  });

  test('the sign-in form works without script', async () => {
    // The device this exists for is a television.
    const { SignIn } = await import('../apps/web/src/views/pages.jsx');
    const html = (await SignIn({ mode: 'login', next: '/following' }).toString()).toString();
    expect(html).toContain('action="/api/auth/password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autocomplete="current-password"');
  });

  test('a failed sign-in re-renders with the form already open', async () => {
    const { SignIn } = await import('../apps/web/src/views/pages.jsx');
    const html = (
      await SignIn({
        mode: 'login',
        passwordError: 'That email and password do not match.',
      }).toString()
    ).toString();
    expect(html).toContain('open');
    expect(html).toContain('do not match');
  });

  test('the settings card offers removal, and says it is not a lockout', async () => {
    const s = await src('../apps/web/src/views/pages.jsx');
    expect(s).toContain('Remove your password?');
    expect(s).toContain('still be able to sign in with an emailed link');
  });
});
