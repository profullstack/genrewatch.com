import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { attempt, callerAddress, MISS, reset, VIEW } from '../src/lib/auth-throttle.js';

const { FREE_ATTEMPTS, BASE_LOCK_MS } = MISS;

beforeEach(() => reset());

/*
 * The wiring, which is the part that matters. `app.notFound()` is the single
 * handler every unrouted path funnels into, so metering there is what turns
 * hundreds of free probes into twenty-five and then a refusal.
 */
describe('the not-found handler meters a caller that keeps missing', () => {
  const build = () => {
    const app = new Hono();
    let rendered = 0;

    app.get('/real', (c) => c.text('here'));
    app.notFound((c) => {
      const caller = callerAddress(c);
      if (caller) {
        const verdict = attempt(`miss:${caller}`, Date.now(), MISS);
        if (!verdict.ok) {
          c.header('retry-after', String(verdict.retryAfter));
          c.header('cache-control', 'no-store');
          return c.text('Too many requests.', 429);
        }
      }
      rendered += 1;
      return c.html('<p>not found</p>', 404);
    });

    return { app, rendered: () => rendered };
  };

  const miss = (app, path = '/wp-json/batch/v1') =>
    app.request(path, { headers: { 'x-forwarded-for': '195.178.110.155' } });

  test('the first misses are answered with an ordinary 404', async () => {
    const { app } = build();
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) {
      expect((await miss(app)).status).toBe(404);
    }
  });

  test('and then it is refused, without rendering the page', async () => {
    const { app, rendered } = build();
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) await miss(app);

    const res = await miss(app);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(BASE_LOCK_MS / 1000));
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Refusing has to be cheaper than answering, or a limiter on a flood is
    // just a slower way to serve the flood.
    expect(rendered()).toBe(FREE_ATTEMPTS);
  });

  /*
   * The property that makes this safe to turn on at all, and the reason the
   * counter lives in the not-found handler rather than in front of the router.
   * Everything a locked caller asks for that actually EXISTS is still served.
   */
  test('a locked caller is still served every route that exists', async () => {
    const { app } = build();
    for (let i = 0; i < FREE_ATTEMPTS + 1; i += 1) await miss(app);
    expect((await miss(app)).status).toBe(429);

    const real = await app.request('/real', {
      headers: { 'x-forwarded-for': '195.178.110.155' },
    });
    expect(real.status).toBe(200);
    expect(await real.text()).toBe('here');
  });

  test('one scanner does not spend another caller allowance', async () => {
    const { app } = build();
    for (let i = 0; i < FREE_ATTEMPTS + 1; i += 1) await miss(app);
    expect((await miss(app)).status).toBe(429);

    const other = await app.request('/also-missing', {
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect(other.status).toBe(404);
  });

  /*
   * Behind Railway there is always a forwarded address, so this only fires for
   * something reaching the app directly -- and bucketing those together under
   * one placeholder would let the first twenty-five of them refuse the rest.
   */
  test('a caller with no forwarded address is not thrown in with everyone else', async () => {
    const { app } = build();
    for (let i = 0; i < FREE_ATTEMPTS * 3; i += 1) {
      expect((await app.request('/nope')).status).toBe(404);
    }
  });

  /*
   * The buckets are namespaced so that a scanner burning its miss allowance
   * cannot also close the sign-in page, and vice versa.
   */
  test('the miss bucket is separate from the auth buckets', async () => {
    const { app } = build();
    for (let i = 0; i < FREE_ATTEMPTS + 1; i += 1) await miss(app);
    expect((await miss(app)).status).toBe(429);

    expect(attempt('view:195.178.110.155', Date.now(), VIEW).ok).toBe(true);
  });
});
