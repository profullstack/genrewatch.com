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

/**
 * TMDB's release_type table. 1 premiere, 2 limited, 3 theatrical, 5 physical,
 * 6 TV -- only the digital one is read here.
 */
const DIGITAL = 4;

/**
 * The country whose home-release dates this site quotes.
 *
 * The same choice the watch-provider block below already makes, and it has to be
 * the same one: quoting a US streaming date beside a UK provider list would be two
 * different countries' answers stacked in one paragraph.
 */
const HOME_REGION = 'US';

/**
 * Notes on a digital release that do NOT name a service.
 *
 * A type-4 entry usually carries a note, and the note is the only thing that
 * separates the two dates below. Most notes are service names -- "Disney+", "HBO
 * Max", "Peacock" -- so the test is for the notes that are something else.
 *
 * Two kinds of something else, learned from what production actually wrote. The
 * first is the release WINDOW ("Digital HD", "PVOD"), which is an exact phrase.
 * The second is a CUT or FORMAT, and it is why this is not just a word list:
 * "Subtitled Version" shipped as a streaming row whose service was, apparently,
 * Subtitled Version. Those notes are open-ended -- extended, uncut, remastered,
 * the 40th anniversary edition -- so they are matched on the descriptive word
 * wherever it falls rather than by trying to enumerate the phrases.
 *
 * A note that is neither is taken to be a service. That direction is the safe one:
 * the cost of a missed service is a date filed as a rental, while the cost of a
 * false one is a venue that reads like nonsense.
 */
const NOT_A_SERVICE =
  /^(digital|digital hd|vod|pvod|tvod|est|premium|premium vod|rental|rent|buy|purchase|streaming|online)$/i;

/** Words that make a note a description of the release, not a place to watch it. */
const A_FORMAT_NOTE =
  /\b(version|edition|cut|subtitled|subtitles|dubbed|dub|remaster(ed)?|restored|anniversary|uncut|extended|unrated|imax|3-?d|re-?release|theatrical|director'?s)\b/i;

/**
 * A window word anywhere in the note, not just as the whole of it.
 *
 * "PVOD Rent/Buy" reached the calendar as a service. The exact-match list above
 * catches a note that IS a window; this catches one that mentions being a window
 * while saying something else too, which is the commoner shape.
 */
const A_WINDOW_PHRASE = /\b(pvod|tvod|vod|rent|buy|purchase|rental|est)\b/i;

/**
 * Notes that describe a shop or a route rather than a subscription.
 *
 * Two of these shipped: "Letterboxd Video Store - Unreleased Gems (30 days)" and
 * "Netflix / Rockstar Games official YouTube channel". Both are true statements
 * and neither is an answer to "is this included where I already subscribe", which
 * is the only question the streaming row exists to answer.
 *
 * A parenthesis is the reliable tell. A service name never has one; a note
 * qualifying what it means -- a window, a territory, a duration -- usually does.
 *
 * Note the deliberate absence of a length rule. It was the obvious test and it is
 * wrong: "Apple TV, YouTube & Prime Video" is thirty-one characters and a
 * perfectly good answer, while a short note can still be junk.
 */
const NOT_A_PLACE = /[()]|\b(store|channel|official|unreleased|theatres?|cinemas?)\b/i;

/** True when a note names a service somebody could subscribe to. */
function namesAService(note) {
  if (!note) return false;
  return (
    !NOT_A_SERVICE.test(note) &&
    !A_FORMAT_NOTE.test(note) &&
    !A_WINDOW_PHRASE.test(note) &&
    !NOT_A_PLACE.test(note)
  );
}

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

/**
 * When a film reaches the reader's own television, from TMDB's release_dates.
 *
 * A theatrical calendar answers a question most readers cannot act on. Somebody
 * who does not go to the cinema -- which is most people most of the time -- gets a
 * date they can do nothing with, and the site is a list of films they are not
 * allowed to watch yet. This is the other half of the answer.
 *
 * It returns TWO dates because TMDB records two and they are weeks apart. Toy
 * Story 5 was in cinemas on 19 June, buyable on 18 August, and on Disney+ on 23
 * September. Collapsing those into one "streaming" date would be wrong for
 * whichever reader we picked against: the first is a purchase, the second is
 * included in a subscription they already pay for. That is the same distinction
 * the watch-provider block further down already refuses to blur, and it is
 * refused here for the same reason.
 *
 * The service is carried rather than derived. "Digital, 23 September" is a
 * shrug; "Disney+, 23 September" is the whole answer for someone deciding
 * whether they need to rent it.
 *
 * @param {object} payload a /movie/{id}/release_dates response
 * @returns {{vod: string|null, streaming: {date: string, service: string}|null}}
 */
export function homeReleases(payload, { region = HOME_REGION } = {}) {
  const country = (payload?.results ?? []).find((r) => r?.iso_3166_1 === region);
  const entries = (country?.release_dates ?? [])
    .filter((r) => r?.type === DIGITAL && typeof r.release_date === 'string')
    .map((r) => ({ date: r.release_date.slice(0, 10), note: (r.note ?? '').trim() }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    // Earliest first, so "the first date this became watchable" falls out of a
    // find() rather than needing a comparison at every use.
    .sort((a, b) => a.date.localeCompare(b.date));

  // Mutually exclusive by construction, and everything that is not a service --
  // no note, a window, or a description of the cut -- is a date you pay for.
  const named = entries.find((e) => namesAService(e.note));
  const plain = entries.find((e) => !namesAService(e.note));

  return {
    vod: plain?.date ?? null,
    streaming: named ? { date: named.date, service: named.note } : null,
  };
}

/**
 * The calendar rows those dates deserve.
 *
 * Separate events rather than fields on the theatrical one, because this site's
 * unit of "tell me before it drops" is an event: a field cannot be followed,
 * cannot appear on a genre page in date order, and cannot be put in the reminder
 * queue. A film that opens in cinemas in June and lands on Disney+ in September
 * genuinely is two things a reader might be waiting for, and only one of them is
 * something they can act on.
 *
 * Keyed off `release` so they never collide with the theatrical row -- the reason
 * that key was namespaced in the first place.
 *
 * `base` is the theatrical event as we already hold it: everything visual is
 * copied so a streaming row is a complete page rather than a title and a date.
 */
export function homeReleaseEvents({ providerId, home, base }) {
  const row = (slot, dateStr, venue) => {
    const startsAt = noonUtc(dateStr);
    if (!startsAt) return null;
    return {
      provider: PROVIDER,
      providerKey: keyFor(PROVIDER, slot, String(providerId)),
      category: CATEGORY,
      // The same film, so the same subject the theatrical row points at. Derived
      // rather than passed in, so the two can never drift apart.
      subjectKey: keyFor(PROVIDER, 'movie', String(providerId)),
      kind: 'release',
      startsAt,
      // Date-only, exactly like the theatrical row. A streaming drop has no
      // announced minute either, whatever time it actually appears.
      timeKnown: false,
      precision: 'day',
      state: startsAt.getTime() > Date.now() ? 'upcoming' : 'out',
      name: base.name,
      summary: base.summary ?? null,
      imageUrl: base.imageUrl ?? null,
      backdropUrl: base.backdropUrl ?? null,
      rating: base.rating ?? null,
      ratingCount: base.ratingCount ?? null,
      providerId: String(providerId),
      url: base.url ?? `https://www.themoviedb.org/movie/${providerId}`,
      venue,
      venueRegion: null,
    };
  };

  return [
    // Rent or buy comes first because it is nearly always the earlier date.
    home?.vod ? row('digital', home.vod, 'Rent or buy') : null,
    home?.streaming ? row('stream', home.streaming.date, home.streaming.service) : null,
  ].filter(Boolean);
}

/**
 * Home-release dates for films we already hold, one request each.
 *
 * The cheap path is `fetchDetail` below, which gets these free inside a request it
 * was making anyway. This exists for the case that path cannot cover: a digital
 * date is announced WEEKS after the theatrical release, long after the film was
 * enriched once and stamped as done. Without a second look, every film in the
 * catalogue would carry whatever was known on the day it was first swept -- which,
 * for anything still in cinemas at the time, is nothing.
 *
 * Deliberately not a discover sweep. `with_release_type=4` does find films by
 * digital date, but the results carry the PRIMARY release date and no note, so it
 * can say a film has a digital date this week without saying which day or on what
 * service -- neither of the two things a reader needs.
 */
/**
 * What TMDB knows about a title we learned about from IMDb.
 *
 * IMDb's dumps are the reason this site knows about 314,000 titles, and the
 * reason a third of the forward calendar is a name and a year with nothing else:
 * title.basics carries no artwork, no synopsis and no finer date than a year. So
 * an upcoming film reads "Star Wars: New Jedi Order, 2027" and stops there, which
 * is a search result rather than a page.
 *
 * The join is EXACT, and that is what makes this safe to run unattended. Every
 * IMDb row is keyed by its tconst, and TMDB indexes the same identifier, so this
 * asks "what is tt10300398" rather than guessing from a title and a year. Fuzzy
 * matching on titles would put the wrong poster on a film, which is worse than no
 * poster -- there are a dozen films called Rebirth and no way to tell from a name
 * and a year which one a stranger meant.
 *
 * Not everything is found, and not every hit is complete: measured over eight
 * upcoming titles, six matched, four had a synopsis and three a poster. TMDB is
 * thin on the same obscure titles IMDb is thin on. What it does have is the
 * notable ones, which are the rows anybody was going to open.
 *
 * @param {string[]} tconsts IMDb ids, e.g. "tt10300398"
 */
export async function fetchByImdbIds(
  tconsts,
  { apiKey = process.env.TMDB_API_KEY, limit = 120 } = {},
) {
  if (!apiKey || !tconsts?.length) return [];
  const out = [];

  for (const tconst of tconsts.slice(0, limit)) {
    let res;
    try {
      res = await getJson(
        `${BASE}/find/${encodeURIComponent(tconst)}?api_key=${apiKey}&external_source=imdb_id`,
        { minGapMs: MIN_GAP_MS },
      );
    } catch {
      // One bad id must not end the pass. It is stamped either way, so it comes
      // round again on a later cycle rather than blocking this one.
      continue;
    }

    /*
     * Films first, then television.
     *
     * IMDb's dumps carry both and this site files them in different categories,
     * but for the purpose of "put a poster on it" either answer is the right one.
     * Taking movie_results first only decides which wins for the rare id that
     * appears in both.
     */
    const m = res?.movie_results?.[0] ?? res?.tv_results?.[0];
    if (!m?.id) {
      // A miss is a result. Recording it is what stops the next pass spending its
      // budget re-asking about the same unmatched titles forever.
      out.push({ tconst, matched: false });
      continue;
    }

    const votes = Number(m.vote_count ?? 0);
    out.push({
      tconst,
      matched: true,
      tmdbId: String(m.id),
      imageUrl: m.poster_path ? `${POSTER}${m.poster_path}` : null,
      backdropUrl: m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null,
      summary: m.overview?.trim() || null,
      rating: votes > 0 ? Number(m.vote_average) : null,
      ratingCount: votes || null,
      /*
       * A real date, where TMDB has one.
       *
       * The most valuable field here and the least obvious. An IMDb row is stored
       * at year precision -- anchored to 1 January, because that is all a year
       * can mean -- so the calendar shows a 2027 film as arriving on New Year's
       * Day alongside every other 2027 film. TMDB frequently knows the actual
       * day, which turns a shrug into a date somebody can be reminded about.
       */
      releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(m.release_date ?? m.first_air_date ?? '')
        ? (m.release_date ?? m.first_air_date)
        : null,
    });
  }

  return out;
}

/** Noon UTC for a YYYY-MM-DD, exported so the sync layer anchors dates the same
 *  way this adapter does rather than reimplementing the rule. */
export const dayAnchor = noonUtc;

export async function fetchHomeReleases(
  ids,
  { apiKey = process.env.TMDB_API_KEY, limit = 80 } = {},
) {
  if (!apiKey || !ids?.length) return [];
  const out = [];

  for (const id of ids.slice(0, limit)) {
    let d;
    try {
      d = await getJson(`${BASE}/movie/${id}/release_dates?api_key=${apiKey}`, {
        minGapMs: MIN_GAP_MS,
      });
    } catch {
      // One bad title must not end the pass. It is stamped as checked either way,
      // so it comes round again on the next cycle rather than blocking this one.
      continue;
    }
    if (!d) continue;
    out.push({ providerId: String(id), home: homeReleases(d) });
  }

  return out;
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
      // release_dates rides along free: it is one more section of a response we
      // are already making, so every enriched film learns when it reaches the
      // home screen at no extra request.
      `&append_to_response=credits,videos,watch/providers,release_dates`;
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

    const home = homeReleases(d.release_dates);

    out.push({
      providerId: String(id),
      runtimeMin: d.runtime || null,
      tagline: d.tagline?.trim() || null,
      trailerUrl: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
      // Carried beside `detail` rather than inside it, because the caller builds
      // calendar rows out of this and only stores the rest.
      home,
      detail: {
        cast,
        director,
        studios: (d.production_companies ?? []).map((c) => c.name).slice(0, 3),
        language: d.spoken_languages?.[0]?.english_name ?? null,
        watch,
        /*
         * The same two dates again, on the film's own page.
         *
         * Duplicated with the events on purpose: the events are what a reader
         * FOLLOWS, and these are what the page they are already looking at can
         * say without a second query. A theatrical row that cannot answer "and
         * when can I watch it at home" is the complaint this whole pass exists
         * to fix.
         */
        digital: home.vod,
        streaming: home.streaming,
        imdbId: d.imdb_id ?? null,
      },
    });
  }

  return out;
}

/**
 * The back catalogue: what already came out.
 *
 * A release calendar only ever needed the future, which made the site useless for
 * the question someone with a VOD subscription actually asks -- can I watch this
 * tonight. A 1999 film is a perfectly ordinary row; it simply has a date in the
 * past.
 *
 * Bounded by popularity rather than by date, because TMDB holds about 1.05 MILLION
 * films and ingesting them is neither possible nor useful. Popularity decays fast:
 * page 20 of this ordering is The Empire Strikes Back and page 250 is already
 * titles nobody is searching for, so a few hundred pages reaches well past
 * anything a reader would name. Everything below that line is reachable by search
 * falling through to TMDB live, which is where the other million live.
 *
 * @param {object} [opts]
 * @param {number} [opts.pages] 20 titles per page
 * @param {number} [opts.minYear] how far back to reach
 */
export async function fetchBackCatalogue({
  apiKey = process.env.TMDB_API_KEY,
  pages = 200,
  minYear = 1970,
  startPage = 1,
} = {}) {
  if (!apiKey) return { genres: [], subjects: [], events: [], skipped: 'no TMDB_API_KEY' };

  const genreById = await fetchGenres(apiKey);
  const genres = new Map();
  const subjects = new Map();
  const events = [];
  const today = new Date().toISOString().slice(0, 10);

  for (let page = startPage; page < startPage + pages; page++) {
    // TMDB refuses pages beyond 500 whatever the result count.
    if (page > 500) break;
    const url =
      `${BASE}/discover/movie?api_key=${apiKey}` +
      `&primary_release_date.gte=${minYear}-01-01` +
      `&primary_release_date.lte=${today}` +
      `&sort_by=popularity.desc&include_adult=false&page=${page}`;

    const res = await getJson(url, { minGapMs: MIN_GAP_MS });
    const results = res?.results ?? [];
    if (results.length === 0) break;

    for (const m of results) {
      if (!m?.id || !m.release_date) continue;
      const startsAt = noonUtc(m.release_date);
      if (!startsAt) continue;

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
      const backdrop = m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null;
      const votes = Number(m.vote_count ?? 0);

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
        popularity: Number(m.popularity) || null,
        url: `https://www.themoviedb.org/movie/${m.id}`,
        genreKeys,
      });

      events.push({
        provider: PROVIDER,
        providerKey: keyFor(PROVIDER, 'release', String(m.id)),
        category: CATEGORY,
        subjectKey,
        kind: 'release',
        startsAt,
        timeKnown: false,
        precision: 'day',
        // Already out. The calendar pages filter on this, so a back catalogue
        // cannot flood them however large it grows.
        state: 'out',
        name: m.title,
        summary,
        imageUrl: image,
        backdropUrl: backdrop,
        rating: votes > 0 ? Number(m.vote_average) : null,
        ratingCount: votes || null,
        url: `https://www.themoviedb.org/movie/${m.id}`,
        venue: null,
      });
    }
  }

  return { genres: [...genres.values()], subjects: [...subjects.values()], events };
}

/**
 * Look a title up on TMDB directly.
 *
 * The fallthrough for everything not held locally, which is most of a million
 * films. One request, and whatever it returns can be stored on the way past so the
 * second person to search for it gets a local hit.
 */
export async function searchTitles(term, { apiKey = process.env.TMDB_API_KEY, limit = 12 } = {}) {
  if (!apiKey || !term?.trim()) return [];
  const url = `${BASE}/search/movie?api_key=${apiKey}&include_adult=false&query=${encodeURIComponent(term.trim())}`;
  const res = await getJson(url, { minGapMs: MIN_GAP_MS });
  return (res?.results ?? []).slice(0, limit);
}

/**
 * Turn raw TMDB search results into the catalogue's own shape.
 *
 * Shared with the back-catalogue pass on purpose: a film arrived at by searching
 * should be indistinguishable from one ingested in bulk, or the two paths drift
 * and a searched title ends up without genres or a followable subject.
 */
export function fromSearchResults(results, { genreById = null } = {}) {
  const genres = new Map();
  const subjects = [];
  const events = [];

  for (const m of results ?? []) {
    if (!m?.id || !m.title) continue;
    const startsAt = m.release_date ? noonUtc(m.release_date) : null;
    const subjectKey = keyFor(PROVIDER, 'movie', String(m.id));
    const image = m.poster_path ? `${POSTER}${m.poster_path}` : null;
    const backdrop = m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null;
    const summary = m.overview?.trim() || null;

    /*
     * Search returns genre IDS with no names, and looking the table up would be
     * another request per search. So a searched title carries whatever genre
     * names we can resolve and is otherwise left ungrouped -- the next catalogue
     * pass fills it in properly if it is popular enough to be swept.
     */
    const genreKeys = [];
    for (const gid of m.genre_ids ?? []) {
      const g = genreById?.get(gid);
      if (!g) continue;
      genres.set(g.providerKey, g);
      genreKeys.push(g.providerKey);
    }

    subjects.push({
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
      popularity: Number(m.popularity) || null,
      url: `https://www.themoviedb.org/movie/${m.id}`,
      genreKeys,
    });

    if (!startsAt) continue;
    events.push({
      provider: PROVIDER,
      providerKey: keyFor(PROVIDER, 'release', String(m.id)),
      category: CATEGORY,
      subjectKey,
      kind: 'release',
      startsAt,
      timeKnown: false,
      precision: 'day',
      state: startsAt.getTime() > Date.now() ? 'upcoming' : 'out',
      name: m.title,
      summary,
      imageUrl: image,
      backdropUrl: backdrop,
      rating: Number(m.vote_count ?? 0) > 0 ? Number(m.vote_average) : null,
      ratingCount: Number(m.vote_count ?? 0) || null,
      url: `https://www.themoviedb.org/movie/${m.id}`,
    });
  }

  return { genres: [...genres.values()], subjects, events };
}
