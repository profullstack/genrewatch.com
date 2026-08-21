/**
 * Film, from TMDB.
 *
 * The only adapter here that needs a key, and it is free for this use. It earns
 * the exception because there is no keyless source with both a full forward
 * release calendar and a genre taxonomy -- Wikidata has the dates but needs
 * SPARQL and no genres worth the name, and OMDb wants a key too.
 *
 * The important difference from television: a film release date is a DATE. TMDB
 * returns "2026-12-16" and nothing finer, because a wide release does not have a
 * minute. Every row from here is therefore time_known = false, and the scheduler
 * reminds on the date offsets rather than the minute ones. Padding those to
 * midnight and reminding someone "in 60 minutes" at 11pm the night before is the
 * exact bug that flag exists to prevent.
 */

import { getJson } from './http.js';
import { keyFor, slugify } from './slug.js';

const BASE = 'https://api.themoviedb.org/3';
const POSTER = 'https://image.tmdb.org/t/p/w342';
/* Wide art for the top of a page. w780 rather than original: a backdrop is
   decoration, and originals run to several megabytes. */
const BACKDROP = 'https://image.tmdb.org/t/p/w780';
const PROVIDER = 'tmdb';
export const CATEGORY = 'film';

/** TMDB tolerates ~50/s. 100ms is well inside it and costs nothing here. */
const MIN_GAP_MS = 100;

/** Genres TMDB carries that this site files elsewhere. */
const REROUTED = new Set(['tv movie']);

const ymd = (d) => d.toISOString().slice(0, 10);

/**
 * Noon UTC, not midnight.
 *
 * A date-only event has to be stored as SOME instant, and midnight UTC is the
 * worst available choice: it is the previous evening for all of the Americas, so
 * a film "released on the 16th" shows up on the 15th for a third of readers and a
 * day-before reminder fires two days early. Noon is inside the correct calendar
 * day for every timezone from UTC-11 to UTC+12.
 */
function noonUtc(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The genre id -> name table, fetched once per sync. */
async function fetchGenres(key) {
  const res = await getJson(`${BASE}/genre/movie/list?api_key=${key}`, { minGapMs: MIN_GAP_MS });
  const out = new Map();
  for (const g of res?.genres ?? []) {
    if (REROUTED.has(g.name.toLowerCase())) continue;
    out.set(g.id, {
      provider: PROVIDER,
      providerKey: keyFor(PROVIDER, 'genre', g.name),
      category: CATEGORY,
      slug: slugify(`${g.name}-film`),
      name: g.name,
      priority: 50,
    });
  }
  return out;
}

/**
 * Films releasing in the window, most popular first.
 *
 * Popularity order rather than date order is deliberate. TMDB's forward calendar
 * has a long tail of festival entries and regional re-releases that nobody is
 * waiting for, and taking the first N by date would fill the page with them while
 * missing the film everybody actually wants a reminder about.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey] falls back to TMDB_API_KEY
 * @param {number} [opts.maxPages] 20 titles per page
 */
export async function fetchAll({
  from = new Date(),
  horizonDays = 180,
  apiKey = process.env.TMDB_API_KEY,
  maxPages = 15,
} = {}) {
  if (!apiKey) return { genres: [], subjects: [], events: [], skipped: 'no TMDB_API_KEY' };

  const genreById = await fetchGenres(apiKey);
  const to = new Date(from.getTime() + horizonDays * 86_400_000);

  const genres = new Map();
  const subjects = new Map();
  const events = [];

  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${BASE}/discover/movie?api_key=${apiKey}` +
      `&primary_release_date.gte=${ymd(from)}` +
      `&primary_release_date.lte=${ymd(to)}` +
      `&sort_by=popularity.desc&include_adult=false&page=${page}`;
    const res = await getJson(url, { minGapMs: MIN_GAP_MS });
    const results = res?.results ?? [];
    if (results.length === 0) break;

    for (const m of results) {
      if (!m?.id || !m.release_date) continue;
      const startsAt = noonUtc(m.release_date);
      if (!startsAt || startsAt > to) continue;

      const genreKeys = [];
      for (const gid of m.genre_ids ?? []) {
        const g = genreById.get(gid);
        if (!g) continue;
        genres.set(g.providerKey, g);
        genreKeys.push(g.providerKey);
      }
      if (genreKeys.length === 0) continue;

      const subjectKey = keyFor(PROVIDER, 'movie', String(m.id));
      const summary = m.overview?.trim() || null;
      const image = m.poster_path ? `${POSTER}${m.poster_path}` : null;
      /*
       * Free. discover already returns these in the response we are making
       * anyway -- they were being parsed and thrown away, which is why an event
       * page had a date and a sentence on it and nothing else.
       */
      const backdrop = m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null;
      const votes = Number(m.vote_count ?? 0);
      const rating = votes > 0 ? Number(m.vote_average) : null;

      subjects.set(subjectKey, {
        provider: PROVIDER,
        providerKey: subjectKey,
        category: CATEGORY,
        kind: 'film',
        slug: slugify(m.title, String(m.id)),
        name: m.title,
        displayName: m.title,
        description: summary,
        imageUrl: image,
        backdropUrl: backdrop,
        url: `https://www.themoviedb.org/movie/${m.id}`,
        genreKeys,
      });

      events.push({
        provider: PROVIDER,
        // The film and its release are one row each, keyed apart so a future
        // second event for the same film (a streaming date) does not collide.
        providerKey: keyFor(PROVIDER, 'release', String(m.id)),
        category: CATEGORY,
        subjectKey,
        kind: 'release',
        startsAt,
        timeKnown: false,
        precision: 'day',
        state: 'upcoming',
        name: m.title,
        shortName: null,
        summary,
        imageUrl: image,
        backdropUrl: backdrop,
        rating,
        ratingCount: votes || null,
        // The provider's own id, so a later detail pass can find this row again
        // without re-deriving it from the URL.
        providerId: String(m.id),
        url: `https://www.themoviedb.org/movie/${m.id}`,
        venue: 'Cinemas',
        venueRegion: null,
        season: null,
        number: null,
        runtimeMin: null,
      });
    }

    if (res.page >= (res.total_pages ?? 1)) break;
  }

  return { genres: [...genres.values()], subjects: [...subjects.values()], events };
}

export const adapter = { name: PROVIDER, category: CATEGORY, fetchAll };

/**
 * The detail one further request buys, per film.
 *
 * `append_to_response` bundles credits, videos, watch providers and the rest into
 * the SAME call, so a fully populated film costs one request rather than five.
 * That still makes it the only pass here that scales with the catalogue instead of
 * with pages, which is why the caller hands it a budget and a list rather than
 * letting it walk everything.
 *
 * Returns a flat shape the database layer stores as-is. Absent fields are absent
 * rather than empty, so a renderer can tell "no trailer" from "not looked yet".
 *
 * @param {string[]} ids TMDB movie ids that have never been enriched
 */
export async function fetchDetail(ids, { apiKey = process.env.TMDB_API_KEY, limit = 120 } = {}) {
  if (!apiKey || !ids?.length) return [];
  const out = [];

  for (const id of ids.slice(0, limit)) {
    const url =
      `${BASE}/movie/${id}?api_key=${apiKey}` +
      `&append_to_response=credits,videos,watch/providers`;
    let d;
    try {
      d = await getJson(url, { minGapMs: MIN_GAP_MS });
    } catch {
      // One bad title must not end the pass. It stays unenriched and is retried
      // next time, because nothing is stamped for it.
      continue;
    }
    if (!d) continue;

    const credits = d.credits ?? {};
    const director = (credits.crew ?? []).find((c) => c.job === 'Director')?.name ?? null;
    const cast = (credits.cast ?? []).slice(0, 8).map((c) => c.name);

    /*
     * A trailer, preferring the official one.
     *
     * Stored as a full URL rather than a site+key pair so no renderer has to know
     * that YouTube keys and Vimeo keys are built into different addresses.
     */
    const vids = (d.videos?.results ?? []).filter(
      (v) => v.type === 'Trailer' && v.site === 'YouTube',
    );
    const trailer = vids.find((v) => v.official) ?? vids[0];

    // Flat-rate streaming only. Rent and buy are a different question from "is it
    // included where I already subscribe", and mixing them misleads.
    const us = d['watch/providers']?.results?.US ?? {};
    const watch = (us.flatrate ?? []).map((p) => p.provider_name).slice(0, 6);

    out.push({
      providerId: String(id),
      runtimeMin: d.runtime || null,
      tagline: d.tagline?.trim() || null,
      trailerUrl: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
      detail: {
        cast,
        director,
        studios: (d.production_companies ?? []).map((c) => c.name).slice(0, 3),
        language: d.spoken_languages?.[0]?.english_name ?? null,
        watch,
        imdbId: d.imdb_id ?? null,
      },
    });
  }

  return out;
}
