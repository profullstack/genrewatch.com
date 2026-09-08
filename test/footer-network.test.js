import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { Layout } = await import('../apps/web/src/views/Layout.jsx');
const { dataSource, network } = await import('../packages/config/src/network.js');

/*
 * The footer only. Asserting over the whole document would let a canonical tag
 * or an og:url satisfy a test about what the footer links to.
 */
const footer = async (props) => {
  const out = (await Layout(props).toString()).toString();
  return out.slice(out.indexOf('<footer>'), out.indexOf('</footer>') + 9);
};

/*
 * The footer is the only thing on every page of every site, which makes it the
 * one place the network can be stated once and be true everywhere.
 *
 * The list is duplicated across two repos -- this one and the sibling that runs
 * tipoffwatch.com and watchnews.now from a brand table. Naming the domains here
 * rather than just counting them is what turns "a site was added on one side
 * only" into a failing test instead of a reader seeing a shorter network than
 * exists.
 */
describe('the network line', () => {
  test('names every site we run', () => {
    expect(network.map((s) => s.domain).sort()).toEqual([
      'genrewatch.com',
      'tipoffwatch.com',
      'watchnews.now',
    ]);
    expect(network.every((s) => s.url === `https://${s.domain}`)).toBe(true);
  });

  test('exactly one entry is this site', () => {
    const self = network.filter((s) => s.self);
    expect(self).toHaveLength(1);
    expect(self[0].domain).toBe('genrewatch.com');
  });

  test('links the siblings on any page', async () => {
    const out = await footer({ user: null, children: 'x' });
    expect(out).toContain('href="https://tipoffwatch.com"');
    expect(out).toContain('href="https://watchnews.now"');
  });

  /*
   * A link to where the reader already is, is noise -- but dropping the name
   * would make each site's footer a different list, which is how a reader stops
   * being able to tell these are one shop.
   */
  test('names this site without linking it', async () => {
    const out = await footer({ user: null, children: 'x' });
    expect(out).toContain('GenreWatch');
    expect(out).not.toContain('href="https://genrewatch.com"');
  });

  test('credits the data platform', async () => {
    const out = await footer({ user: null, children: 'x' });
    expect(out).toContain('Data furnished by');
    expect(out).toContain(`href="${dataSource.url}"`);
    expect(out).toContain('nichedb.dev');
  });
});
