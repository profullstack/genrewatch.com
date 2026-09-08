import { afterAll, describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { fetchDetail } = await import('../packages/catalog/src/tmdb.js');

/*
 * The enrichment pass, with the network stubbed.
 *
 * `fetch` is restored afterwards rather than left swapped: `bun test` shares one
 * process across every file, so a global left pointing at a stub is a failure in
 * whichever file happens to run next -- and one that reads as unrelated.
 */
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const PROVIDERS = {
  flatrate: [{ provider_name: 'Max' }],
  rent: [{ provider_name: 'Apple TV' }, { provider_name: 'Fandango At Home' }],
  buy: [{ provider_name: 'Amazon Video' }],
};

const detailFor = async (us) => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: 1,
        runtime: 166,
        credits: { cast: [], crew: [] },
        videos: { results: [] },
        release_dates: { results: [] },
        'watch/providers': { results: { US: us } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const [row] = await fetchDetail(['1'], { apiKey: 'test-key' });
  return row.detail;
};

describe('what the enrichment pass keeps about where a film can be watched', () => {
  test('rentals and purchases are kept, not only subscriptions', async () => {
    /*
     * This dropped everything but flat-rate, which meant a film not yet on any
     * subscription -- most of them, in the months after a cinema run -- produced
     * no answer at all rather than "you can rent it".
     */
    const detail = await detailFor(PROVIDERS);
    expect(detail.watch).toEqual([
      { name: 'Max', kind: 'flatrate' },
      { name: 'Apple TV', kind: 'rent' },
      { name: 'Fandango At Home', kind: 'rent' },
      { name: 'Amazon Video', kind: 'buy' },
    ]);
  });

  test('each source says which kind it is, rather than being blended', async () => {
    // The distinction the old comment was protecting: "included where I already
    // subscribe" and "three ninety-nine" are different answers.
    const detail = await detailFor(PROVIDERS);
    expect(new Set(detail.watch.map((s) => s.kind))).toEqual(new Set(['flatrate', 'rent', 'buy']));
  });

  test('the cap is per kind, so storefronts cannot crowd out a subscription', async () => {
    const detail = await detailFor({
      flatrate: [{ provider_name: 'Max' }],
      rent: Array.from({ length: 12 }, (_, i) => ({ provider_name: `Store ${i}` })),
    });
    expect(detail.watch.filter((s) => s.kind === 'rent')).toHaveLength(6);
    expect(detail.watch.some((s) => s.name === 'Max')).toBe(true);
  });

  test('a film nobody carries yields an empty list, not a throw', async () => {
    expect(await detailFor({})).toHaveProperty('watch', []);
  });
});
