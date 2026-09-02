import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Splitting the worker onto its own Railway service.
 *
 * The playlist refresh parses a 300,000-channel m3u in one go, and while it ran in
 * the same process as the HTTP server it starved it: the accept queue filled to
 * 513 connections, the edge reported "connection dial timeout", and the site 502'd
 * five to six minutes after every boot -- one refresh interval -- while the
 * deployment still reported SUCCESS the whole time.
 *
 * ROLES is what separates them, and the config comment promises the split is "a
 * variable change, not a code change". These tests are what makes that true.
 */
describe('roles', () => {
  const load = async (roles) => {
    const saved = process.env.ROLES;
    if (roles === null) delete process.env.ROLES;
    else process.env.ROLES = roles;
    try {
      const m = await import(`../packages/config/src/index.js?roles=${roles}-${Date.now()}`);
      return m.config.roles;
    } finally {
      if (saved === undefined) delete process.env.ROLES;
      else process.env.ROLES = saved;
    }
  };

  test('one service runs both, which is the shape that wedged', async () => {
    expect(await load(null)).toEqual(['web', 'worker']);
  });

  test('a worker-only service does not claim the web role', async () => {
    const roles = await load('worker');
    expect(roles).toEqual(['worker']);
    // The bit main.js branches on: no web role means no app server, so that
    // container has to answer /healthz some other way or its deploy never passes.
    expect(roles.includes('web')).toBe(false);
  });

  test('a web-only service runs no queue workers', async () => {
    const roles = await load('web');
    expect(roles).toEqual(['web']);
    expect(roles.includes('worker')).toBe(false);
  });

  test('spacing round the comma is not a third role', async () => {
    expect(await load(' web , worker ')).toEqual(['web', 'worker']);
  });
});

/**
 * A worker-only container still answers the probe.
 *
 * `railway.json` sets `healthcheckPath: /healthz` for every service built from this
 * repo, and Railway's config-as-code wins over anything set per service. So a
 * ROLES=worker container with no listener would wait out its healthcheck timeout
 * and be marked failed -- which would make the split impossible to deploy at all.
 */
describe('the worker healthcheck listener', () => {
  test('main.js serves /healthz when it is not running the web role', async () => {
    const src = await Bun.file(new URL('../apps/web/src/main.js', import.meta.url).pathname).text();
    const branch = src.slice(src.indexOf("if (config.roles.includes('web'))"));
    expect(branch).toContain('} else {');
    expect(branch).toContain("'/healthz'");
    expect(branch).toContain('[worker] healthcheck on');
  });

  test('and it is not the app: the worker mounts no routes', async () => {
    const src = await Bun.file(new URL('../apps/web/src/main.js', import.meta.url).pathname).text();
    const branch = src.slice(src.indexOf("if (config.roles.includes('web'))"));
    const worker = branch.slice(branch.indexOf('} else {'));
    // app.fetch belongs to the web branch above; handing it to the worker would put
    // every route -- and the page cache and the database behind them -- back in the
    // process the split exists to keep clear of them.
    expect(worker).not.toContain('app.fetch');
  });
});
