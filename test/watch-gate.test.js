import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;

/**
 * The access policy, pinned: watching needs an account, reading never does.
 *
 * This is asserted against the source rather than a live server because the rule is
 * about which routes call requireUser, and that is exactly the kind of thing a
 * later refactor silently inverts -- an ungated /watch would be a leak the moment
 * anything real sits behind it, and a gated /leagues would quietly delete the whole
 * point of the site being free.
 */

/**
 * Comments are stripped first, and that is load-bearing rather than tidiness.
 *
 * A handler is sliced up to the next route, which means it also picks up the doc
 * comment sitting above that route -- and the comment above /watch explains what
 * requireUser does. Reading it as code made the event page look gated when it is
 * not, so the assertions have to see code only.
 */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** The body of one `app.get('<path>', ...)` handler, up to the next route. */
function handler(src, path) {
  const code = codeOnly(src);
  const start = code.indexOf(`app.get('${path}'`);
  if (start < 0) return null;
  const next = code.indexOf('\napp.', start + 1);
  return code.slice(start, next < 0 ? code.length : next);
}

describe('watching requires a login', () => {
  test('the watch route exists at all', async () => {
    // It did not, for as long as the event page had linked to it: the "Open the
    // stream" call to action 404'd for every buyer who clicked it.
    const src = await readFile(APP, 'utf8');
    expect(handler(src, '/events/:id/watch')).not.toBeNull();
  });

  test('it demands a user before anything else', async () => {
    const src = await readFile(APP, 'utf8');
    const h = handler(src, '/events/:id/watch');
    expect(h).toContain('requireUser(c)');
    // Before the entitlement lookup, so a signed-out visitor is redirected rather
    // than having their (absent) id used in a query.
    expect(h.indexOf('requireUser(c)')).toBeLessThan(h.indexOf('activeEntitlement'));
  });

  test('a signed-in visitor still needs an entitlement', async () => {
    const src = await readFile(APP, 'utf8');
    const h = handler(src, '/events/:id/watch');
    expect(h).toContain('activeEntitlement');
    expect(h).toContain('if (!entitlement)');
  });

  test('buying requires a login too', async () => {
    const src = await readFile(APP, 'utf8');
    const start = src.indexOf("app.post('/api/events/:id/buy'");
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 400)).toContain('requireUser(c)');
  });
});

describe('everything that is data stays free', () => {
  const PUBLIC = [
    '/',
    '/sports',
    '/sports/:sport',
    '/leagues/:slug',
    '/teams/:slug',
    '/events/:id',
    '/about',
    '/feeds',
    '/feeds/all.xml',
    '/api/v1',
    '/api/v1/sports',
    '/api/v1/leagues',
    '/api/v1/events',
    '/sitemap.xml',
  ];

  test('no read-only route asks for an account', async () => {
    const src = await readFile(APP, 'utf8');
    const gated = PUBLIC.filter((p) => (handler(src, p) ?? '').includes('requireUser'));
    expect(gated).toEqual([]);
  });

  test('the event page is readable signed out, offers and all', async () => {
    const src = await readFile(APP, 'utf8');
    const h = handler(src, '/events/:id');
    // c.get('user') rather than requireUser: the page renders either way and simply
    // shows different controls.
    expect(h).toContain("c.get('user')");
    expect(h).not.toContain('requireUser');
  });
});

describe('the stream slot is never rendered', () => {
  test('provider_ref does not reach any view', async () => {
    // It identifies the upstream slot the seller is reselling. In the HTML it would
    // be that slot's credentials, handed to everyone who bought a ticket.
    // Code only: the comment on WatchPage names the column precisely so the next
    // person knows why it is absent, and that explanation must not fail the check
    // that enforces it.
    const views = new URL('../apps/web/src/views/', import.meta.url).pathname;
    for (const f of ['pages.jsx', 'components.jsx']) {
      expect(codeOnly(await readFile(views + f, 'utf8'))).not.toContain('provider_ref');
    }
  });
});
