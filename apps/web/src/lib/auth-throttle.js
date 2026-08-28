/**
 * Escalating per-caller backoff in front of the unauthenticated auth routes.
 *
 * ## What was already here, and what it did not cover
 *
 * `packages/auth/src/password.js` counts failures per ADDRESS: ten wrong guesses
 * in fifteen minutes and that address is made to wait. That is the right defence
 * for one account under attack, and it stays exactly as it is.
 *
 * It does nothing about the other shape, which is the one actually arriving: one
 * caller working through a list of many different addresses. Every address is on
 * its own counter, so none of them ever trips, and each request still reaches
 * `Bun.password.verify` — argon2id, memory-hard, deliberately expensive. A list
 * of ten thousand addresses is therefore ten thousand free argon2 hashes, which
 * is both an unmetered credential-stuffing run and a way to burn the box's CPU
 * from outside. This refuses *before* the hash, which is the point.
 *
 * ## Keying on the address, which the old comment says not to do
 *
 * `app.js` says the forwarded address is "never used as the rate-limit key -- a
 * shared address would then throttle strangers", and that was correct about the
 * per-account counter it was describing: keying an account lockout on an IP lets
 * one person behind a NAT lock out everybody else behind it.
 *
 * This is a different thing and the trade lands the other way. It is not a
 * lockout — an emailed sign-in link is unaffected by this counter, so a throttled
 * caller always has a way in that is not guessable — and without an address key
 * there is nothing at all metering a spray across many accounts. So: strangers
 * behind one NAT can slow each other's *password form* down, and they can still
 * sign in the ordinary way while it lasts.
 *
 * ## Why escalating rather than a fixed window
 *
 * A fixed window is waited out. Fifteen minutes of quiet and the attacker starts
 * again at full rate, for ever, which is what is happening now. Doubling the
 * penalty each time prices out persistence — a minute, then two, then an hour,
 * then a day — while somebody who fat-fingered a password five times is forgiven
 * in a minute and forgiven entirely the moment they sign in.
 *
 * ## Why in this process's memory
 *
 * Because the endpoint being defended is the one that must not grow a database
 * round trip: a limiter that needs Postgres to tell an attacker "no" hands the
 * attacker the load it was built to prevent. One web instance sees every request
 * today. A deploy forgives everyone, which is the right direction to err on a
 * public sign-in page.
 */

/** Attempts allowed from one caller in a quiet period before the penalty starts. */
const FREE_ATTEMPTS = 8;

/** The first penalty. Doubles with each subsequent trip. */
const BASE_LOCK_MS = 60 * 1000;

/**
 * The ceiling on a single lock.
 *
 * A day, because the point is to make persistence pointless rather than to ban
 * anybody: one address can be a whole office or a mobile carrier's NAT, and a
 * permanent block on a public sign-in page eventually catches a real person with
 * no way to appeal it.
 */
const MAX_LOCK_MS = 24 * 60 * 60 * 1000;

/**
 * How long a caller must be quiet before its strikes are forgotten.
 *
 * **Must be longer than `MAX_LOCK_MS`.** If it is shorter, a caller that earned
 * the longest lock comes back the moment it expires to find its strikes already
 * decayed, so the penalty can never grow past that point and the escalation
 * flattens into the fixed window this was built instead of. Two days against a
 * one-day ceiling, so waiting out even the longest lock is not by itself enough
 * to be forgiven. `the penalty keeps escalating` covers this; keep that test.
 */
const DECAY_MS = 48 * 60 * 60 * 1000;

/** The key space is the internet, so it needs a bound. */
const MAX_TRACKED = 50_000;

/** @type {Map<string, { strikes: number, lockedUntil: number, lastAt: number }>} */
const seen = new Map();

/** @param {number} now */
function sweep(now) {
  for (const [key, entry] of seen) {
    if (entry.lockedUntil <= now && now - entry.lastAt > DECAY_MS) seen.delete(key);
  }

  // Still over after dropping everything expired: shed oldest-inserted first
  // rather than grow without limit. Map preserves insertion order.
  if (seen.size > MAX_TRACKED) {
    let dropped = 0;
    const excess = seen.size - MAX_TRACKED;
    for (const key of seen.keys()) {
      seen.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * The address a request came from.
 *
 * Railway terminates TLS in front of the app, so the socket peer is always the
 * proxy and the caller is the first entry of `x-forwarded-for` — only the first,
 * because everything after it was written by whatever sat in between and a
 * caller can put whatever it likes there.
 *
 * Note the failure mode of getting this wrong: every visitor collapses to one
 * identity and the first eight requests in the world lock out the planet. Which
 * is why an unknown caller is not tracked at all — see `check`.
 *
 * @param {import('hono').Context} c
 * @returns {string|null}
 */
export function callerAddress(c) {
  const forwarded = c.req.header('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  return first || c.req.header('x-real-ip') || null;
}

/**
 * Count one attempt from `identity` and say whether it may proceed.
 *
 * A locked caller is not charged another strike for knocking. The penalty
 * escalates once per lock earned, not once per request refused — otherwise a
 * script hammering every second reaches the day-long ceiling in under a minute
 * and a person retrying twice is treated exactly like it.
 *
 * @param {string} identity
 * @param {number} [now] injectable clock, for tests
 * @returns {{ ok: boolean, retryAfter: number, strikes: number, lockedUntil: number }}
 */
export function attempt(identity, now = Date.now()) {
  if (seen.size >= MAX_TRACKED) sweep(now);

  const entry = seen.get(identity) ?? { strikes: 0, lockedUntil: 0, lastAt: now };

  if (entry.lockedUntil > now) {
    entry.lastAt = now;
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil((entry.lockedUntil - now) / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: entry.lockedUntil,
    };
  }

  // Quiet for long enough: start again rather than carrying a grudge for ever.
  if (now - entry.lastAt > DECAY_MS) entry.strikes = 0;

  entry.strikes += 1;
  entry.lastAt = now;

  if (entry.strikes > FREE_ATTEMPTS) {
    const over = entry.strikes - FREE_ATTEMPTS - 1;
    // Shift rather than Math.pow, and clamped, so a long-lived offender cannot
    // overflow to Infinity on its way to the ceiling.
    const lock = Math.min(BASE_LOCK_MS * 2 ** Math.min(over, 40), MAX_LOCK_MS);
    entry.lockedUntil = now + lock;
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil(lock / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: entry.lockedUntil,
    };
  }

  seen.set(identity, entry);
  return { ok: true, retryAfter: 0, strikes: entry.strikes, lockedUntil: 0 };
}

/**
 * Forget a caller, on proof that it was not the thing being defended against.
 *
 * Called when a sign-in actually succeeds. Whoever just proved they hold the
 * credential is not who this is for, and the attempts before it were somebody
 * mistyping rather than an attack.
 *
 * @param {string} identity
 */
export function forgive(identity) {
  seen.delete(identity);
}

/** Forget everyone. Test seam — never call this from a request path. */
export function reset() {
  seen.clear();
}

export const LIMITS = { FREE_ATTEMPTS, BASE_LOCK_MS, MAX_LOCK_MS, DECAY_MS, MAX_TRACKED };
