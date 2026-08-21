/**
 * Television, from TVmaze.
 *
 * Free, keyless, and unusually well shaped for this job: `/schedule/full` returns
 * every episode TVmaze knows is coming, in ONE request, with the show embedded in
 * each entry. That is roughly 6,500 rows and 12MB, and it means the entire TV
 * calendar costs a single upstream call rather than a walk over thousands of
 * shows. Nothing else here comes close to that ratio, which is why TV is the
 * category that stays freshest.
 *
 * Genres come off the embedded show (`genres: ["Drama", "Crime"]`), which is what
 * makes this a genre site rather than a show tracker: the same episode lands in
 * three genre feeds without us curating anything.
 */

import { getJson } from './http.js';
import { keyFor, slugify } from './slug.js';

const BASE = 'https://api.tvmaze.com';
const PROVIDER = 'tvmaze';
export const CATEGORY = 'tv';

/** TVmaze asks for 20 calls per 10 seconds. We make one, but be a good citizen. */
const MIN_GAP_MS = 500;

/*
 * Genres TVmaze uses that belong to another category on this site.
 *
 * "Sports" redirects to tipoffwatch.com, which does fixtures properly, so a
 * sports documentary strand should not create a half-populated sports section
 * here. "Anime" has its own category fed by AniList, which knows episode numbers
 * and studios that TVmaze does not.
 */
const REROUTED = new Map([
  ['sports', null],
  ['anime', 'anime'],
]);

/** Strip TVmaze's HTML summaries down to something a card can hold. */
function plain(html, limit = 400) {
  if (!html) return null;
  const text = String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Where an episode can be watched.
 *
 * `network` is broadcast and `webChannel` is streaming; a show has one or the
 * other and occasionally both, in which case the network is the one a reader
 * recognises. The country is kept separately because "ITV" means nothing without
 * it and a great deal with it.
 */
function venueOf(show) {
  const src = show?.network ?? show?.webChannel ?? null;
  if (!src) return { venue: null, venueRegion: null };
  return {
    venue: src.name ?? null,
    venueRegion: src.country?.name ?? (show?.webChannel ? 'Streaming' : null),
  };
}

/**
 * `type` on an episode is TVmaze's, and it is nearly right already.
 *
 * The one thing it does not say is "premiere", which readers care about more than
 * anything else on the page -- so season 1 episode 1 is promoted, and a season
 * opener is marked as such rather than as a regular episode.
 */
function kindOf(ep) {
  if (ep.type === 'significant_special' || ep.type === 'insignificant_special') return 'special';
  if (ep.number === 1) return ep.season === 1 ? 'premiere' : 'season-premiere';
  return 'episode';
}

/**
 * Fetch the whole known-future TV schedule.
 *
 * Returns the three catalogue tiers already cross-referenced by provider key --
 * the database layer resolves those to ids, so nothing here needs to know what is
 * already stored.
 *
 * @returns {Promise<{genres: object[], subjects: object[], events: object[]}>}
 */
export async function fetchAll({ from = new Date(), horizonDays = 60 } = {}) {
  const rows = await getJson(`${BASE}/schedule/full`, {
    minGapMs: MIN_GAP_MS,
    timeoutMs: 120_000,
  });
  if (!Array.isArray(rows)) return { genres: [], subjects: [], events: [] };

  const cutoff = new Date(from.getTime() + horizonDays * 86_400_000);
  const floor = new Date(from.getTime() - 86_400_000);
  const genres = new Map();
  const subjects = new Map();
  const events = [];

  for (const ep of rows) {
    const show = ep?._embedded?.show;
    if (!show?.id || !ep?.airstamp) continue;

    const startsAt = new Date(ep.airstamp);
    if (Number.isNaN(startsAt.getTime())) continue;
    /*
     * Bounded at BOTH ends.
     *
     * `/schedule/full` is not a forward-only feed -- it reaches several days into
     * the past for shows that have just aired. Filtering only the far end let
     * those through, and because every list on this site is ordered by start
     * time ascending, last Tuesday's episode sorted to the TOP of every genre
     * page. A day of grace keeps something that aired this morning visible
     * without turning the calendar into an archive.
     */
    if (startsAt < floor || startsAt > cutoff) continue;

    /*
     * An empty `airtime` is TVmaze saying it does not know the slot.
     *
     * The `airstamp` is still populated in that case -- it pads to midnight in the
     * network's timezone, which surfaces as 04:00Z or similar. Rendering that as
     * "airs at 4am" is wrong, and reminding someone 60 minutes before it is worse,
     * so the flag travels with the row all the way to the scheduler.
     */
    const timeKnown = Boolean(ep.airtime);

    const showGenres = [];
    let category = CATEGORY;
    for (const g of show.genres ?? []) {
      const lower = g.toLowerCase();
      if (REROUTED.has(lower)) {
        // An anime tag moves the whole show to the anime category, where AniList
        // will describe it better. A sports tag drops it entirely.
        const target = REROUTED.get(lower);
        if (target === null) {
          category = null;
          break;
        }
        category = target;
        continue;
      }
      const key = keyFor(PROVIDER, 'genre', g);
      if (!genres.has(key)) {
        genres.set(key, {
          provider: PROVIDER,
          providerKey: key,
          category: CATEGORY,
          slug: slugify(`${g}-tv`),
          name: g,
          priority: 50,
        });
      }
      showGenres.push(key);
    }
    // Dropped by a rerouted tag, or the show carries a category we do not own.
    if (category !== CATEGORY) continue;
    // A show with no genre at all cannot appear anywhere on a genre site, and
    // TVmaze has a few thousand of them. Filing them under a catch-all would put
    // untagged filler at the top of a page nobody asked for.
    if (showGenres.length === 0) continue;

    const subjectKey = keyFor(PROVIDER, 'show', String(show.id));
    if (!subjects.has(subjectKey)) {
      const { venue, venueRegion } = venueOf(show);
      subjects.set(subjectKey, {
        provider: PROVIDER,
        providerKey: subjectKey,
        category: CATEGORY,
        kind: 'show',
        slug: slugify(show.name, String(show.id)),
        name: show.name,
        displayName: show.name,
        description: plain(show.summary),
        imageUrl: show.image?.medium ?? null,
        url: show.url ?? null,
        genreKeys: showGenres,
        // Not stored on the subject; carried so the event mapper below does not
        // have to look the show up again.
        _venue: venue,
        _venueRegion: venueRegion,
      });
    }
    const subject = subjects.get(subjectKey);

    events.push({
      provider: PROVIDER,
      providerKey: keyFor(PROVIDER, 'episode', String(ep.id)),
      category: CATEGORY,
      subjectKey,
      kind: kindOf(ep),
      startsAt,
      timeKnown,
      precision: timeKnown ? 'minute' : 'day',
      state: 'upcoming',
      // "Severance 2x03 — Woe's Hollow" reads better on a mixed genre page than a
      // bare episode title, which is very often just "Episode 73".
      name: `${show.name} ${ep.season ?? '?'}x${String(ep.number ?? 0).padStart(2, '0')}${
        ep.name ? ` — ${ep.name}` : ''
      }`,
      shortName: ep.name || null,
      summary: plain(ep.summary) ?? subject.description,
      imageUrl: ep.image?.medium ?? subject.imageUrl,
      url: ep.url ?? null,
      venue: subject._venue,
      venueRegion: subject._venueRegion,
      season: ep.season ?? null,
      number: ep.number ?? null,
      runtimeMin: ep.runtime ?? show.averageRuntime ?? null,
    });
  }

  for (const s of subjects.values()) {
    s._venue = undefined;
    s._venueRegion = undefined;
  }

  return { genres: [...genres.values()], subjects: [...subjects.values()], events };
}

export const adapter = { name: PROVIDER, category: CATEGORY, fetchAll };
