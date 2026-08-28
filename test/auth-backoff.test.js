import { beforeEach, describe, expect, test } from 'bun:test';

import {
  attempt,
  callerAddress,
  forgive,
  LIMITS,
  reset,
} from '../apps/web/src/lib/auth-throttle.js';

const { FREE_ATTEMPTS, BASE_LOCK_MS, MAX_LOCK_MS, DECAY_MS } = LIMITS;

beforeEach(() => reset());

describe('the escalating counter', () => {
  test('the first attempts are free, so a person who mistypes is not punished', () => {
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) {
      expect(attempt('a', 1000).ok).toBe(true);
    }
  });

  test('the one after that is refused, and says how long for', () => {
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) attempt('a', 1000);

    const refused = attempt('a', 1000);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfter).toBe(BASE_LOCK_MS / 1000);
  });

  /*
   * The whole reason this exists rather than a fixed window: waiting out the
   * penalty and starting again has to cost more each time, or the attacker just
   * does that for ever.
   */
  test('the penalty keeps escalating across locks that were waited out', () => {
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) attempt('a', 0);

    const waits = [];
    let now = 0;
    for (let trip = 0; trip < 5; trip += 1) {
      const refused = attempt('a', now);
      expect(refused.ok).toBe(false);
      waits.push(refused.retryAfter);
      // Wait exactly as long as told, then knock again.
      now = refused.lockedUntil + 1;
    }

    expect(waits).toEqual([60, 120, 240, 480, 960]);
  });

  /*
   * This is the bug the rssamplifier version shipped with: a decay shorter than
   * the ceiling means a caller who waits out the longest lock finds its strikes
   * already forgotten, so the penalty can never reach the ceiling and the whole
   * thing collapses back into a fixed window.
   */
  test('strikes outlive the longest possible lock', () => {
    expect(DECAY_MS).toBeGreaterThan(MAX_LOCK_MS);
  });

  test('the penalty is capped, so this is never a permanent ban', () => {
    let now = 0;
    for (let i = 0; i < FREE_ATTEMPTS + 60; i += 1) {
      const r = attempt('a', now);
      now = r.ok ? now : r.lockedUntil + 1;
    }

    const refused = attempt('a', now);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfter).toBe(MAX_LOCK_MS / 1000);
    expect(Number.isFinite(refused.retryAfter)).toBe(true);
  });

  /*
   * A script hammering every second must not reach the day-long ceiling in a
   * minute, or a person retrying twice while locked gets the same sentence.
   */
  test('knocking while locked does not lengthen the lock', () => {
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) attempt('a', 0);
    const first = attempt('a', 0);

    for (let i = 0; i < 500; i += 1) attempt('a', 1000 + i);

    const still = attempt('a', 2000);
    expect(still.lockedUntil).toBe(first.lockedUntil);
  });

  test('a quiet caller is forgiven', () => {
    for (let i = 0; i < FREE_ATTEMPTS + 1; i += 1) attempt('a', 0);
    expect(attempt('a', DECAY_MS * 2).ok).toBe(true);
  });

  test('signing in successfully wipes the slate', () => {
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) attempt('a', 0);
    forgive('a');
    expect(attempt('a', 0).ok).toBe(true);
  });

  test('callers are counted separately', () => {
    for (let i = 0; i < FREE_ATTEMPTS + 1; i += 1) attempt('a', 0);
    expect(attempt('b', 0).ok).toBe(true);
  });

  /*
   * Buckets are per-route on purpose: the throttled password form tells people
   * to use a sign-in link instead, so that advice has to still be true.
   */
  test('locking one route does not lock the others', () => {
    for (let i = 0; i < FREE_ATTEMPTS + 1; i += 1) attempt('password:1.2.3.4', 0);
    expect(attempt('magic:1.2.3.4', 0).ok).toBe(true);
    expect(attempt('passkey:1.2.3.4', 0).ok).toBe(true);
  });
});

describe('who the caller is', () => {
  const ctx = (headers) => ({ req: { header: (n) => headers[n] } });

  test('the first forwarded entry, because the rest is caller-supplied', () => {
    expect(callerAddress(ctx({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 10.0.0.2' }))).toBe(
      '9.9.9.9',
    );
  });

  /*
   * The failure mode of getting this wrong is that every visitor collapses into
   * one bucket and the first few requests in the world lock out everybody, so an
   * unidentifiable caller is not tracked at all.
   */
  test('no forwarded address means untracked, not one shared bucket', () => {
    expect(callerAddress(ctx({}))).toBe(null);
  });

  test('x-real-ip is the fallback', () => {
    expect(callerAddress(ctx({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
  });
});
