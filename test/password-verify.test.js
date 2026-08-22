import { beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * verifyPassword itself, exercised rather than read.
 *
 * The properties that matter here are about what does NOT differ between cases --
 * wording, work done, whether a session appears -- and none of that is provable by
 * grepping the source. The database is mocked because the alternative is a live
 * Postgres, and every branch worth testing is decided before any real query result
 * is used for anything but a comparison.
 */

const state = {
  users: new Map(),
  failures: 0,
  attempts: [],
  sessions: 0,
};

mock.module('@genre/db/queries', () => ({
  getUserForPassword: async (email) => state.users.get(String(email).toLowerCase()) ?? null,
  recentFailedLogins: async () => state.failures,
  recordLoginAttempt: async (a) => {
    state.attempts.push(a);
  },
  startSession: async () => {
    state.sessions++;
    return `session-${state.sessions}`;
  },
  setPasswordHash: async ({ userId, hash }) => {
    state.users.set(userId, { id: userId, password_hash: hash });
  },
  clearPassword: async () => {},
}));

const { verifyPassword, setPassword } = await import('../packages/auth/src/password.js');

const REAL = 'correct horse battery';
let realHash;

beforeEach(async () => {
  realHash ??= await Bun.password.hash(REAL, { algorithm: 'argon2id' });
  state.users = new Map([
    ['has@example.test', { id: 'u1', email: 'has@example.test', password_hash: realHash }],
    // An account that exists but never set a password. From the outside this must
    // be indistinguishable from an address with no account at all.
    ['nopass@example.test', { id: 'u2', email: 'nopass@example.test', password_hash: null }],
  ]);
  state.failures = 0;
  state.attempts = [];
  state.sessions = 0;
});

describe('signing in', () => {
  test('the right password starts a session', async () => {
    const r = await verifyPassword({ email: 'has@example.test', password: REAL });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe('session-1');
    // The address is normalised here; the ip is passed straight through and
    // coerced to null by the query that stores it.
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].email).toBe('has@example.test');
    expect(state.attempts[0].ok).toBe(true);
  });

  test('the address is matched case-insensitively and trimmed', async () => {
    const r = await verifyPassword({ email: '  HAS@Example.test ', password: REAL });
    expect(r.ok).toBe(true);
  });

  test('a wrong password does not', async () => {
    const r = await verifyPassword({ email: 'has@example.test', password: 'nope nope nope' });
    expect(r.ok).toBe(false);
    expect(state.sessions).toBe(0);
    expect(state.attempts[0].ok).toBe(false);
  });
});

describe('what a failure gives away', () => {
  const failures = async () => [
    await verifyPassword({ email: 'has@example.test', password: 'wrong wrong wrong' }),
    await verifyPassword({ email: 'nopass@example.test', password: 'wrong wrong wrong' }),
    await verifyPassword({ email: 'nobody@example.test', password: 'wrong wrong wrong' }),
  ];

  test('wrong password, no password, and no account read identically', async () => {
    const [a, b, c] = await failures();
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.error).toBe('That email and password do not match.');
  });

  test('none of them leak the account state in any other field', async () => {
    for (const r of await failures()) {
      expect(Object.keys(r).sort()).toEqual(['error', 'ok']);
    }
  });

  test('an account with no password cannot be signed into with an empty one', async () => {
    for (const p of ['', null, undefined]) {
      const r = await verifyPassword({ email: 'nopass@example.test', password: p });
      expect(r.ok).toBe(false);
    }
    expect(state.sessions).toBe(0);
  });

  /**
   * The decoy is the reason a missing account is not obviously missing. Without it
   * the answer comes back without ever hashing, which is a different order of
   * magnitude and readable from the outside.
   */
  test('a missing account still costs real hashing work', async () => {
    const t0 = performance.now();
    await verifyPassword({ email: 'nobody@example.test', password: 'wrong wrong wrong' });
    const missing = performance.now() - t0;

    const t1 = performance.now();
    await verifyPassword({ email: 'has@example.test', password: 'wrong wrong wrong' });
    const present = performance.now() - t1;

    // Argon2id is deliberately slow; a path that skipped it would return in well
    // under a millisecond. Compared against a floor rather than against each other,
    // because wall-clock ratios on a loaded CI box are their own flaky test.
    expect(missing).toBeGreaterThan(1);
    expect(present).toBeGreaterThan(1);
  });
});

describe('throttling', () => {
  test('past the limit it refuses without checking the password at all', async () => {
    state.failures = 10;
    const r = await verifyPassword({ email: 'has@example.test', password: REAL });
    expect(r.ok).toBe(false);
    expect(r.throttled).toBe(true);
    expect(state.sessions).toBe(0);
    // Not even recorded: a refusal we did not evaluate is not an attempt, and
    // counting it would let a throttled address throttle itself forever.
    expect(state.attempts).toEqual([]);
  });

  test('the refusal points at the link, so the account is never locked', async () => {
    state.failures = 10;
    const r = await verifyPassword({ email: 'has@example.test', password: REAL });
    expect(r.error).toContain('sign-in link');
  });

  test('under the limit it still works', async () => {
    state.failures = 9;
    expect((await verifyPassword({ email: 'has@example.test', password: REAL })).ok).toBe(true);
  });
});

describe('setting one', () => {
  test('a bad password is refused and nothing is stored', async () => {
    const r = await setPassword({ userId: 'u9', email: 'a@b.test', password: 'short' });
    expect(r.ok).toBe(false);
    expect(state.users.has('u9')).toBe(false);
  });

  test('a good one is stored hashed, never in the clear', async () => {
    const r = await setPassword({ userId: 'u9', email: 'a@b.test', password: REAL });
    expect(r.ok).toBe(true);
    const stored = state.users.get('u9').password_hash;
    expect(stored).not.toBe(REAL);
    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(await Bun.password.verify(REAL, stored)).toBe(true);
  });
});
