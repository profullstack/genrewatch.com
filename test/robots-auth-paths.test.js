import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;
const LAYOUT = new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname;

/*
 * `Allow: /` with nothing excluded is an invitation to crawl the sign-in page,
 * and one SEO bot took it: /login was 47% of all requests to tipoffwatch,
 * fetched about once a second from a single address. The bot was behaving
 * correctly -- nobody had told it not to.
 */
describe('crawlers are kept off the auth pages', () => {
  test.each(['/login', '/signup', '/auth/', '/api/'])('robots.txt disallows %s', async (path) => {
    const src = await readFile(APP, 'utf8');
    const robots = src.slice(src.indexOf("app.get('/robots.txt'"));
    expect(robots.slice(0, 600)).toContain(`Disallow: ${path}`);
  });

  test('the sitemap is still offered', async () => {
    const src = await readFile(APP, 'utf8');
    expect(src).toContain('Sitemap: ${config.siteUrl}/sitemap.xml');
  });

  /*
   * robots.txt only helps a crawler that reads it, and only after it has already
   * found the link on every page of the site. nofollow is what stops a
   * well-behaved one following it there in the first place.
   */
  test('the sign-in link in the header is nofollow', async () => {
    const layout = await readFile(LAYOUT, 'utf8');
    const link = layout.slice(
      layout.indexOf('href="/login"') - 120,
      layout.indexOf('href="/login"') + 20,
    );
    expect(link).toContain('rel="nofollow"');
  });

  /*
   * A named group as well as the wildcard one. It did not obey the wildcard, so
   * this is documentation more than defence -- the user-agent block in app.js is
   * what actually stops it -- but a crawler that later starts behaving will read
   * this and comply without anybody having to remember why.
   */
  test('AwarioBot is named and disallowed everywhere', async () => {
    const src = await readFile(APP, 'utf8');
    const robots = src.slice(src.indexOf("app.get('/robots.txt'"));
    expect(robots.slice(0, 800)).toContain('User-agent: AwarioBot');
  });

  test('and it is refused outright, not merely asked nicely', async () => {
    const src = await readFile(APP, 'utf8');
    expect(src).toContain("BLOCKED_AGENTS = ['awariobot']");
  });
});
