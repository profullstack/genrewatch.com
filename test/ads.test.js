import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const PAGES = new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname;
const LAYOUT = new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname;
const COMPONENTS = new URL('../apps/web/src/views/components.jsx', import.meta.url).pathname;

const load = async (slot, name, props) => {
  const saved = process.env.CRAWLPROOF_AD_SLOT;
  if (slot === undefined) delete process.env.CRAWLPROOF_AD_SLOT;
  else process.env.CRAWLPROOF_AD_SLOT = slot;
  try {
    const mod = await import(`../apps/web/src/views/${name}?s=${slot}&t=${Date.now()}`);
    return (await mod[props.component](props.args).toString()).toString();
  } finally {
    if (saved === undefined) delete process.env.CRAWLPROOF_AD_SLOT;
    else process.env.CRAWLPROOF_AD_SLOT = saved;
  }
};

describe('the ad runtime', () => {
  /*
   * The generated PR added `import Script from "next/script"` to a Hono app,
   * which fails the build outright -- the site would not have deployed at all.
   */
  test('no framework component is imported for it', async () => {
    const layout = await readFile(LAYOUT, 'utf8');
    expect(layout).not.toContain('next/script');
    expect(layout).toContain('https://crawlproof.com/ad.js');
  });

  /*
   * defer, not async. ad.js scans the DOM once at DOMContentLoaded and installs
   * no MutationObserver, so running before the document is parsed finds nothing
   * to fill and silently earns zero.
   */
  test('the script is deferred, because it scans once after parsing', async () => {
    const layout = await readFile(LAYOUT, 'utf8');
    const tag = layout.match(/<script[^>]*ad\.js[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('defer');
    expect(tag).not.toContain('async');
  });

  test('nothing loads when no slot is configured', async () => {
    const out = await load(undefined, 'Layout.jsx', {
      component: 'Layout',
      args: { user: null, title: 'T', children: 'x' },
    });
    expect(out).not.toContain('ad.js');
    expect(out).not.toContain('data-cp-ad');
  });

  test('no slot id is hardcoded, so a clone serves nobody else inventory', async () => {
    for (const f of [LAYOUT, COMPONENTS, PAGES]) {
      expect(await readFile(f, 'utf8')).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    }
  });
});

describe('what gets rendered, and where', () => {
  /*
   * The rule the whole placement rests on: ad.js bills an impression when it
   * FILLS a unit, at that single scan, with no visibility check. A unit hidden
   * by CSS, or clipped because it is wider than the viewport, is billed exactly
   * like one a person read.
   *
   * So only the formats that render correctly at every width are used --
   * text_link, which ad.js sets to 100%, and the 300x250 rectangle, which fits
   * inside the narrowest phone. The 728x90 and 320x50 banners would each need a
   * viewport test that ad.js gives no way to make.
   */
  test('only the two width-safe formats are used', async () => {
    const pages = await readFile(PAGES, 'utf8');
    const components = await readFile(COMPONENTS, 'utf8');
    const both = pages + components;
    expect(both).not.toContain('banner_728x90');
    expect(both).not.toContain('banner_320x50');
    expect(components).toContain('banner_300x250');
  });

  test('at most one unit per page', async () => {
    const pages = await readFile(PAGES, 'utf8');
    for (const m of pages.matchAll(/export const (\w+) = /g)) {
      const start = m.index ?? 0;
      const next = pages.indexOf('export const ', start + 10);
      const body = pages.slice(start, next > 0 ? next : undefined);
      const count = (body.match(/<Ad[\s/>]/g) ?? []).length;
      expect({ page: m[1], ads: count }).toEqual({ page: m[1], ads: Math.min(count, 1) });
    }
  });

  /*
   * Nothing on the pages someone reaches by signing in. Those are the ones a
   * reader is using rather than browsing, and an ad there is both worse to use
   * and worth less.
   */
  test('the signed-in pages carry none', async () => {
    const pages = await readFile(PAGES, 'utf8');
    for (const name of ['Following', 'Settings', 'SignIn', 'Channels', 'PushCheck']) {
      const start = pages.indexOf(`export const ${name} = `);
      if (start < 0) continue;
      const next = pages.indexOf('export const ', start + 10);
      const body = pages.slice(start, next > 0 ? next : undefined);
      expect({ page: name, ads: (body.match(/<Ad[\s/>]/g) ?? []).length }).toEqual({
        page: name,
        ads: 0,
      });
    }
  });

  test('a search with no results shows no unit', async () => {
    const pages = await readFile(PAGES, 'utf8');
    // Guarded on there being results, or the ad is the only thing on an empty
    // page -- and billed the same as one under a full list. `total` rather than
    // `length` since the page became five sections: a search that matched only a
    // genre still has something for the unit to sit under.
    expect(pages).toMatch(/results\.total > 0 \? <Ad/);
  });
});

describe('the unit itself', () => {
  test('is labelled and set aside, not dressed as content', async () => {
    const components = await readFile(COMPONENTS, 'utf8');
    expect(components).toContain('<aside');
    expect(components).toContain('ad-label');
    expect(components).toContain('aria-label');
  });

  /*
   * ad.js fills the unit after DOMContentLoaded. Without a reserved box the page
   * reflows and whatever the reader was looking at jumps down the screen.
   */
  test('the box is reserved so filling it does not shift the page', async () => {
    const css = await readFile(
      new URL('../apps/web/public/styles.css', import.meta.url).pathname,
      'utf8',
    );
    expect(css).toMatch(/\.ad-banner_300x250\s*\{[^}]*min-height/);
    expect(css).toMatch(/\.ad-text_link\s*\{[^}]*min-height/);
  });
});
