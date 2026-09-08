/**
 * Where a title can actually be watched, normalised.
 *
 * Two callers need this now -- the page and the structured-data builder -- and
 * one of them cannot import the other without a cycle, so it lives on its own.
 *
 * The other job it does is bridge two stored shapes. `detail.watch` used to be a
 * plain array of provider names, and a re-sync is the only thing that turns a
 * stored row into the newer `{ name, kind }` one. Rows written before that land
 * would otherwise render as blank list items, which is a worse bug than the one
 * this pass set out to fix -- so the old shape is read as what it was: flat-rate
 * services, because flat-rate was all we kept.
 */

/** How you get at a title, cheapest access first. This is the display order. */
export const WATCH_KINDS = ['flatrate', 'rent', 'buy'];

/** What each kind is called on the page. */
export const WATCH_KIND_LABEL = {
  flatrate: 'Included with',
  rent: 'Rent from',
  buy: 'Buy from',
};

/**
 * `[{ name, kind }]`, in cheapest-access order, or an empty array.
 *
 * Sorted by kind rather than left in the provider's order, so the list reads as
 * an answer to "can I watch this tonight without paying again" before it reads
 * as a shopping list. Within a kind the provider's own order is kept -- TMDB
 * sorts those by its own display priority, and re-sorting them alphabetically
 * would be inventing a ranking.
 */
export function watchSourcesOf(detail) {
  const raw = detail?.watch;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const seen = new Set();
  const out = [];
  for (const kind of WATCH_KINDS) {
    for (const entry of raw) {
      // The old shape: a bare provider name, which was always flat-rate.
      const source =
        typeof entry === 'string'
          ? { name: entry, kind: 'flatrate' }
          : { ...entry, kind: entry?.kind ?? 'flatrate' };
      if (!source.name || source.kind !== kind) continue;
      /*
       * A provider that both includes a title and rents it is listed once, under
       * the cheaper access. Amazon does this constantly, and "Included with
       * Amazon · Rent from Amazon" reads as a mistake even though both are true.
       */
      const key = source.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: source.name, kind });
    }
  }
  return out;
}
