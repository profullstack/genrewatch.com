import { beforeEach, describe, expect, test } from 'bun:test';

import { AUTH, attempt, MISS, reset, VIEW } from '../apps/web/src/lib/auth-throttle.js';

const { FREE_ATTEMPTS, MAX_LOCK_MS, DECAY_MS } = MISS;

beforeEach(() => reset());

/*
 * The curve itself. The escalation is the shared machinery already covered by
 * auth-backoff.test.js, so what is worth pinning here is the shape of MISS:
 * far wider than the curve in front of a credential, because unlike that one it
 * can be tripped by a caller who has done nothing wrong.
 */
describe('the miss curve', () => {
  test('it is far more forgiving than the curve guarding a credential', () => {
    expect(FREE_ATTEMPTS).toBeGreaterThan(AUTH.FREE_ATTEMPTS * 2);
  });

  test('and no stricter than the curve guarding a page a person reads', () => {
    expect(MAX_LOCK_MS).toBe(VIEW.MAX_LOCK_MS);
    expect(DECAY_MS).toBe(VIEW.DECAY_MS);
  });

  /*
   * The number is not arbitrary. Measured over a day of both sites' logs, the
   * busiest caller producing 404s that was not a scanner managed twenty, working
   * through dead links from an old blog. Drop the allowance to twenty or below
   * and that caller starts being refused.
   */
  test('the allowance clears the busiest innocent caller ever measured', () => {
    expect(FREE_ATTEMPTS).toBeGreaterThan(20);
  });

  test('an hour is the worst a false positive can cost', () => {
    expect(MAX_LOCK_MS).toBe(60 * 60 * 1000);
  });

  /*
   * The invariant the whole escalation rests on: a decay shorter than the
   * ceiling and a caller who waits out the longest lock finds its strikes
   * already forgotten, so the penalty can never reach the ceiling.
   */
  test('strikes outlive the longest possible lock', () => {
    expect(DECAY_MS).toBeGreaterThan(MAX_LOCK_MS);
  });

  test('the penalty doubles across locks that were waited out', () => {
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) attempt('miss:a', 0, MISS);

    const waits = [];
    let now = 0;
    for (let trip = 0; trip < 4; trip += 1) {
      const refused = attempt('miss:a', now, MISS);
      expect(refused.ok).toBe(false);
      waits.push(refused.retryAfter);
      now = refused.lockedUntil + 1;
    }

    expect(waits).toEqual([60, 120, 240, 480]);
  });
});
