import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { WATCH_KIND_LABEL, watchSourcesOf } = await import('../apps/web/src/lib/watch-sources.js');
const { serialise, watchListNode } = await import('../apps/web/src/lib/jsonld.js');
const { EventPage } = await import('../apps/web/src/views/pages.jsx');
/*
 * Read the origin back rather than pinning a host. config is a module-level
 * snapshot of the environment and `bun test` shares the module registry across
 * files, so whichever file imports it first decides SITE_URL for all of them.
 */
const { config } = await import('../packages/config/src/index.js');
const SITE = config.siteUrl;

const EVENT = {
  id: 7,
  name: 'Dune: Part Two',
  subject_slug: 'dune-part-two',
  subject_name: 'Dune',
  subject_id: 3,
  category: 'film',
  kind: 'release',
  starts_at: '2026-09-04T18:30:00Z',
  time_known: true,
  precision: 'day',
};

const WATCH = [
  { name: 'Max', kind: 'flatrate' },
  { name: 'Apple TV', kind: 'rent' },
  { name: 'Amazon Video', kind: 'buy' },
];

const render = async (detail) =>
  (
    await EventPage({
      user: null,
      event: { ...EVENT, detail },
      genres: [],
      comments: [],
      following: false,
    }).toString()
  ).toString();

/** Every ld+json block on a rendered page, parsed. */
const blocks = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1].replace(/\\u003c/g, '<')),
  );

describe('normalising where a title can be watched', () => {
  test('every source is carried, not just the subscriptions', () => {
    // The bug this exists to prevent: a film with no subscription home saying
    // nothing at all, rather than "you can rent it".
    const out = watchSourcesOf({ watch: WATCH });
    expect(out.map((s) => s.name)).toEqual(['Max', 'Apple TV', 'Amazon Video']);
    expect(out.map((s) => s.kind)).toEqual(['flatrate', 'rent', 'buy']);
  });

  test('cheapest access comes first whatever order the provider sent', () => {
    const out = watchSourcesOf({
      watch: [
        { name: 'Amazon Video', kind: 'buy' },
        { name: 'Max', kind: 'flatrate' },
        { name: 'Apple TV', kind: 'rent' },
      ],
    });
    expect(out.map((s) => s.kind)).toEqual(['flatrate', 'rent', 'buy']);
  });

  test('a service that both includes and rents a title is listed once', () => {
    // "Included with Amazon · Rent from Amazon" reads as a mistake even though
    // both are true.
    const out = watchSourcesOf({
      watch: [
        { name: 'Amazon Video', kind: 'flatrate' },
        { name: 'Amazon Video', kind: 'rent' },
      ],
    });
    expect(out).toEqual([{ name: 'Amazon Video', kind: 'flatrate' }]);
  });

  test('rows stored before this pass still render', () => {
    // `detail.watch` was an array of bare names, and only a re-sync turns a stored
    // row into the newer shape. Those names were always flat-rate.
    expect(watchSourcesOf({ watch: ['Netflix', 'Max'] })).toEqual([
      { name: 'Netflix', kind: 'flatrate' },
      { name: 'Max', kind: 'flatrate' },
    ]);
  });

  test('a title nobody carries is an empty list, not a throw', () => {
    expect(watchSourcesOf({})).toEqual([]);
    expect(watchSourcesOf(null)).toEqual([]);
    expect(watchSourcesOf({ watch: [] })).toEqual([]);
  });
});

describe('the listing as structured data', () => {
  test('every source is an item, and says which kind it is', () => {
    const node = watchListNode(EVENT, { watch: WATCH });
    expect(node['@type']).toBe('ItemList');
    expect(node['@id']).toBe(`${SITE}/events/7#watch`);
    expect(node.numberOfItems).toBe(3);
    expect(node.itemListElement.map((i) => i.item.category)).toEqual([
      'subscription',
      'rental',
      'purchase',
    ]);
    expect(node.itemListElement.map((i) => i.item.seller.name)).toEqual([
      'Max',
      'Apple TV',
      'Amazon Video',
    ]);
  });

  test('the region the listing is true in is named', () => {
    // TMDB gives us US availability. A provider list with no country attached is
    // the one way this markup could mislead.
    const node = watchListNode(EVENT, { watch: WATCH });
    expect(node.itemListElement[0].item.eligibleRegion.name).toBe('United States');
  });

  test('no price is published', () => {
    // TMDB gives the storefront and not what it charges, and a price is the one
    // field here that would be believed if we invented it.
    const node = watchListNode(EVENT, { watch: WATCH });
    for (const item of node.itemListElement) expect(item.item.price).toBeUndefined();
  });

  test('the order is declared as carrying no ranking', () => {
    expect(watchListNode(EVENT, { watch: WATCH }).itemListOrder).toBe(
      'https://schema.org/ItemListUnordered',
    );
  });

  test('a title nobody carries publishes no empty list', () => {
    // An ItemList with nothing in it is a claim that it cannot be watched at all.
    expect(watchListNode(EVENT, {})).toBeNull();
  });

  test('a value cannot end the script element early', () => {
    const out = serialise({ name: '</script><img onerror=alert(1)>' });
    expect(out).not.toContain('</script>');
    expect(JSON.parse(out.replace(/\\u003c/g, '<')).name).toBe('</script><img onerror=alert(1)>');
  });
});

describe('the listing on the page', () => {
  test('is a list, with every source and its kind', async () => {
    const html = await render({ watch: WATCH });
    expect(html).toContain('<ul class="watch-list">');
    for (const source of WATCH) {
      expect(html).toContain(source.name);
      expect(html).toContain(WATCH_KIND_LABEL[source.kind]);
    }
  });

  test('the markup and the page agree, name for name', async () => {
    // The rule: this says which visible fact is the service, it does not add one.
    const html = await render({ watch: WATCH });
    for (const item of watchListNode(EVENT, { watch: WATCH }).itemListElement) {
      expect(html).toContain(item.item.seller.name);
    }
  });

  test('reaches the page as one ld+json block', async () => {
    const found = blocks(await render({ watch: WATCH }));
    expect(found.map((b) => b['@type'])).toEqual(['ItemList']);
  });

  test('a title nobody carries renders neither the list nor an empty block', async () => {
    const html = await render({});
    expect(html).not.toContain('watch-list');
    expect(blocks(html)).toEqual([]);
    expect(html).not.toContain('application/ld+json');
  });
});
