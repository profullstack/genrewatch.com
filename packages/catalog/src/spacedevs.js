/**
 * Spaceflight, from TheSpaceDevs Launch Library 2.
 *
 * Structurally the closest thing here to a sports fixture: a named event, at a
 * place, at a time, with a countdown people genuinely set alarms for. It is also
 * the only category whose provider tells us how much to trust the clock --
 * `net_precision` says "Second" or "Month" outright, which is the field the rest
 * of this site had to infer.
 *
 * The hard constraint is the rate limit: FIFTEEN requests per hour without a key,
 * shared across the whole deployment. That is the entire budget, so this adapter
 * takes one page of 100 and stops by default, and the sync scheduler runs it
 * hourly rather than alongside everything else. Blowing the budget here does not
 * degrade gracefully -- the next call returns 429 for the rest of the hour.
 */

import { getJson } from './http.js';
import { keyFor, slugify } from './slug.js';

const BASE = 'https://ll.thespacedevs.com/2.3.0';
const PROVIDER = 'spacedevs';
export const CATEGORY = 'space';

/** Four seconds apart. The limit is per hour, so spacing barely matters -- the
 *  page count is what has to stay small. */
const MIN_GAP_MS = 4000;

/**
 * How much of `net` to believe.
 *
 * Launch Library's own vocabulary. Anything hour-or-finer is a real T-0 worth a
 * 60-minute reminder; anything day-or-coarser is a planning date that will move,
 * and reminding someone at 11:00 for a launch listed as "October" would be
 * nonsense. Unknown values are treated as coarse, which is the safe direction.
 */
const TIMED = new Set(['second', 'minute', 'hour']);

function precisionOf(net) {
  const name = String(net?.name ?? '').toLowerCase();
  const known = TIMED.has(name);
  return { timeKnown: known, precision: name || 'day' };
}

/**
 * Upcoming launches.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxPages] each page is 100 launches and one of fifteen
 *   hourly requests -- raising this is the fastest way to get rate limited
 */
export async function fetchAll({ from = new Date(), horizonDays = 180, maxPages = 2 } = {}) {
  const to = new Date(from.getTime() + horizonDays * 86_400_000);

  const genres = new Map();
  const subjects = new Map();
  const events = [];

  for (let page = 0; page < maxPages; page++) {
    const url =
      `${BASE}/launches/upcoming/?limit=100&offset=${page * 100}` +
      `&net__gte=${from.toISOString()}&net__lte=${to.toISOString()}`;
    const res = await getJson(url, { minGapMs: MIN_GAP_MS, timeoutMs: 45_000 });
    const results = res?.results ?? [];
    if (results.length === 0) break;

    for (const l of results) {
      if (!l?.id || !l.net) continue;
      const startsAt = new Date(l.net);
      if (Number.isNaN(startsAt.getTime())) continue;

      /*
       * The mission type is the genre.
       *
       * "Communications", "Earth Science", "Resupply", "Human Exploration" --
       * this is the axis along which people actually care about launches, far
       * more than the rocket. Launches without a mission (a classified payload,
       * or a listing that has not been filled in) are skipped rather than filed
       * under a catch-all, for the same reason as elsewhere.
       */
      const missionType = l.mission?.type;
      // "Unknown" is a literal value in this field, not an absent one, and it is
      // common enough to have become the fourth-largest genre on the space page
      // before it was caught. A genre nobody would ever choose to browse is not a
      // genre.
      if (!missionType || missionType.toLowerCase() === 'unknown') continue;
      const genreKey = keyFor(PROVIDER, 'genre', missionType);
      if (!genres.has(genreKey)) {
        genres.set(genreKey, {
          provider: PROVIDER,
          providerKey: genreKey,
          category: CATEGORY,
          slug: slugify(`${missionType}-space`),
          name: missionType,
          priority: 40,
        });
      }

      /*
       * The launch provider is the subject, not the rocket.
       *
       * A reader follows SpaceX or Rocket Lab; almost nobody follows "Electron"
       * as distinct from the company flying it. The rocket name is still on the
       * event, where it belongs.
       */
      const lsp = l.launch_service_provider;
      if (!lsp?.id) continue;
      const subjectKey = keyFor(PROVIDER, 'agency', String(lsp.id));
      if (!subjects.has(subjectKey)) {
        subjects.set(subjectKey, {
          provider: PROVIDER,
          providerKey: subjectKey,
          category: CATEGORY,
          kind: 'agency',
          slug: slugify(lsp.name, String(lsp.id)),
          name: lsp.name,
          displayName: lsp.name,
          description: lsp.type?.name ? `${lsp.type.name} launch provider` : null,
          imageUrl: null,
          url: null,
          genreKeys: [],
        });
      }
      // An agency flies several mission types, so its genre set accumulates.
      const subject = subjects.get(subjectKey);
      if (!subject.genreKeys.includes(genreKey)) subject.genreKeys.push(genreKey);

      const { timeKnown, precision } = precisionOf(l.net_precision);

      events.push({
        provider: PROVIDER,
        providerKey: keyFor(PROVIDER, 'launch', l.id),
        category: CATEGORY,
        subjectKey,
        kind: 'launch',
        startsAt,
        timeKnown,
        precision,
        state: 'upcoming',
        name: l.name,
        shortName: l.mission?.name ?? null,
        summary: l.mission?.description ?? null,
        imageUrl: l.image?.thumbnail_url ?? l.image?.image_url ?? null,
        // The full-size launch photo is landscape and is the best banner this
        // category has -- the thumbnail is for a row, not for the top of a page.
        backdropUrl: l.image?.image_url ?? null,
        detail: {
          rocket: l.rocket?.configuration?.full_name ?? l.rocket?.configuration?.name ?? null,
          orbit: l.mission?.orbit?.name ?? null,
          program: (l.program ?? []).map((p) => p.name).slice(0, 2),
          provider: lsp.name ?? null,
          probability: Number.isFinite(l.probability) && l.probability >= 0 ? l.probability : null,
        },
        url: `https://nextspaceflight.com/launches/details/${l.id}`,
        venue: l.pad?.name ?? null,
        venueRegion: l.pad?.location?.name ?? null,
        season: null,
        number: null,
        runtimeMin: null,
      });
    }

    if (!res.next) break;
  }

  return { genres: [...genres.values()], subjects: [...subjects.values()], events };
}

export const adapter = { name: PROVIDER, category: CATEGORY, fetchAll };
