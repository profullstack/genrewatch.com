/**
 * Film, television and anime, mirrored from nichedb.dev.
 *
 * nichedb fetches TMDB, TVmaze, AniList and the IMDb dumps once and keeps them
 * in a `screen` collection that every site of ours reads. This adapter is the
 * reader: it walks that collection and writes the same genres, subjects and
 * events the four local adapters used to write, under the same provider names
 * and provider keys, so every slug and URL this site has ever handed out keeps
 * resolving and no page has to know where its rows came from.
 *
 * Two item kinds, walked separately. A `title` becomes a subject (and the genre
 * rows and edges the local adapters made for it); a `release` becomes an event.
 * Titles are walked first, and releases only once every title has been seen at
 * least once, so an event never arrives before the subject it points at.
 *
 * What makes this safe to run unattended is the cursor. nichedb's read API pages
 * by id and filters by `since` on updated_at, and the wire shape carries no
 * updated_at of its own -- so the cursor is not "the last updated_at seen". It is
 * the floor a walk was started at, plus the last id written inside that walk: a
 * pass that runs out of its page budget resumes by asking for `id > after_id`,
 * and a walk that drains moves the floor to the moment it began. That survives
 * the thing an updated_at cursor cannot, which is a bulk load stamping thousands
 * of rows with one timestamp.
 *
 * The IMDb half is ~430,000 titles on its first day, so the first mirror is a few
 * hours of hourly passes rather than one fetch. See `config.catalog.nichedb`.
 */

import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { getJson } from './http.js';
import { keyFor, normaliseTitle, slugify } from './slug.js';

export const PROVIDER = 'nichedb';

/** The categories nichedb's screen collection covers, and the local adapters it replaces. */
export const CATEGORIES = ['film', 'tv', 'anime'];
export const REPLACES = ['tmdb', 'tvmaze', 'anilist', 'imdb'];

/** nichedb's page ceiling. Asking for more is silently clamped, so ask for exactly this. */
export const PAGE_SIZE = 200;

/** A walk that drains restarts this far before the moment it began. */
const OVERLAP_MS = 10 * 60_000;

/** nichedb allows 600 anonymous requests an hour; a quarter second apart is a tenth of that. */
const MIN_GAP_MS = 250;

/* ------------------------------------------------------------------ genres -- */

/**
 * The genre row each upstream made for a name, exactly as the local adapter did.
 *
 * Every table is unique on (provider, provider_key) and `slug` is unique on its
 * own, so both halves have to match what is already stored or the mirror creates
 * a second "Drama" beside the first. The suffixes (`-film`, `-tv`, `-anime`,
 * `imdb `) are the ones the four adapters chose; they are not cosmetic.
 */
export function genreRow(provider, name, category) {
  switch (provider) {
    case 'tmdb':
      return {
        provider,
        providerKey: keyFor(provider, 'genre', name),
        category: 'film',
        slug: slugify(`${name}-film`),
        name,
        priority: 50,
      };
    case 'tvmaze':
      return {
        provider,
        providerKey: keyFor(provider, 'genre', name),
        category: 'tv',
        slug: slugify(`${name}-tv`),
        name,
        priority: 50,
      };
    case 'anilist':
      return {
        provider,
        providerKey: keyFor(provider, 'genre', name),
        category: 'anime',
        slug: slugify(`${name}-anime`),
        name,
        priority: 50,
      };
    case 'imdb':
      return {
        provider,
        providerKey: keyFor(name),
        category,
        slug: slugify(`imdb ${name}`),
        name,
      };
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- subjects -- */

/** `provider:kind:id` split, or null for anything else. */
export function parseExternalId(externalId) {
  const [provider, kind, ...rest] = String(externalId ?? '').split(':');
  if (!provider || !kind || rest.length === 0) return null;
  return { provider, kind, id: rest[0], rest };
}

/**
 * The (provider, provider_key) a title item maps onto, or null.
 *
 * These are the keys the local adapters built with keyFor, reproduced rather than
 * imported from them so this file does not depend on the modules it replaces.
 */
export function subjectKeyFor(externalId) {
  const p = parseExternalId(externalId);
  if (p?.kind !== 'title') return null;
  switch (p.provider) {
    case 'tmdb':
      return { provider: 'tmdb', providerKey: keyFor('tmdb', 'movie', p.id) };
    case 'tvmaze':
      return { provider: 'tvmaze', providerKey: keyFor('tvmaze', 'show', p.id) };
    case 'anilist':
      return { provider: 'anilist', providerKey: keyFor('anilist', 'anime', p.id) };
    case 'imdb':
      // The tconst, whole. See the local backfill on why it is never slugified.
      return { provider: 'imdb', providerKey: p.id };
    default:
      return null;
  }
}

/** A finite number or null; nichedb serialises absent numbers as null already. */
const numOrNull = (v) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

/** The slug the local backfill gave an IMDb title: readable, and unique by the id. */
const imdbSlug = (title, tconst) => `${slugify(title).slice(0, 60).replace(/-+$/, '')}-${tconst}`;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What nichedb's `tmdb-artwork` enricher found for a title, or null.
 *
 * The enricher asks TMDB `find/{imdbId}` for every title only IMDb listed and
 * keeps the answer under `enrichment['tmdb-artwork']`: the TMDB id, poster,
 * backdrop, synopsis, popularity, rating and the real release day. That is the
 * request the local IMDb→TMDB pass made per row, so its answer is applied here
 * the way that pass applied it. A miss is stored as `{ tmdbId: null }` so the
 * title is never asked again, and is nothing to this side.
 */
export function artworkOf(item) {
  const a = item?.enrichment?.['tmdb-artwork'];
  if (!a || typeof a !== 'object' || !a.tmdbId) return null;
  return {
    tmdbId: String(a.tmdbId),
    category: a.category ?? null,
    form: a.form ?? null,
    imageUrl: a.imageUrl ?? null,
    backdropUrl: a.backdropUrl ?? null,
    summary: typeof a.summary === 'string' && a.summary.trim() ? a.summary.trim() : null,
    popularity: numOrNull(a.popularity),
    rating: numOrNull(a.rating),
    ratingCount: numOrNull(a.ratingCount),
    releaseDate: YMD.test(a.releaseDate ?? '') ? a.releaseDate : null,
  };
}

/**
 * A `title` item as a subject, with the genre rows and keys it needs, or null
 * when the local adapter would have dropped it.
 *
 * The rules are the local adapters' own. TMDB, TVmaze and AniList drop a title
 * with no genre at all -- an untagged row cannot appear anywhere on a genre site
 * and would sit at the top of a page nobody asked for. TVmaze files anime shows
 * under the anime category, where AniList describes them better, and the local
 * adapter DROPPED them rather than hold a second copy; so does this. IMDb keeps
 * everything, genre or not, because a row that can be matched against a playlist
 * is the whole point of that source.
 *
 * @returns {{subject: object, genres: object[]}|null}
 */
export function subjectFrom(item) {
  const key = subjectKeyFor(item?.externalId ?? externalIdOf(item));
  if (!key || !item?.title) return null;
  const d = item.data ?? {};
  const external = parseExternalId(item.externalId ?? externalIdOf(item));
  const genreNames = (Array.isArray(d.genres) ? d.genres : []).filter(Boolean);
  /* The enricher's answer fills what the item lacks and never overrides what it
     has: nichedb has already copied the poster and synopsis onto the item where
     it had none, and the rest -- backdrop, TMDB id, figures -- is read from the
     block itself. IMDb's own rating and vote count stay in front of TMDB's. */
  const art = artworkOf(item);
  const category = d.category ?? categoryFromTags(item.tags) ?? art?.category ?? null;
  if (!CATEGORIES.includes(category)) return null;

  const base = {
    provider: key.provider,
    providerKey: key.providerKey,
    category,
    name: item.title,
    displayName: item.title,
    description: item.summary ?? art?.summary ?? null,
    imageUrl: item.image_url ?? art?.imageUrl ?? null,
    backdropUrl: d.backdropUrl ?? art?.backdropUrl ?? null,
    url: item.url ?? null,
    // Through THIS site's normaliser, not nichedb's copy of it: the same function
    // has to produce the search key and the playlist match key, and '' for a
    // title with no Latin characters is a value the backfill relies on.
    normTitle: normaliseTitle(item.title),
    year: numOrNull(d.year),
    rating: numOrNull(d.rating) ?? art?.rating ?? null,
    ratingCount: numOrNull(d.ratingCount) ?? art?.ratingCount ?? null,
    popularity: numOrNull(d.popularity) ?? art?.popularity ?? null,
    // Known up front for a TMDB title; for anything else, what the enricher found.
    tmdbId: art?.tmdbId ?? null,
  };

  let subject;
  switch (key.provider) {
    case 'tmdb':
      if (genreNames.length === 0 || category !== 'film') return null;
      subject = {
        ...base,
        kind: 'film',
        slug: slugify(item.title, external.id),
        tmdbId: external.id,
      };
      break;
    case 'tvmaze':
      if (genreNames.length === 0 || category !== 'tv') return null;
      subject = { ...base, kind: 'show', slug: slugify(item.title, external.id) };
      break;
    case 'anilist':
      if (genreNames.length === 0 || category !== 'anime') return null;
      subject = { ...base, kind: 'anime', slug: slugify(item.title, external.id) };
      break;
    case 'imdb':
      subject = {
        ...base,
        kind: (d.form ?? art?.form) === 'series' ? 'show' : 'film',
        slug: imdbSlug(item.title, external.id),
        imdbId: external.id,
        // Fame as a popularity figure, so IMDb rows rank against TMDB rows. The
        // vote count, which is what "how many people know this" measures there;
        // TMDB's own figure only for a title nobody has voted on.
        popularity: numOrNull(d.ratingCount) ?? art?.popularity ?? null,
        // Carried for the synthetic year event and the link below; not columns.
        _runtimeMin: numOrNull(d.runtimeMin),
        _artwork: art,
      };
      break;
    default:
      return null;
  }

  const genres = genreNames.map((n) => genreRow(key.provider, n, category)).filter(Boolean);
  subject.genreKeys = genres.map((g) => g.providerKey);
  return { subject, genres };
}

/** The `<category>` facet off an item's tags, for a title whose data omits it. */
function categoryFromTags(tags) {
  return (tags ?? []).find((t) => CATEGORIES.includes(t)) ?? null;
}

/**
 * The item's externalId, which nichedb's wire shape does not carry.
 *
 * `itemOut` serialises id, kind, title, url, `data` and the rest, and not the
 * `<provider>:<kind>:<id>` the adapters dedupe on. So it is rebuilt here from
 * what IS on the wire: the upstream ids a title's `data` carries; a release's
 * type and TMDB id; an AniList airing's media id and episode; and for a TVmaze
 * episode, whose id is nowhere in `data`, the episode id from its canonical URL
 * (`tvmaze.com/episodes/<id>/...`). A row that carries an `external_id` of its
 * own is believed first, so a nichedb that starts sending one needs no change.
 */
export function externalIdOf(item) {
  if (item?.external_id) return item.external_id;
  if (item?.externalId) return item.externalId;
  const d = item?.data ?? {};
  if (item?.kind === 'title') {
    if (d.provider === 'tmdb' && d.tmdbId) return `tmdb:title:${d.tmdbId}`;
    if (d.provider === 'tvmaze' && d.tvmazeId) return `tvmaze:title:${d.tvmazeId}`;
    if (d.provider === 'anilist' && d.anilistId) return `anilist:title:${d.anilistId}`;
    if (d.provider === 'imdb' && d.imdbId) return `imdb:title:${d.imdbId}`;
    return null;
  }
  if (item?.kind !== 'release') return null;
  const title = parseExternalId(d.titleExternalId);
  switch (d.provider) {
    case 'tmdb': {
      const id = d.tmdbId ?? title?.id;
      if (!id) return null;
      const service = d.venue ? `:${slugify(d.venue)}` : '';
      if (d.type === 'theatrical') return `tmdb:release:${id}`;
      if (d.type === 'digital') return `tmdb:digital:${id}`;
      if (d.type === 'stream') return `tmdb:stream:${id}${service}`;
      return null;
    }
    case 'tvmaze': {
      const m = String(item.url ?? '').match(/\/episodes\/(\d+)(?:[/?#]|$)/);
      return m ? `tvmaze:episode:${m[1]}` : null;
    }
    case 'anilist':
      return title?.id ? `anilist:airing:${title.id}:${d.number ?? 0}` : null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ events -- */

/** The local detail pass kept this many providers of each kind, not overall. */
const WATCH_PER_KIND = 6;

/**
 * Everywhere a title can be watched, as the `[{ name, kind }]` the event page
 * reads: `flatrate`, `rent` and `buy`, each capped as the local detail pass
 * capped them, so fifteen rental storefronts cannot push the one subscription
 * that carries a film off the end of the list.
 *
 * `providers` is the region's three lists apart, and is read first. An item
 * detailed before that split carries only `watch`, the flat-rate names, and it
 * is read as what it was -- flat-rate -- so an older title still says something
 * rather than nothing.
 */
export function watchFrom(d) {
  const names = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((n) => typeof n === 'string' && n.trim())
      .slice(0, WATCH_PER_KIND);
  const p = d?.providers;
  const split = [
    ...names(p?.stream).map((name) => ({ name, kind: 'flatrate' })),
    ...names(p?.rent).map((name) => ({ name, kind: 'rent' })),
    ...names(p?.buy).map((name) => ({ name, kind: 'buy' })),
  ];
  if (split.length) return split;
  return (Array.isArray(d?.watch) ? d.watch : [])
    .map((w) => (typeof w === 'string' ? { name: w, kind: 'flatrate' } : w))
    .filter((w) => w?.name)
    .slice(0, WATCH_PER_KIND);
}

/**
 * The detail block a TMDB title carries, in the shape the event page reads.
 *
 * The watch providers come from `watchFrom` above, and the home dates sit
 * beside them. Only a detailed title has any of this; an undetailed one yields
 * null so the event's existing detail is never blanked by a coalesce.
 */
export function detailFromTitle(title) {
  const d = title?.data ?? {};
  if (!d.detailed) return null;
  return {
    cast: Array.isArray(d.cast) ? d.cast : [],
    director: d.director ?? null,
    studios: Array.isArray(d.studios) ? d.studios : [],
    language: d.language ?? null,
    watch: watchFrom(d),
    digital: d.digitalDate ?? null,
    streaming: d.streaming ?? null,
    imdbId: d.imdbId ?? null,
  };
}

/**
 * A `release` item as an event, or null when it is not one this site files.
 *
 * `providerKey` is the local adapter's, so a film's three rows -- cinemas, rent
 * or buy, the service -- land on the rows the streaming-dates pass already made
 * for it. nichedb suffixes the service onto its stream id; the local key never
 * did, so it is dropped here.
 *
 * `title` is the subject's item when the caller has it (a TMDB title carries the
 * detail its releases are shown with); `now` decides upcoming from out.
 */
export function eventFrom(item, { title = null, now = new Date() } = {}) {
  const d = item?.data ?? {};
  const p = parseExternalId(item?.externalId ?? externalIdOf(item));
  const subject = subjectKeyFor(d.titleExternalId);
  if (!p || !subject || !item.title || !item.published_at) return null;
  const startsAt = new Date(item.published_at);
  if (Number.isNaN(startsAt.getTime())) return null;
  const category = d.category ?? categoryFromTags(item.tags);
  if (!CATEGORIES.includes(category)) return null;

  const base = {
    provider: subject.provider,
    category,
    subjectKey: subject.providerKey,
    startsAt,
    timeKnown: item.time_known === true,
    precision: item.precision ?? (item.time_known ? 'minute' : 'day'),
    state: startsAt.getTime() > now.getTime() ? 'upcoming' : 'out',
    name: item.title,
    summary: item.summary ?? null,
    url: item.url ?? null,
    rating: numOrNull(d.rating),
    runtimeMin: numOrNull(d.runtimeMin) ?? numOrNull(title?.data?.runtimeMin),
  };
  const td = title?.data ?? {};

  switch (subject.provider) {
    case 'tmdb': {
      if (category !== 'film') return null;
      const slot = { theatrical: 'release', digital: 'digital', stream: 'stream' }[d.type];
      if (!slot) return null;
      /* The shops on a rent-or-buy row, the one service on a stream row. The
         venue is what the streaming-dates pass wrote -- "Rent or buy", or the
         service's name -- and the service list is where that name comes from
         when the row arrives without a venue of its own. The shops themselves
         are shown from the title's providers, with rent and buy told apart,
         which a merged list cannot do; so they are not written over that. */
      const services = (Array.isArray(d.services) ? d.services : []).filter(
        (x) => typeof x === 'string' && x.trim(),
      );
      const venueFor = { release: 'Cinemas', digital: 'Rent or buy' };
      return {
        ...base,
        providerKey: keyFor('tmdb', slot, p.id),
        kind: 'release',
        shortName: null,
        // The poster is the event image and the backdrop is the wide one, as the
        // local adapter stored them; nichedb leads with the backdrop.
        imageUrl: d.posterUrl ?? item.image_url ?? null,
        backdropUrl: d.backdropUrl ?? null,
        ratingCount: numOrNull(d.ratingCount),
        tagline: td.tagline ?? null,
        trailerUrl: td.trailerUrl ?? null,
        detail: detailFromTitle(title),
        venue: d.venue ?? (slot === 'stream' ? (services[0] ?? null) : venueFor[slot]),
        // The local rows never carried a region here, and "Rent or buy, US" on a
        // page that quotes one country's dates throughout reads as a mistake.
        venueRegion: null,
        season: null,
        number: null,
      };
    }
    case 'tvmaze':
      if (category !== 'tv') return null;
      return {
        ...base,
        providerKey: keyFor('tvmaze', 'episode', p.id),
        kind: d.episodeType ?? 'episode',
        shortName: d.episodeName ?? null,
        imageUrl: item.image_url ?? d.posterUrl ?? null,
        backdropUrl: d.backdropUrl ?? null,
        detail: {
          network: d.venue ?? null,
          language: d.language ?? null,
          status: d.status ?? null,
          officialSite: td.officialSite ?? null,
        },
        venue: d.venue ?? null,
        venueRegion: d.venueRegion ?? null,
        season: numOrNull(d.season),
        number: numOrNull(d.number),
      };
    case 'anilist':
      if (category !== 'anime') return null;
      return {
        ...base,
        // The local key was the airing schedule's own id. nichedb carries it in
        // data; the `<media>:<episode>` external id is the fallback for a row
        // that arrived without one.
        providerKey: d.airingScheduleId
          ? keyFor('anilist', 'airing', d.airingScheduleId)
          : keyFor('anilist', 'airing', `${p.id}-${p.rest[1] ?? 0}`),
        kind: d.episodeType ?? (numOrNull(d.number) === 1 ? 'premiere' : 'episode'),
        shortName: d.number ? `Episode ${d.number}` : null,
        imageUrl: d.posterUrl ?? item.image_url ?? null,
        backdropUrl: d.backdropUrl ?? null,
        trailerUrl: d.trailerUrl ?? td.trailerUrl ?? null,
        detail: {
          studios: (Array.isArray(td.studios) ? td.studios : d.venue ? [d.venue] : []).slice(0, 3),
          format: d.format ?? null,
          episodes: numOrNull(d.episodes),
        },
        venue: d.venue ?? null,
        venueRegion: d.venueRegion ?? 'Japan',
        season: null,
        number: numOrNull(d.number),
      };
    default:
      return null;
  }
}

/**
 * The year-anchored event the local backfill gave a dated IMDb title.
 *
 * IMDb's dumps carry a start year and nothing finer, and nichedb's IMDb source
 * emits no release items at all. The local pass still made one event per dated
 * title -- noon UTC on 1 January, precision year, never remindable -- because an
 * event is the only thing the calendar, the follow page and the artwork pass
 * can see. A title with no year gets no event: inventing a date would put it on
 * a calendar under a year nobody claimed.
 */
export function imdbYearEvent(subject, { now = new Date() } = {}) {
  if (subject?.provider !== 'imdb' || !subject.year) return null;
  /* The real day where the artwork enricher found one, as the local artwork
     pass wrote it over the year anchor: a 2027 film with a date is a date
     somebody can be reminded about, not New Year's Day with everything else. */
  const day = subject._artwork?.releaseDate ?? null;
  const startsAt = day
    ? new Date(`${day}T12:00:00Z`)
    : new Date(Date.UTC(subject.year, 0, 1, 12, 0, 0));
  return {
    provider: 'imdb',
    providerKey: `imdb:release:${subject.providerKey}`,
    category: subject.category,
    subjectKey: subject.providerKey,
    kind: 'release',
    startsAt,
    timeKnown: false,
    precision: day ? 'day' : 'year',
    state: (day ? startsAt.getTime() > now.getTime() : subject.year > now.getUTCFullYear())
      ? 'upcoming'
      : 'out',
    name: subject.name,
    shortName: subject.name,
    // The calendar row renders its own picture, not the subject's; the local
    // artwork pass filled both surfaces for that reason and so does this.
    summary: subject.description ?? null,
    imageUrl: subject.imageUrl ?? null,
    backdropUrl: subject.backdropUrl ?? null,
    rating: subject.rating ?? null,
    ratingCount: subject.ratingCount ?? null,
    runtimeMin: subject._runtimeMin ?? null,
    url: subject.url ?? null,
  };
}

/* ------------------------------------------------------------------ paging -- */

/**
 * One page of the collection, the way a mirror asks for it.
 *
 * Sorted by id ascending and keyset on `after`, filtered by `since` on nichedb's
 * updated_at. Not `sort=updated`: the wire shape does not carry updated_at, so a
 * page sorted that way could never say where the next one starts.
 */
export function pageUrl({ baseUrl, kind, since = null, after = null, limit = PAGE_SIZE }) {
  const qs = new URLSearchParams({
    collection: 'screen',
    kind,
    sort: 'id',
    order: 'asc',
    limit: String(limit),
  });
  if (since) qs.set('since', new Date(since).toISOString());
  if (after) qs.set('after', String(after));
  return `${baseUrl}/api/v1/items?${qs}`;
}

/** `null` from nichedb (a 404) is an empty page, not an error. */
async function fetchPage(http, params) {
  const res = await http(pageUrl(params), { minGapMs: MIN_GAP_MS, timeoutMs: 60_000 });
  return Array.isArray(res?.items) ? res.items : [];
}

/* ------------------------------------------------------------------ writes -- */

/**
 * Write a page of titles: genres, subjects, edges, and the year events IMDb
 * titles get. Returns what it did.
 *
 * IMDb titles go through the local backfill's own link-or-create rule. A tconst
 * this catalogue already holds as its own row is simply updated. One it has never
 * seen is matched against what is already here on (category, normalised title,
 * year) -- so an IMDb row for a film TMDB already gave us enriches that row rather
 * than opening a second page for it -- and only the rest are created, each with
 * its year event, exactly as insertNew did.
 */
export async function writeTitles(items, { db = q, now = new Date() } = {}) {
  const mapped = items.map(subjectFrom).filter(Boolean);
  const genres = new Map();
  for (const m of mapped) for (const g of m.genres) genres.set(g.providerKey, g);
  const genreIds = await db.upsertGenres([...genres.values()]);

  const subjects = mapped.map((m) => m.subject);
  const imdb = subjects.filter((s) => s.provider === 'imdb');
  const others = subjects.filter((s) => s.provider !== 'imdb');

  /* A TMDB film whose IMDb row arrived first, already wearing this TMDB id from
     the artwork enricher, IS that row. It is moved onto the TMDB key before the
     upsert so the upsert updates it in place, rather than opening a second page
     for the same film beside the one every follow and reminder points at. */
  const adopted = await db.adoptImdbSubjectsAsTmdb(
    others
      .filter((s) => s.provider === 'tmdb' && s.tmdbId)
      .map((s) => ({ tmdbId: s.tmdbId, providerKey: s.providerKey })),
  );

  /* The forward providers' rows go in first, so an IMDb title on the same page
     can link to a TMDB or TVmaze row that arrived beside it. */
  const subjectIds = await db.upsertSubjects(others);

  /* Which IMDb rows are already ours, and which of the rest can be linked. */
  const known = imdb.length
    ? await db.subjectsByProviderKeys(imdb.map((s) => s.providerKey))
    : new Map();
  const fresh = imdb.filter((s) => !known.has(s.providerKey));

  /* The exact join first. An IMDb film the artwork enricher matched to a TMDB
     id links to that film's row when this catalogue holds it -- from an earlier
     page or the one just written -- because the tconst is what TMDB itself was
     asked. The title-and-year heuristic is for the rest, as it always was. */
  const tmdbKeyOf = (s) =>
    s.category === 'film' && s._artwork?.tmdbId ? keyFor('tmdb', 'movie', s._artwork.tmdbId) : null;
  const tmdbKeys = [...new Set(fresh.map(tmdbKeyOf).filter(Boolean))];
  const byTmdb = tmdbKeys.length ? await db.subjectsByProviderKeys(tmdbKeys) : new Map();
  const existing = fresh.length
    ? await db.subjectsByNormTitle(
        fresh.map((s) => ({ normTitle: s.normTitle, year: s.year, category: s.category })),
      )
    : new Map();
  const toLink = [];
  const toCreate = [];
  for (const s of fresh) {
    const exact = byTmdb.get(tmdbKeyOf(s))?.id ?? null;
    const hit =
      exact ?? (s.normTitle ? existing.get(`${s.category} ${s.normTitle} ${s.year ?? ''}`) : null);
    if (hit) toLink.push({ subjectId: hit, tconst: s.providerKey, ...s });
    else toCreate.push(s);
  }
  if (toLink.length) await db.linkImdbToSubjects(toLink);

  const imdbToWrite = [...imdb.filter((s) => known.has(s.providerKey)), ...toCreate];
  for (const [k, v] of await db.upsertSubjects(imdbToWrite)) subjectIds.set(k, v);

  /* An IMDb row already held that now carries artwork: the poster, synopsis and
     real day go onto its events too, exactly as the local artwork pass wrote
     them, because a calendar row renders its own picture and not the subject's.
     A row created just now gets all of that on its year event below instead. */
  const illustrated = imdb
    .filter((s) => known.has(s.providerKey) && s._artwork)
    .map((s) => ({
      subjectId: subjectIds.get(s.providerKey),
      matched: true,
      tmdbId: s._artwork.tmdbId,
      imageUrl: s.imageUrl,
      backdropUrl: s.backdropUrl,
      summary: s.description,
      rating: s.rating,
      ratingCount: s.ratingCount,
      releaseDate: s._artwork.releaseDate,
    }))
    .filter((r) => r.subjectId);
  if (illustrated.length) await db.saveImdbMeta(illustrated);
  const toWrite = [...others, ...imdbToWrite];
  await db.replaceSubjectGenres(
    toWrite
      .map((s) => ({
        subjectId: subjectIds.get(s.providerKey),
        genreIds: (s.genreKeys ?? []).map((k) => genreIds.get(k)).filter(Boolean),
      }))
      .filter((r) => r.subjectId),
  );

  /* Newly created IMDb titles get their year event, as the local pass gave them.
     Rows already held do not: the artwork pass may since have given that event a
     real date, and rewriting the year anchor over it would undo that. */
  const events = toCreate.map((s) => imdbYearEvent(s, { now })).filter(Boolean);
  const rows = events
    .map((e) => ({ ...e, subjectId: subjectIds.get(e.subjectKey) }))
    .filter((e) => e.subjectId);
  if (rows.length) {
    const eventIds = await db.upsertEvents(rows);
    await db.replaceEventGenres(
      rows
        .map((e) => ({
          eventId: eventIds.get(e.providerKey),
          genreIds: (toCreate.find((s) => s.providerKey === e.subjectKey)?.genreKeys ?? [])
            .map((k) => genreIds.get(k))
            .filter(Boolean),
        }))
        .filter((r) => r.eventId && r.genreIds.length),
    );
  }

  /* A detailed TMDB title pushes its detail onto the events that show it. The
     release rows carry a copy too, but a title can be re-detailed on its own. */
  const detailed = items
    .filter((i) => i?.data?.provider === 'tmdb' && i.data.detailed)
    .map((i) => {
      const key = subjectKeyFor(i.externalId ?? externalIdOf(i));
      const subjectId = key && subjectIds.get(key.providerKey);
      return subjectId
        ? {
            subjectId,
            provider: 'tmdb',
            runtimeMin: numOrNull(i.data.runtimeMin),
            tagline: i.data.tagline ?? null,
            trailerUrl: i.data.trailerUrl ?? null,
            detail: detailFromTitle(i),
          }
        : null;
    })
    .filter(Boolean);
  if (detailed.length) await db.applyTitleDetailToEvents(detailed);

  return {
    genres: genres.size,
    subjects: toWrite.length,
    linked: toLink.length,
    created: toCreate.length,
    adopted,
    illustrated: illustrated.length,
    events: rows.length,
    dropped: items.length - mapped.length,
    // Handed back so the pass can push it again once the releases are in.
    detailed,
  };
}

/**
 * Write a page of releases as events, resolving each one's subject from the
 * catalogue and copying that subject's genres onto the event.
 *
 * An event whose subject is not here is counted and skipped rather than given a
 * subject invented from its title: a thin subject with a wrong slug is a page
 * that never goes away. The title walk runs first precisely so this is rare.
 */
export async function writeReleases(items, { db = q, now = new Date() } = {}) {
  const mapped = items.map((i) => eventFrom(i, { now })).filter(Boolean);
  if (mapped.length === 0) return { events: 0, orphaned: 0, dropped: items.length };

  const subjects = await db.subjectsByProviderKeys([...new Set(mapped.map((e) => e.subjectKey))]);
  const rows = [];
  let orphaned = 0;
  for (const e of mapped) {
    const subjectId = subjects.get(e.subjectKey)?.id;
    if (!subjectId) {
      orphaned++;
      continue;
    }
    rows.push({ ...e, subjectId });
  }
  if (rows.length === 0)
    return { events: 0, orphaned, dropped: items.length - mapped.length, subjectIds: [] };

  const eventIds = await db.upsertEvents(rows);

  /* A rent-or-buy or streaming row arrives weeks after the cinema row, on a page
     of its own. The title's cast, trailer and watch providers were pushed onto
     the events that existed when the title was walked, and this one was not: so
     it takes them from the sibling that was, where it has none of its own. */
  const tmdbEventIds = rows
    .filter((r) => r.provider === 'tmdb')
    .map((r) => eventIds.get(r.providerKey))
    .filter(Boolean);
  if (tmdbEventIds.length) await db.fillEventDetailFromSiblings(tmdbEventIds);

  const genresOf = await db.genreIdsForSubjects(rows.map((r) => r.subjectId));
  await db.replaceEventGenres(
    rows
      .map((e) => ({
        eventId: eventIds.get(e.providerKey),
        genreIds: genresOf.get(e.subjectId) ?? [],
      }))
      .filter((r) => r.eventId && r.genreIds.length),
  );
  return {
    events: rows.length,
    orphaned,
    dropped: items.length - mapped.length,
    subjectIds: [...new Set(rows.map((r) => r.subjectId))],
  };
}

/* -------------------------------------------------------------------- sync -- */

const KINDS = ['title', 'release'];

/**
 * One pass: continue or start a walk per kind, inside a page budget and a
 * deadline, writing and recording the cursor after every page.
 *
 * Injectable on purpose. `http` is the JSON fetcher, `db` the query module and
 * `now` the clock, so the walk, the resume and the idempotence of a re-run can be
 * tested against fixtures without a network or a server.
 */
export async function sync({
  log = console.log,
  http = getJson,
  db = q,
  now = () => new Date(),
  baseUrl = config.catalog.nichedb.url,
  pagesPerPass = config.catalog.nichedb.pagesPerPass,
  deadlineMs = config.catalog.nichedb.deadlineMs,
} = {}) {
  const started = now().getTime();
  const deadline = started + deadlineMs;
  let budget = Math.max(1, pagesPerPass);
  const out = { pages: 0, titles: 0, releases: 0, events: 0, linked: 0, orphaned: 0, walks: {} };

  /* The detail of every title walked this pass, and the subjects whose releases
     were written after it. Titles go first so a release never precedes its
     subject -- which also means a title's detail is pushed before the events
     that show it exist. Pushed once more at the end, for those subjects only. */
  const detailedThisPass = new Map();
  const releasedThisPass = new Set();

  const titleCursor = await db.nichedbCursor('title');

  for (const kind of KINDS) {
    if (budget <= 0 || now().getTime() >= deadline) break;
    /* Releases wait until every title has been seen once, so no event arrives
       before its subject. On the very first mirror that is the IMDb walk, which
       is a working day of passes; the local rows serve the pages meanwhile. */
    if (kind === 'release' && !(titleCursor?.walked_at || out.walks.title?.drained)) {
      log('[nichedb] releases wait for the first title walk to finish');
      break;
    }

    const cursor = kind === 'title' ? titleCursor : await db.nichedbCursor(kind);
    const walkStartedAt = cursor?.walk_started_at ? new Date(cursor.walk_started_at) : now();
    const since = cursor?.since ? new Date(cursor.since) : null;
    let afterId = cursor?.after_id ? Number(cursor.after_id) : null;
    const walk = { pages: 0, items: 0, drained: false, resumed: Boolean(cursor?.walk_started_at) };
    out.walks[kind] = walk;

    while (budget > 0 && now().getTime() < deadline) {
      const page = await fetchPage(http, { baseUrl, kind, since, after: afterId });
      budget--;
      walk.pages++;
      out.pages++;

      if (page.length) {
        const wrote =
          kind === 'title'
            ? await writeTitles(page, { db, now: now() })
            : await writeReleases(page, { db, now: now() });
        walk.items += page.length;
        if (kind === 'title') {
          out.titles += wrote.subjects;
          out.events += wrote.events;
          out.linked += wrote.linked;
          for (const r of wrote.detailed ?? []) detailedThisPass.set(r.subjectId, r);
        } else {
          out.releases += wrote.events;
          out.events += wrote.events;
          out.orphaned += wrote.orphaned;
          for (const id of wrote.subjectIds ?? []) releasedThisPass.add(id);
        }
        afterId = Math.max(afterId ?? 0, ...page.map((i) => Number(i.id) || 0));
      }

      const drained = page.length < PAGE_SIZE;
      if (drained) {
        walk.drained = true;
        /* The walk is complete: the next one starts from just before this one
           began, so anything that changed while it ran is caught, and it starts
           from the top of the id order. */
        await db.saveNichedbCursor(kind, {
          since: new Date(walkStartedAt.getTime() - OVERLAP_MS),
          afterId: null,
          walkStartedAt: null,
          walkedAt: now(),
          pages: 1,
          items: page.length,
          note: `walk drained after ${walk.pages} page(s)`,
        });
        break;
      }
      /* Mid-walk: the floor stays where the walk began and the id moves on. */
      await db.saveNichedbCursor(kind, {
        since,
        afterId,
        walkStartedAt,
        walkedAt: null,
        pages: 1,
        items: page.length,
        note: `walking, ${walk.pages} page(s) this pass`,
      });
    }

    log(
      `[nichedb] ${kind}: ${walk.pages} page(s), ${walk.items} item(s)` +
        `${walk.resumed ? ', resumed' : ''}${walk.drained ? ', drained' : ', more to do'}`,
    );
  }

  const again = [...detailedThisPass.values()].filter((r) => releasedThisPass.has(r.subjectId));
  if (again.length) await db.applyTitleDetailToEvents(again);

  const secs = Math.round((now().getTime() - started) / 1000);
  log(
    `[nichedb] ${out.pages} request(s): ${out.titles} titles, ${out.releases} releases` +
      `${out.linked ? `, ${out.linked} linked` : ''}` +
      `${out.orphaned ? `, ${out.orphaned} orphaned` : ''} in ${secs}s`,
  );
  return {
    ...out,
    // The orchestrator's summary reads these three.
    genres: 0,
    subjects: out.titles,
    seconds: secs,
  };
}

export const adapter = { name: PROVIDER, categories: CATEGORIES, sync };
