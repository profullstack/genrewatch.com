import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;

describe('html rendering', () => {
  test('render() emits a doctype', async () => {
    const { render } = await import('../apps/web/src/app.js');
    const out = await render({ toString: () => '<html lang="en"></html>' });
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  /**
   * The regression this exists for: hono/jsx emits no doctype, so a page served
   * straight from c.html() renders in quirks mode. It went unnoticed across every
   * route until the served bytes were actually read.
   */
  test('no route hands raw JSX to c.html()', async () => {
    const src = await readFile(APP, 'utf8');

    // c.html( followed by a JSX element rather than a string or a render() call.
    const offenders = [...src.matchAll(/c\.html\(\s*\n?\s*<[A-Z]/g)];
    expect(offenders.map((m) => src.slice(m.index, m.index + 60))).toEqual([]);
  });

  test('every JSX element reaching c.html goes through render()', async () => {
    const src = await readFile(APP, 'utf8');
    // Each c.html( call must be followed, within a short window, by render( or a
    // plain variable (the cache path, which already rendered).
    const calls = [...src.matchAll(/c\.html\(([\s\S]{0,40})/g)];
    expect(calls.length).toBeGreaterThan(5);
    for (const m of calls) {
      const head = m[1];
      // The cache path passes an already-rendered string through.
      const ok = /render\(/.test(head) || /^\s*(await produce\(\)|hit\)|body\))/.test(head);
      if (!ok) throw new Error(`c.html() without render(): ${JSON.stringify(head.slice(0, 50))}`);
    }
  });
});

/**
 * Fetching data and then not passing it to the view.
 *
 * The /events/:id handler awaited six values and rendered with two. Follow state,
 * the play-by-play log and the comments were all queried on every request and
 * silently dropped -- the page rendered its empty states instead, which is exactly
 * what an event with no comments looks like. Nothing failed.
 *
 * So: anything a route destructures out of its Promise.all has to be referenced
 * again somewhere in that handler.
 */
test('every value a route awaits is actually used', async () => {
  const source = await Bun.file(new URL('../apps/web/src/app.js', import.meta.url).pathname).text();

  // Each `const [a, b] = await Promise.all([...])` and the handler body after it.
  const pattern = /const \[([^\]]+)\] = await Promise\.all\(\[/g;
  const unused = [];

  for (const match of source.matchAll(pattern)) {
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    // The handler ends at the next top-level `app.` route registration.
    const after = source.slice(match.index + match[0].length);
    const end = after.search(/\napp\.(get|post|put|delete)\(/);
    const body = end === -1 ? after : after.slice(0, end);
    // Skip the destructuring line itself so a name does not match its own declaration.
    const rest = body.slice(body.indexOf(']'));

    for (const name of names) {
      if (!new RegExp(`\\b${name}\\b`).test(rest)) unused.push(name);
    }
  }

  expect(unused).toEqual([]);
});

/**
 * The analytics tag lives in the shared layout, so it is on every page or on none.
 *
 * Worth a test because a missing tag is invisible from the site itself: pages look
 * perfect and the dashboard simply stays at zero, which reads as "no traffic"
 * rather than as a bug. The site id is asserted literally — a tag pointing at the
 * wrong property collects nothing and looks exactly the same.
 */
test('every page carries the crawlproof tracker', async () => {
  const layout = await readFile(
    new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
    'utf8',
  );

  expect(layout).toContain('https://crawlproof.com/stats.js');
  expect(layout).toContain('6b0f55e8-5760-430e-a988-ee04b7519d11');
  // async, or it blocks first paint on a third-party host.
  expect(/crawlproof\.com\/stats\.js"\s*\n?\s*async/.test(layout)).toBe(true);
});

/**
 * The kickoff line must read correctly with NO stylesheet at all.
 *
 * The stacked <time> has no whitespace between its spans -- it cannot, or a flex
 * container turns the gaps into stray anonymous items -- so anywhere the CSS did
 * not reach it rendered as "4:30 PMWed, Aug 19UTC". That happened on the event
 * page, and then happened again to readers holding an hour-old cached
 * stylesheet. Separators in the markup remove the dependency entirely.
 */
test('the kickoff time carries its own separators', async () => {
  const components = await readFile(
    new URL('../apps/web/src/views/components.jsx', import.meta.url).pathname,
    'utf8',
  );
  const pages = await readFile(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );
  const css = await readFile(
    new URL('../apps/web/public/styles.css', import.meta.url).pathname,
    'utf8',
  );

  // Real text between the parts, not a border or a flex gap.
  expect(components).toContain("{' \u00b7 '}");
  expect(components).toContain('data-tz-abbr');
  // Below the title, in its own stat block rather than squeezed into a column.
  expect(pages).toContain('<StartTime event={event} />');
  expect(pages).toContain('class="stat"');
  // And it must stay on one line, overriding the stacking default.
  expect(/time\.line \{[^}]*display: inline/s.test(css)).toBe(true);
  // The stacking default still exists for the schedule rows that rely on it.
  expect(/time\[data-local\] \{[^}]*flex-direction: column/s.test(css)).toBe(true);
  expect(css).toContain('.stats {');
});

/**
 * A CSS fix that nobody can see is not a fix.
 *
 * styles.css and app.js were linked by bare path and served with max-age=3600,
 * so a deploy did not reach anyone who had visited in the last hour -- their
 * browser kept the old stylesheet, and a shipped fix was indistinguishable from
 * one that had not worked. Hashing the contents into the URL means a new build
 * is a new URL.
 */
test('static assets are linked with a content version', async () => {
  const layout = await readFile(
    new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
    'utf8',
  );
  const app = await readFile(APP, 'utf8');

  // Linked through the helper, never by bare path. Quote-agnostic: the formatter
  // owns quote style, and asserting on it made a `biome --write` run look like a
  // caching regression.
  expect(layout).toMatch(/assetUrl\(['"]styles\.css['"]\)/);
  expect(layout).toMatch(/assetUrl\(['"]app\.js['"]\)/);
  expect(layout).not.toContain('href="/styles.css"');
  expect(layout).not.toContain('src="/app.js"');

  // And a versioned URL is worth caching hard, since its bytes cannot change.
  expect(app).toContain('max-age=31536000, immutable');
  // The service worker is the one thing that must never be pinned.
  expect(app).toContain("c.header('cache-control', 'no-cache')");
});

test('asset versions change when the file does', async () => {
  const { loadAssetVersions, assetUrl } = await import('../apps/web/src/lib/asset-version.js');
  await loadAssetVersions(['styles.css', 'app.js']);

  const css = assetUrl('styles.css');
  expect(css).toMatch(/^\/styles\.css\?v=[a-z0-9]+$/);
  // Two different files must not share a version, or one would mask the other.
  expect(assetUrl('app.js')).not.toBe(css.replace('styles.css', 'app.js'));
  // An asset that does not exist degrades to the bare path rather than throwing.
  expect(assetUrl('nope.css')).toBe('/nope.css');
});

/**
 * A stylesheet with an unclosed block is not a style bug, it is a cliff.
 *
 * Resolving a merge inside an @media block once dropped its closing brace, so
 * every rule after that point was silently nested inside a max-width query and
 * stopped applying at desktop width. Nothing errors — the browser just parses a
 * different stylesheet than the one that was written, and the page looks like a
 * dozen unrelated regressions at once.
 */
test('styles.css has balanced braces', async () => {
  const css = await readFile(
    new URL('../apps/web/public/styles.css', import.meta.url).pathname,
    'utf8',
  );
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const open = (code.match(/\{/g) ?? []).length;
  const close = (code.match(/\}/g) ?? []).length;
  expect({ open, close }).toEqual({ open: close, close });

  // And nothing may be left dangling inside a media query at the end of the file.
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
});
