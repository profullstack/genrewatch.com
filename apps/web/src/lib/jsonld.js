import { config } from '@genre/config';
import { watchSourcesOf } from './watch-sources.js';

/**
 * Structured data, as plain objects.
 *
 * Builders here, rendering in the Layout. Keeping them apart is what lets a test
 * assert the shape of a fixture's markup without rendering a page, and it keeps
 * the escaping decision (below) in exactly one place.
 *
 * Only the watch listing so far. The sibling site publishes an Organization, a
 * WebSite, the event itself and its breadcrumb trail, and porting those here is
 * worth doing -- but a list of where a film can be watched is the one an answer
 * engine is actually asked for, and it is the one the page rendered as prose.
 */

const url = (path) => `${config.siteUrl}${path}`;

/**
 * Serialise for embedding in a <script> data block.
 *
 * `</script>` inside a string value would end the element early and drop the rest
 * of the page into the document as text; escaping `<` is the whole fix and it has
 * to happen on every value, which is why nothing else builds this string.
 */
export const serialise = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

/** What each way of getting at a title is, in schema.org's vocabulary. */
const CATEGORY = {
  flatrate: 'subscription',
  rent: 'rental',
  buy: 'purchase',
};

/**
 * "Where to watch", said in the vocabulary an answer engine reads.
 *
 * The single most-asked question about a release is where it can be watched, and
 * until now the only machine-readable thing on the page was nothing at all: the
 * providers were rendered as a run of names joined with a separator, so the
 * question could be answered from this page only by an engine willing to guess at
 * prose.
 *
 * Each entry is an `Offer` on the title, with `category` saying whether it is
 * included in a subscription, a rental or a purchase. No `price`: TMDB gives us
 * the storefront and not what it charges, and a price is the one field here that
 * would be believed if we invented it.
 *
 * EVERY source, in the order they render -- subscription first, then rental, then
 * purchase. `itemListOrder` says the order carries no ranking, because it carries
 * a kind and nothing else.
 *
 * The listing is US-only, which is what TMDB gives us and what `eligibleRegion`
 * says out loud. A provider list with no country attached is the one way this
 * markup could mislead, and it is the same reason the sibling site's broadcaster
 * entries each name a country.
 */
export const watchListNode = (event, detail) => {
  const sources = watchSourcesOf(detail);
  if (sources.length === 0) return null;

  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': url(`/events/${event.id}#watch`),
    name: `Where to watch ${event.name}`,
    itemListOrder: 'https://schema.org/ItemListUnordered',
    numberOfItems: sources.length,
    itemListElement: sources.map((source, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Offer',
        category: CATEGORY[source.kind],
        seller: { '@type': 'Organization', name: source.name },
        eligibleRegion: { '@type': 'Country', name: 'United States' },
        availability: 'https://schema.org/InStock',
      },
    })),
  };
};
