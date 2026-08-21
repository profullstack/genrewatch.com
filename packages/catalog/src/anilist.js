/**
 * Anime, from AniList.
 *
 * Chosen over Jikan/MyAnimeList for one reason that matters to a reminder site:
 * AniList publishes an `AiringSchedule` with a real unix timestamp per episode,
 * so "episode 8 airs at 17:30 JST on Thursday" is a fact we are given rather than
 * one we reconstruct from a weekday-and-time string and a timezone name. Jikan
 * only offers the latter, and it was also answering 504 from this network for
 * every probe on the day this was written.
 *
 * It is keyless. The published limit is 90 requests a minute and has spent long
 * stretches degraded to 30, so the lane below is set for the degraded number --
 * this fetch is never urgent and a 429 here costs a whole sync.
 */

import { getJson } from './http.js';
import { keyFor, slugify } from './slug.js';

const ENDPOINT = 'https://graphql.anilist.co';
const PROVIDER = 'anilist';
export const CATEGORY = 'anime';

/** 2.5s between calls: comfortably inside AniList's degraded 30/min ceiling. */
const MIN_GAP_MS = 2500;

/** AniList caps perPage at 50 whatever you ask for. */
const PER_PAGE = 50;

const QUERY = `query ($page: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: ${PER_PAGE}) {
    pageInfo { hasNextPage currentPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      id
      airingAt
      episode
      media {
        id
        title { romaji english }
        genres
        format
        status
        siteUrl
        description(asHtml: false)
        episodes
        duration
        coverImage { medium }
        studios(isMain: true) { nodes { name } }
      }
    }
  }
}`;

/** AniList descriptions carry <br> and <i> even with asHtml:false. */
function plain(text, limit = 400) {
  if (!text) return null;
  const s = String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/**
 * Formats that are not episodic television and should not be filed as episodes.
 *
 * A MOVIE with an "airing schedule" is a broadcast premiere, and calling it
 * "episode 1" on the page is wrong in a way readers notice immediately.
 */
const FILM_FORMATS = new Set(['MOVIE']);

/**
 * Every anime episode airing in a window.
 *
 * @param {object} [opts]
 * @param {Date} [opts.from]
 * @param {number} [opts.horizonDays] AniList holds roughly a season ahead
 * @param {number} [opts.maxPages] hard stop, so a bad window cannot walk forever
 */
export async function fetchAll({ from = new Date(), horizonDays = 60, maxPages = 30 } = {}) {
  const fromSec = Math.floor(from.getTime() / 1000);
  const toSec = fromSec + horizonDays * 86_400;

  const genres = new Map();
  const subjects = new Map();
  const events = [];

  for (let page = 1; page <= maxPages; page++) {
    const body = { query: QUERY, variables: { page, from: fromSec, to: toSec } };
    const res = await getJson(ENDPOINT, { minGapMs: MIN_GAP_MS, body, timeoutMs: 40_000 });

    /*
     * GraphQL reports failure with HTTP 200 and an `errors` array.
     *
     * So a transport-level check is not enough here, and a silent `?.` chain would
     * turn a rate-limit complaint into "the season has no anime in it" -- which is
     * indistinguishable from a quiet week and would have gone unnoticed.
     */
    if (res?.errors?.length) {
      throw new Error(`anilist: ${res.errors.map((e) => e.message).join('; ')}`);
    }
    const pageData = res?.data?.Page;
    const schedules = pageData?.airingSchedules ?? [];
    if (schedules.length === 0) break;

    for (const s of schedules) {
      const m = s?.media;
      if (!m?.id || !s.airingAt) continue;

      const title = m.title?.english || m.title?.romaji;
      if (!title) continue;

      const genreKeys = [];
      for (const g of m.genres ?? []) {
        const key = keyFor(PROVIDER, 'genre', g);
        if (!genres.has(key)) {
          genres.set(key, {
            provider: PROVIDER,
            providerKey: key,
            category: CATEGORY,
            slug: slugify(`${g}-anime`),
            name: g,
            priority: 50,
          });
        }
        genreKeys.push(key);
      }
      if (genreKeys.length === 0) continue;

      const subjectKey = keyFor(PROVIDER, 'anime', String(m.id));
      const studio = m.studios?.nodes?.[0]?.name ?? null;
      if (!subjects.has(subjectKey)) {
        subjects.set(subjectKey, {
          provider: PROVIDER,
          providerKey: subjectKey,
          category: CATEGORY,
          kind: 'anime',
          slug: slugify(title, String(m.id)),
          name: title,
          displayName: title,
          description: plain(m.description),
          imageUrl: m.coverImage?.medium ?? null,
          url: m.siteUrl ?? null,
          genreKeys,
        });
      }
      const subject = subjects.get(subjectKey);

      const isFilm = FILM_FORMATS.has(m.format);
      const episode = s.episode ?? null;
      events.push({
        provider: PROVIDER,
        providerKey: keyFor(PROVIDER, 'airing', String(s.id)),
        category: CATEGORY,
        subjectKey,
        kind: isFilm ? 'film' : episode === 1 ? 'premiere' : 'episode',
        // AniList timestamps are seconds, and are a real broadcast slot rather
        // than a padded date -- so unlike TV and music, this category is entirely
        // time-known.
        startsAt: new Date(s.airingAt * 1000),
        timeKnown: true,
        precision: 'minute',
        state: 'upcoming',
        name: isFilm ? title : `${title} — Episode ${episode ?? '?'}`,
        shortName: episode ? `Episode ${episode}` : null,
        summary: subject.description,
        imageUrl: subject.imageUrl,
        url: m.siteUrl ?? null,
        // The studio is the closest thing anime has to a network, and it is the
        // credit fans actually follow.
        venue: studio,
        venueRegion: 'Japan',
        season: null,
        number: episode,
        runtimeMin: m.duration ?? null,
      });
    }

    if (!pageData?.pageInfo?.hasNextPage) break;
  }

  return { genres: [...genres.values()], subjects: [...subjects.values()], events };
}

export const adapter = { name: PROVIDER, category: CATEGORY, fetchAll };
