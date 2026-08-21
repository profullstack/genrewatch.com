import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

// Only pages.jsx, deliberately. Importing Layout.jsx directly pulls @genre/config
// into this file's module graph before payments.test.js can set its secret, and that
// suite then fails depending on which other files ran -- a nasty thing to leave lying
// around for the next person.
const { About, PushCheck } = await import('../apps/web/src/views/pages.jsx');

const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;
const CHECK_JS = new URL('../apps/web/public/push-check.js', import.meta.url).pathname;

const render = async (node) => (await node.toString()).toString();

describe('notification self-check page', () => {
  test('loads its own script, and only it does', async () => {
    const out = await render(PushCheck({ user: null, vapidKey: 'k' }));
    expect(out).toContain('src="/push-check.js"');

    // Every other page must stay clear of it: a support tool that ships on all
    // routes is just weight on every page load.
    const plain = await render(
      About({ user: null, stats: { genres: 0, subjects: 0, upcoming: 0 } }),
    );
    expect(plain).not.toContain('push-check.js');
  });

  test('carries the server key, or it cannot test anything', async () => {
    const out = await render(PushCheck({ user: null, vapidKey: 'BDU8swQU' }));
    expect(out).toContain('window.__VAPID = "BDU8swQU"');
  });

  test('the route is open to signed-out visitors', async () => {
    const src = await readFile(APP, 'utf8');
    const route = src.slice(
      src.indexOf("app.get('/push-check'"),
      src.indexOf("app.post('/api/push/diag'"),
    );
    // requireUser here would put an account between someone and the answer, for a
    // failure that happens entirely in the browser.
    expect(route).not.toContain('requireUser');
    expect(route).toContain('config.push.publicKey');
  });

  test('the script is actually served', async () => {
    const src = await readFile(APP, 'utf8');
    expect(src).toContain("['/push-check.js', 'push-check.js', 'text/javascript']");
  });

  test('the diagnostic endpoint bounds what it logs', async () => {
    const src = await readFile(APP, 'utf8');
    const route = src.slice(src.indexOf("app.post('/api/push/diag'"));
    // Unauthenticated and unbounded is a log-flooding tool.
    expect(route.slice(0, 400)).toContain('.slice(0, 600)');
  });

  test('a hang and a refusal are reported as different things', async () => {
    const src = await readFile(CHECK_JS, 'utf8');
    // The whole point of the page: "never answered" and "refused" have different
    // causes, and only one of them is ours to fix.
    expect(src).toContain('never answered');
    expect(src).toContain('refused');
    expect(src).toContain('brave://settings/privacy');
  });
});
