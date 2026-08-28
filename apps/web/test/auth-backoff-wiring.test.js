import { beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';

import { attempt, callerAddress, LIMITS, reset } from '../src/lib/auth-throttle.js';

const { FREE_ATTEMPTS, BASE_LOCK_MS } = LIMITS;

beforeEach(() => reset());

/*
 * The wiring, not the counter. Registering a middleware and a handler on the
 * same method and path relies on Hono running both in order -- if that were
 * wrong the throttle would silently never run, which is the one failure this
 * whole change cannot afford.
 */
describe('the middleware sits in front of the handler', () => {
  const build = () => {
    const app = new Hono();
    let handlerRuns = 0;

    app.post('/x', async (c, next) => {
      const verdict = attempt(`x:${callerAddress(c)}`);
      if (verdict.ok) return next();
      c.header('retry-after', String(verdict.retryAfter));
      return c.json({ error: 'slow down' }, 429);
    });
    app.post('/x', (c) => {
      handlerRuns += 1;
      return c.json({ ok: true });
    });

    return { app, runs: () => handlerRuns };
  };

  const post = (app) =>
    app.request('/x', { method: 'POST', headers: { 'x-forwarded-for': '5.5.5.5' } });

  test('it lets the free attempts through to the handler', async () => {
    const { app, runs } = build();
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) {
      expect((await post(app)).status).toBe(200);
    }
    expect(runs()).toBe(FREE_ATTEMPTS);
  });

  test('and then refuses with a 429 the handler never sees', async () => {
    const { app, runs } = build();
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) await post(app);

    const res = await post(app);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(BASE_LOCK_MS / 1000));
    // The expensive work behind the route did not run.
    expect(runs()).toBe(FREE_ATTEMPTS);
  });

  test('a caller with no forwarded address is not thrown in with everyone else', async () => {
    const app = new Hono();
    app.post('/x', async (c, next) => {
      const caller = callerAddress(c);
      if (!caller) return next();
      const verdict = attempt(`x:${caller}`);
      return verdict.ok ? next() : c.json({ error: 'slow down' }, 429);
    });
    app.post('/x', (c) => c.json({ ok: true }));

    for (let i = 0; i < FREE_ATTEMPTS * 3; i += 1) {
      expect((await app.request('/x', { method: 'POST' })).status).toBe(200);
    }
  });
});

/*
 * A shape check on app.js, in the style of http-lanes.test.js next door.
 *
 * The unit tests above prove the middleware works; this proves it is actually
 * ON the routes that need it. The failure it exists for is silent: somebody adds
 * the next unauthenticated auth route, forgets the backoff, and nothing anywhere
 * goes red -- the site just quietly grows a new unmetered way in.
 */
describe('every unauthenticated auth route is behind the backoff', () => {
  const APP = new URL('../src/app.js', import.meta.url).pathname;

  /*
   * The routes a stranger can reach. `/api/auth/password/set` is deliberately
   * absent: it needs a session already, so it is not a way in. So is logout.
   */
  const PROTECTED = [
    ['/api/auth/magic', "authBackoff('magic'"],
    ['/auth/magic', "authBackoff('token'"],
    ['/api/auth/password', "authBackoff('password'"],
    ['/api/auth/passkey/authenticate/options', 'passkeyBackoff'],
    ['/api/auth/passkey/authenticate/verify', 'passkeyBackoff'],
  ];

  test.each(PROTECTED)('%s has a backoff registered before its handler', async (route, marker) => {
    const src = await readFile(APP, 'utf8');
    const registration = src.indexOf(`'${route}',\n  ${marker}`);
    const withFactory = src.indexOf(`'${route}',\n  authBackoff(`);

    expect(registration >= 0 || withFactory >= 0 || src.includes(`'${route}', ${marker}`)).toBe(
      true,
    );
  });

  /*
   * The password route is the one that must refuse BEFORE the handler, because
   * the handler's cost is an argon2id verify. If the backoff were registered
   * after it, the throttle would meter the attack without stopping it paying for
   * itself.
   */
  test('the password backoff is registered before the password handler', async () => {
    const src = await readFile(APP, 'utf8');
    expect(src.indexOf("authBackoff('password'")).toBeLessThan(
      src.indexOf('const result = await auth.verifyPassword('),
    );
  });
});
