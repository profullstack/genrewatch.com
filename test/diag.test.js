import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * What a television can actually do, measured rather than guessed.
 *
 * A Fire TV showed no notification toggle here and on the sibling brand, and
 * nothing published about Silk settles why -- its Chromium version varies by
 * device and by year. So the device answers for itself.
 *
 * The three files are byte-identical to the sibling's copy and this test is the
 * sibling's minus the multiview half, which this brand does not have. A fix
 * crosses as a `cp`.
 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');

describe('the diagnostics page', () => {
  const html = read('../apps/web/public/diag.html');
  const js = read('../apps/web/public/diag.js');
  const css = read('../apps/web/public/diag.css');

  test('depends on nothing the pages it measures depend on', () => {
    // The whole point: if app.js will not parse on this browser, a diagnostics
    // page that loads app.js is broken in the same way and reports nothing.
    expect(html).not.toContain('/app.js');
    expect(html).not.toContain('/styles.css');
    expect(html).toContain('href="/diag.css"');
    expect(html).toContain('src="/diag.js"');
  });

  test('carries no inline script or style, which the CSP forbids', () => {
    // script-src and style-src are both 'self' with no 'unsafe-inline', so an
    // inline block here would be silently dropped on the deployed site and the
    // page would render bare with no error a reader could act on.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toContain('<style');
    expect(html).not.toMatch(/\sstyle="/);
  });

  test('never asks for a permission', () => {
    // Probing whether push exists must not put a prompt on somebody's TV.
    expect(js).toContain('Notification.permission');
    expect(js).not.toContain('requestPermission');
  });

  test('reports the three things that decide whether the site works', () => {
    // Why the notification toggle hides itself.
    expect(js).toContain("has(window, 'PushManager')");
    expect(js).toContain('THIS is what hides the notification toggle');
    // Whether Play can work at all.
    expect(js).toContain("has(window, 'MediaSource')");
    expect(js).toContain('avc1.42E01E,mp4a.40.2');
    // Whether app.js can even be parsed by this engine.
    expect(js).toContain('optional chaining');
  });

  test('reads the remote rather than assuming its key codes', () => {
    expect(js).toContain("document.addEventListener('keydown'");
    expect(js).toContain('keyCode=');
  });

  test('is noindex: it is a tool, not a page', () => {
    expect(html).toContain('noindex');
  });

  test('says yes and no in words, not only in colour', () => {
    expect(js).toContain("'YES'");
    expect(js).toContain("'NO'");
    expect(css).toContain('.row.yes .v');
  });
});

describe('the diagnostics script, actually run', () => {
  /*
   * String-matching a file proves it says something; running it proves it works.
   *
   * diag.js touches a small, known set of globals, so a hand-rolled stub is
   * enough -- and it lets the test answer the question that matters: given a
   * browser with no push manager and no MediaSource, does the page report that
   * clearly, or does it throw and show nothing? A diagnostics page that crashes
   * on the device it is diagnosing is worse than no page.
   */
  const runWith = (env) => {
    const el = () => ({ innerHTML: '', textContent: '', disabled: false, addEventListener() {} });
    const nodes = { report: el(), keylog: el(), send: el(), 'send-msg': el() };
    const listeners = [];
    const sandbox = {
      document: {
        getElementById: (id) => nodes[id] ?? null,
        addEventListener: (type, fn) => listeners.push([type, fn]),
        ...env.document,
      },
      navigator: { userAgent: 'stub', language: 'en', maxTouchPoints: 0, ...env.navigator },
      screen: { width: 1920, height: 1080 },
      fetch: () => Promise.resolve({ ok: true, status: 200 }),
      ...env.window,
    };
    sandbox.window = sandbox;
    const src = readFileSync(
      new URL('../apps/web/public/diag.js', import.meta.url).pathname,
      'utf8',
    );
    const keys = Object.keys(sandbox);
    new Function(...keys, src)(...keys.map((k) => sandbox[k]));
    return { html: nodes.report.innerHTML, nodes, listeners };
  };

  test('reports a television honestly instead of throwing', () => {
    // No push manager, no MediaSource, no pointer: the Fire TV we are chasing.
    const { html } = runWith({
      window: {
        matchMedia: (q) => ({ matches: q.indexOf('none') !== -1 }),
        localStorage: {
          setItem() {
            throw new Error('blocked');
          },
        },
        devicePixelRatio: 1,
        innerWidth: 1920,
        innerHeight: 1080,
      },
      navigator: {},
    });
    expect(html).toContain('Push manager');
    expect(html).toContain('web push cannot work in this browser');
    expect(html).toContain('Play here cannot work at all');
    expect(html).toContain('none (remote or keyboard only)');
    // localStorage that throws must be reported, not crash the page.
    expect(html).toContain('the remembered tile set cannot persist');
  });

  test('reports a capable browser as capable', () => {
    const { html, listeners } = runWith({
      window: {
        matchMedia: () => ({ matches: false }),
        localStorage: { setItem() {}, removeItem() {} },
        PushManager: function PushManager() {},
        MediaSource: { isTypeSupported: () => true },
        BroadcastChannel: function BroadcastChannel() {},
        documentPictureInPicture: {},
        Notification: { permission: 'granted' },
        CSS: { supports: () => true },
        devicePixelRatio: 2,
        innerWidth: 1440,
        innerHeight: 900,
      },
      navigator: { serviceWorker: {} },
      document: { pictureInPictureEnabled: true, fullscreenEnabled: true },
    });
    expect(html).toContain('web push can work here');
    expect(html).toContain('H.264 + AAC');
    expect(html).toContain('granted');
    // The remote logger is armed on every device.
    expect(listeners.some(([type]) => type === 'keydown')).toBe(true);
  });
});

describe('the report endpoint', () => {
  const app = read('../apps/web/src/app.js');
  const route = app.slice(app.indexOf("app.post('/api/diag'"));
  const body = route.slice(0, route.indexOf('\n});'));

  test('is signed in only, so it is not an open pipe into the logs', () => {
    expect(body).toContain('requireUser(c)');
  });

  test('flattens newlines, or one report can forge a second log line', () => {
    expect(body).toContain('replace(/[\\r\\n]+/g');
    expect(body).toContain('.slice(0, 300)');
    expect(body).toContain('.slice(0, 60)');
  });

  test('is served as a plain asset, alongside its two files', () => {
    expect(app).toContain("['/diag', 'diag.html', 'text/html']");
    expect(app).toContain("['/diag.css', 'diag.css', 'text/css']");
    expect(app).toContain("['/diag.js', 'diag.js', 'text/javascript']");
  });
});
