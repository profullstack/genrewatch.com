import { beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';

import { AUTH, attempt, callerAddress, LIMITS, reset, VIEW } from '../src/lib/auth-throttle.js';

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

/*
 * The gentler curve, on the page a real person looks at. The numbers are the
 * point of the test: a crawler at one a second is priced out inside a minute,
 * and somebody behind an office NAT gets thirty views and, at worst, an hour.
 */
describe('the sign-in PAGE has its own, wider allowance', () => {
  test('it is more forgiving than the credential endpoints', () => {
    expect(VIEW.FREE_ATTEMPTS).toBeGreaterThan(AUTH.FREE_ATTEMPTS);
    expect(VIEW.MAX_LOCK_MS).toBeLessThan(AUTH.MAX_LOCK_MS);
  });

  test('strikes still outlive the longest lock on this curve too', () => {
    expect(VIEW.DECAY_MS).toBeGreaterThan(VIEW.MAX_LOCK_MS);
  });

  test('thirty views are free, and the thirty-first waits a minute', () => {
    for (let i = 0; i < VIEW.FREE_ATTEMPTS; i += 1) {
      expect(attempt('v', 0, VIEW).ok).toBe(true);
    }
    expect(attempt('v', 0, VIEW).retryAfter).toBe(VIEW.BASE_LOCK_MS / 1000);
  });

  test('and it doubles from there, up to an hour', () => {
    let now = 0;
    for (let i = 0; i < VIEW.FREE_ATTEMPTS; i += 1) attempt('v', now, VIEW);

    const waits = [];
    for (let trip = 0; trip < 8; trip += 1) {
      const refused = attempt('v', now, VIEW);
      waits.push(refused.retryAfter);
      now = refused.lockedUntil + 1;
    }

    expect(waits).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600]);
  });

  /*
   * The curves share one map, so a caller locked out of the page must not also
   * be locked out of the form, or a crawler's strikes would land on a person.
   */
  test('the page counter is separate from the credential counters', () => {
    for (let i = 0; i < VIEW.FREE_ATTEMPTS + 1; i += 1) attempt('view:1.2.3.4', 0, VIEW);
    expect(attempt('password:1.2.3.4', 0).ok).toBe(true);
    expect(attempt('magic:1.2.3.4', 0).ok).toBe(true);
  });
});

/*
 * The user-agent block. AwarioBot was told to stop in robots.txt, re-read the
 * file, and kept fetching /login -- so it is refused outright.
 */
describe('a blocked crawler is refused before anything else runs', () => {
  const build = () => {
    const app = new Hono();
    let reached = 0;
    const BLOCKED_AGENTS = ['awariobot'];

    app.use('*', async (c, next) => {
      const ua = (c.req.header('user-agent') ?? '').toLowerCase();
      if (BLOCKED_AGENTS.some((bot) => ua.includes(bot))) {
        return c.text('Not available to this crawler.', 403);
      }
      return next();
    });
    app.get('/login', (c) => {
      reached += 1;
      return c.text('the page');
    });

    return { app, reached: () => reached };
  };

  const get = (app, ua) => app.request('/login', { headers: ua ? { 'user-agent': ua } : {} });

  test('AwarioBot gets a 403 and never reaches the page', async () => {
    const { app, reached } = build();
    const res = await get(
      app,
      'Mozilla/5.0 (compatible; AwarioBot/1.0; +https://awario.com/bots.html)',
    );
    expect(res.status).toBe(403);
    expect(reached()).toBe(0);
  });

  test('the match is case-insensitive, since a UA string is whatever it says', async () => {
    const { app } = build();
    expect((await get(app, 'AWARIOBOT/2.0')).status).toBe(403);
  });

  test('an ordinary browser is untouched', async () => {
    const { app, reached } = build();
    const res = await get(app, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15');
    expect(res.status).toBe(200);
    expect(reached()).toBe(1);
  });

  test('so is a request with no user agent at all', async () => {
    const { app } = build();
    expect((await get(app, null)).status).toBe(200);
  });
});
