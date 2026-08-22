import { config } from '@genre/config';
import * as q from '@genre/db/queries';

/**
 * An optional password, and the reasoning for allowing one at all.
 *
 * The rest of this package is magic link and passkey, and the argument against a
 * password is still true: it is a weaker second secret whose recovery path collapses
 * back to emailing a link, so it widens the attack surface without widening what an
 * attacker has to defeat.
 *
 * It exists anyway because there is a device where the other two do not work. A
 * television has no mail client to open a link in, no authenticator to hold a
 * passkey, and a remote control instead of a keyboard. "Sign in on another device"
 * is not an answer when the TV IS the device. A credential you can type is the only
 * kind that works there.
 *
 * So the shape is: opt-in, never required, never created for you, and removable.
 * An account has a password only if somebody deliberately set one while already
 * signed in by a stronger method, which means this can never be the way an account
 * is first taken over -- an attacker who could set a password here already had the
 * session needed to do anything else.
 */

/** Long enough to be worth having, short enough to type on a remote control. */
export const MIN_LENGTH = 10;

/**
 * A ceiling, because hashing is deliberately expensive.
 *
 * Argon2 on a megabyte of input is a denial of service somebody can post at us for
 * free. Nothing legitimate is near this.
 */
const MAX_LENGTH = 200;

/**
 * How many wrong guesses an address gets before it is made to wait.
 *
 * Counted since its last SUCCESS rather than over a flat window, so signing in
 * correctly clears the slate -- otherwise somebody else's guessing leaves the real
 * owner one typo from a lockout.
 */
const MAX_FAILURES = 10;
const WINDOW_MINUTES = 15;

/**
 * What a bad password is told, in one place.
 *
 * Returns null when it is acceptable. The rules are deliberately few: length does
 * the real work, and a list of banned shapes mostly teaches people to append "1".
 */
export function passwordProblem(password, { email } = {}) {
  const p = String(password ?? '');
  if (p.length < MIN_LENGTH) return `A password needs at least ${MIN_LENGTH} characters.`;
  if (p.length > MAX_LENGTH) return 'That password is longer than we store.';
  if (p.trim().length === 0) return 'A password cannot be only spaces.';

  const local = String(email ?? '')
    .split('@')[0]
    .toLowerCase();
  if (local && p.toLowerCase() === local) return 'That is your email address, not a password.';
  if (p.toLowerCase() === String(email ?? '').toLowerCase()) {
    return 'That is your email address, not a password.';
  }
  return null;
}

/**
 * A hash to check against when there is nothing to check against.
 *
 * An address with no account, and an account with no password, must cost the same
 * as a real wrong guess -- otherwise the response time answers "does this person
 * have an account here", which is exactly what the vague error wording is trying not
 * to answer. Computed once on first use rather than at import, so a process that
 * never sees a password sign-in never pays for it.
 */
let decoyHash = null;
async function decoy() {
  if (!decoyHash) {
    decoyHash = await Bun.password.hash(`decoy:${config.siteUrl}`, { algorithm: 'argon2id' });
  }
  return decoyHash;
}

/** Argon2id, via Bun's built-in. No dependency, and memory-hard by default. */
export async function hashPassword(password) {
  return Bun.password.hash(String(password), { algorithm: 'argon2id' });
}

/**
 * Set or replace the password on an account that is already signed in.
 *
 * Deliberately takes a user id rather than an address: this is a change made from
 * inside a session, never a way to claim an account from outside.
 */
export async function setPassword({ userId, email, password }) {
  const problem = passwordProblem(password, { email });
  if (problem) return { ok: false, error: problem };
  await q.setPasswordHash({ userId, hash: await hashPassword(password) });
  return { ok: true };
}

export async function removePassword(userId) {
  await q.clearPassword(userId);
  return { ok: true };
}

/**
 * Check an address and password, and start a session if they match.
 *
 * Three things are load-bearing here.
 *
 * One: every failure returns the same thing. Not "no such account", not "that
 * account has no password" -- those answer a question the caller has no business
 * asking, and turn the login form into an address checker.
 *
 * Two: the work done is the same either way. A missing account still verifies
 * against a decoy hash, so the two cases cannot be told apart by how long the answer
 * takes.
 *
 * Three: it is rate limited, and the limit is not a lockout. When somebody is made
 * to wait, the message points at the emailed link -- which still works, is not
 * guessable, and is not affected by this counter. So flooding an address with wrong
 * guesses cannot lock its owner out of their own account; it can only take away the
 * convenience of the password.
 */
export async function verifyPassword({ email, password, userAgent, ip }) {
  const address = String(email ?? '')
    .trim()
    .toLowerCase();
  const generic = { ok: false, error: 'That email and password do not match.' };

  if (!address || !password) return generic;

  if ((await q.recentFailedLogins({ email: address, minutes: WINDOW_MINUTES })) >= MAX_FAILURES) {
    return {
      ok: false,
      throttled: true,
      error: `Too many attempts. Wait ${WINDOW_MINUTES} minutes, or use a sign-in link — that still works.`,
    };
  }

  const user = await q.getUserForPassword(address);
  const hash = user?.password_hash ?? (await decoy());

  let matched = false;
  try {
    matched = await Bun.password.verify(String(password), hash);
  } catch {
    // A stored hash we cannot parse is a failure, never an exception to the caller.
    matched = false;
  }

  // The decoy must never authenticate anything, even in the impossible case that
  // somebody's password is literally the decoy input.
  if (!user?.password_hash) matched = false;

  await q.recordLoginAttempt({ email: address, ok: matched, ip });
  if (!matched) return generic;

  const sessionId = await q.startSession({
    userId: user.id,
    ttlDays: config.session.ttlDays,
    userAgent,
  });
  return { ok: true, user, sessionId };
}
