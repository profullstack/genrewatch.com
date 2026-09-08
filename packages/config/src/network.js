/**
 * Every site we run, for the footer of every one of them.
 *
 * The sibling repo derives this from its whitelabel brand table
 * (`packages/config/src/brands.js`), where each entry already carries a name and
 * a domain. This site is not built from that table -- it is its own repo -- so
 * the list is written out here instead and has to be kept in step by hand. Both
 * copies are checked by a test that names the domains, so a site added on one
 * side and forgotten on the other fails rather than quietly showing a reader a
 * shorter network than exists.
 *
 * `self` marks the site this deployment IS. The view names it without linking
 * it: a link to where you already are is noise, while leaving it out entirely
 * would make each footer a different list and lose the fact that these are one
 * shop.
 */
export const network = [
  { name: 'TipoffWatch', domain: 'tipoffwatch.com', url: 'https://tipoffwatch.com' },
  { name: 'GenreWatch', domain: 'genrewatch.com', url: 'https://genrewatch.com', self: true },
  { name: 'WatchNews', domain: 'watchnews.now', url: 'https://watchnews.now' },
];

/**
 * The house data platform, credited on the same line.
 *
 * Separate from the catalogue credit above it, which names the upstream a given
 * release actually came from and must stay accurate -- TMDB's terms require
 * their disclaimer verbatim. This one names the shop the data is furnished
 * through.
 */
export const dataSource = { name: 'nichedb.dev', url: 'https://nichedb.dev' };
