import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const PUBLIC = new URL('../apps/web/public/', import.meta.url).pathname;
const SOURCES = [
  '../apps/web/src/views/Layout.jsx',
  '../apps/web/src/app.js',
  '../apps/web/public/sw.js',
].map((f) => new URL(f, import.meta.url).pathname);

/** Paths the server answers itself rather than reading straight from public/. */
const ROUTE_SERVED = new Map([
  ['/manifest.webmanifest', null], // generated JSON
  ['/sitemap.xml', null], // generated XML
  ['/favicon.ico', 'icons/favicon.ico'], // root alias for the generated icon
]);

async function referencedPaths() {
  const found = new Set();
  for (const file of SOURCES) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(
      /["'`](\/(?:icons\/[\w.-]+|[\w-]+\.(?:png|ico|svg|css|js|webmanifest)))["'`]/g,
    )) {
      found.add(m[1]);
    }
  }
  return found;
}

/**
 * Every static path the app hands a browser must resolve to something.
 *
 * The bug this guards: icon.svg was deleted but stayed referenced in five places --
 * the favicon link, the manifest, a static route, and the service worker's
 * notification icon and badge. Nothing failed to build, no test broke, and the only
 * symptom was a missing image plus two 404s on every push notification.
 */
describe('static asset references', () => {
  test('every referenced path exists on disk or is served by a known route', async () => {
    const referenced = await referencedPaths();
    expect(referenced.size).toBeGreaterThan(10);

    const missing = [...referenced].filter((p) => {
      if (ROUTE_SERVED.has(p)) {
        const backing = ROUTE_SERVED.get(p);
        return backing !== null && !existsSync(PUBLIC + backing);
      }
      return !existsSync(PUBLIC + p.replace(/^\//, ''));
    });
    expect(missing).toEqual([]);
  });

  test('nothing still points at the deleted icon.svg', async () => {
    for (const file of SOURCES) {
      expect(await readFile(file, 'utf8')).not.toContain('icon.svg');
    }
  });

  test('the header never links the source art, at either size', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    // logo.png is 436KB and favicon.png is 722KB. They are fine as source art and
    // absurd in a header -- linking either would download most of a megabyte on
    // every page load to draw a 40px mark.
    expect(layout).not.toContain("'logo.png'");
    expect(layout).not.toContain("'favicon.png'");
    expect(layout).not.toContain('"/logo.png"');
    expect(layout).not.toContain('"/favicon.png"');
    expect(layout).toContain('class="brand-logo"');
  });

  test('every image the header does link is small enough to be in a header', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    const files = [
      ...layout.matchAll(/assetUrl\('([\w.-]+\.(?:png|svg|webp))'\)/g),
      ...layout.matchAll(/src="\/([\w./-]+\.(?:png|svg|webp))"/g),
    ].map((m) => m[1]);

    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const { size } = await Bun.file(PUBLIC + f).stat();
      // A generous ceiling. The point is to catch the source art, not to police
      // a few KB either way.
      expect({ file: f, kb: Math.round(size / 1024) }).toMatchObject({ file: f });
      expect(size).toBeLessThan(100_000);
    }
  });

  test('the mark and the wordmark are both offered, so a phone gets the mark', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    /*
     * A <picture> rather than two <img>s toggled with CSS: a hidden <img> is still
     * downloaded, so display:none would cost the reader both files. The media
     * query is what makes the swap free.
     */
    expect(layout).toContain('<picture>');
    expect(layout).toContain('logo-mark.png');
    expect(layout).toContain('logo-wide.png');
    expect(layout).toMatch(/media="\(max-width:/);
  });

  test('the wordmark is gone but the name survives for screen readers', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    expect(layout).toContain('alt="GenreWatch"');
    expect(layout).not.toContain('<span>GenreWatch</span>');
  });
});

describe('a deploy must not serve yesterday markup', () => {
  /*
   * Pages are cached in Redis for 60-900 seconds and served byte-identical to
   * every signed-out visitor, so a deploy that changes markup keeps serving the
   * old markup until each key expires. A new header coming back as the old one on
   * the feeds page for a quarter of an hour is indistinguishable from the deploy
   * not having worked -- which is exactly how it read.
   */
  test('the web role clears the page cache before it listens', async () => {
    const main = await readFile(
      new URL('../apps/web/src/main.js', import.meta.url).pathname,
      'utf8',
    );
    expect(main).toContain('dropPageCache');
    const web = main.slice(main.indexOf("config.roles.includes('web')"));
    // Before Bun.serve, or the first requests still get the stale copy.
    expect(web.indexOf('dropPageCache()')).toBeLessThan(web.indexOf('Bun.serve'));
  });

  test('it scans rather than blocking Redis, and cannot fail the boot', async () => {
    const main = await readFile(
      new URL('../apps/web/src/main.js', import.meta.url).pathname,
      'utf8',
    );
    expect(main).toContain("'MATCH', 'page:*'");
    expect(main).not.toMatch(/connection\.keys\(/);
    const fn = main.slice(main.indexOf('async function dropPageCache'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('catch');
  });
});

describe('traffic counting', () => {
  const load = async (id) => {
    const saved = process.env.CRAWLPROOF_SITE_ID;
    if (id === undefined) delete process.env.CRAWLPROOF_SITE_ID;
    else process.env.CRAWLPROOF_SITE_ID = id;
    try {
      const { Layout } = await import(`../apps/web/src/views/Layout.jsx?a=${id}&t=${Date.now()}`);
      return (await Layout({ user: null, title: 'T', children: 'x' }).toString()).toString();
    } finally {
      if (saved === undefined) delete process.env.CRAWLPROOF_SITE_ID;
      else process.env.CRAWLPROOF_SITE_ID = saved;
    }
  };

  /*
   * No hardcoded id, ever.
   *
   * One baked into the source would mean every fork, staging copy and sibling
   * brand silently reporting its traffic into the same dashboard -- and the
   * numbers would be wrong in a way nobody would think to check, because
   * nothing looks broken.
   */
  test('no site id appears in the source', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    expect(layout).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  test('nothing is loaded when no id is configured', async () => {
    expect(await load(undefined)).not.toContain('crawlproof');
  });

  test('the script carries the id as data-site, which is how it finds itself', async () => {
    const out = await load('test-site-id');
    expect(out).toContain('https://crawlproof.com/stats.js');
    // The script reads document.currentScript.dataset.site; any other attribute
    // name loads it and counts nothing.
    expect(out).toMatch(/data-site="test-site-id"/);
  });

  /*
   * async in the head, not deferred at the end of the body: a view should be
   * counted even if the reader leaves before the document finishes, and async
   * means it still never delays first paint.
   */
  test('it is async, so it counts early without blocking paint', async () => {
    const out = await load('test-site-id');
    const tag = out.match(/<script[^>]*crawlproof[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('async');
    // In the head, where it can fire before a quick bounce.
    expect(out.indexOf('crawlproof')).toBeLessThan(out.indexOf('</head>'));
  });
});
