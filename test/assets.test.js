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
