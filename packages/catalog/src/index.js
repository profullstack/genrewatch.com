/**
 * The sync orchestrator: five providers in, one calendar out.
 *
 * Each adapter answers the same question -- "what is coming, in your category" --
 * and returns three flat lists cross-referenced by provider key. This module is
 * what turns those keys into database ids and writes them, so no adapter ever
 * needs to know what is already stored, and adding a sixth category means adding
 * a file rather than touching this one.
 *
 * Cadence is per category rather than global, which is the main thing this has
 * that the sibling sports site does not. Its one provider could be swept on one
 * clock; these five differ by three orders of magnitude in what they will
 * tolerate. TV is one request for the whole calendar and can run hourly;
 * spaceflight gets fifteen requests an HOUR in total and must not.
 */

import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import * as anilist from './anilist.js';
import * as musicbrainz from './musicbrainz.js';
import * as spacedevs from './spacedevs.js';
import * as tmdb from './tmdb.js';
import * as tvmaze from './tvmaze.js';

/**
 * Every adapter, with the cadence its provider will actually tolerate.
 *
 * `minIntervalMinutes` is enforced against the last COMPLETED sync recorded in
 * the database, not against a timer. This is the same lesson trap 4 taught the
 * sibling repo: a repeatable job's timer resets on every deploy, so on a busy day
 * a 6-hourly sweep can be pushed forward forever and never run at all. Data is
 * the only honest clock.
 */
const REGISTRY = [
  {
    name: 'tvmaze',
    category: 'tv',
    module: tvmaze,
    // One request for the entire forward schedule. It can afford to be frequent.
    minIntervalMinutes: 180,
  },
  {
    name: 'anilist',
    category: 'anime',
    module: anilist,
    minIntervalMinutes: 360,
  },
  {
    name: 'tmdb',
    category: 'film',
    module: tmdb,
    // Release dates move by the week, not the hour.
    minIntervalMinutes: 720,
  },
  {
    name: 'spacedevs',
    category: 'space',
    module: spacedevs,
    /*
     * Hourly, and no faster.
     *
     * Fifteen requests per hour is the entire anonymous budget for the whole
     * deployment. Two pages per pass leaves headroom for a retry; a second pass
     * inside the hour does not.
     *
     * Ordered BEFORE music deliberately. This pass is two requests and five
     * seconds; music is one request per second with a slow upstream, and on the
     * first production sync it held the queue long enough that spaceflight --
     * which only gets one chance an hour -- had still not run twenty minutes
     * later. The cheap, tightly-budgeted provider goes first.
     */
    minIntervalMinutes: 60,
  },
  {
    name: 'musicbrainz',
    category: 'music',
    module: musicbrainz,
    // One request per second, and the artist-genre backfill is the slow part.
    // Running this often does not make it finish sooner; it just re-reads.
    minIntervalMinutes: 720,
  },
];

/** The adapters this deployment has enabled, in registry order. */
export function adapters() {
  const enabled = new Set(config.catalog.providers);
  return REGISTRY.filter((a) => enabled.has(a.name));
}

/** Categories this site serves, for menus and validation. */
export const CATEGORIES = ['tv', 'film', 'anime', 'music', 'space'];

/**
 * Categories that exist as a link rather than as data.
 *
 * Sports is a real thing readers look for and a thing we deliberately do not
 * store: tipoffwatch.com already does fixtures, scores and broadcast markets
 * properly, and a thin second copy would be worse than a signpost. The route
 * layer turns this into a redirect.
 */
export const EXTERNAL_CATEGORIES = {
  sports: 'https://tipoffwatch.com',
};

/**
 * Run one adapter and write everything it found.
 *
 * The write order is forced by the foreign keys -- genres, then subjects, then
 * the subject/genre edges, then events, then the event/genre edges -- and each
 * step resolves the previous step's provider keys into ids. A partial failure
 * leaves the catalogue consistent because each step is itself a bulk upsert:
 * worst case a category is a pass out of date, which is the normal state anyway.
 */
export async function syncOne(entry, { log = console.log, force = false } = {}) {
  const { name, category, module, minIntervalMinutes } = entry;

  if (!force) {
    const last = await q.lastSyncedAt(category);
    if (last) {
      const ageMin = (Date.now() - last.getTime()) / 60_000;
      if (ageMin < minIntervalMinutes) {
        log(`[sync] ${name}: fresh (${Math.round(ageMin)}m old, needs ${minIntervalMinutes}m)`);
        return { name, category, skipped: 'fresh' };
      }
    }
  }

  const started = Date.now();

  /*
   * Music alone gets a warm cache handed to it.
   *
   * Its genre backfill is one upstream request per artist at one request per
   * second, so the adapter has to know which artists have already been asked
   * about -- including the ones that came back with nothing, which is most of
   * them. Passing the answer in is what makes the backfill converge instead of
   * spending its whole budget re-learning the same negatives every pass.
   */
  const extra = {};
  if (category === 'music') {
    extra.genreCache = await q.knownSubjectGenres(category);
    extra.lookupBudget = config.catalog.musicLookupBudget;
    /*
     * And a wall-clock ceiling.
     *
     * MusicBrainz is rate limited to one request a second and its response times
     * are not reliable -- probing it from a dev box produced read timeouts more
     * than once. With retries on top, a bad afternoon turns twelve pages into
     * twenty minutes, and because the pass is sequential every provider after it
     * waits. The budget is a floor on progress rather than a target: whatever has
     * been collected when it expires is written, and the rest arrives next pass.
     */
    extra.deadlineMs = config.catalog.musicDeadlineMs;
  }

  const result = await module.fetchAll({
    from: new Date(),
    horizonDays: config.catalog.horizonDays,
    ...extra,
  });

  if (result.skipped) {
    log(`[sync] ${name}: skipped (${result.skipped})`);
    return { name, category, skipped: result.skipped };
  }

  const genreIds = await q.upsertGenres(result.genres);
  const subjectIds = await q.upsertSubjects(result.subjects);

  await q.replaceSubjectGenres(
    result.subjects
      .map((s) => ({
        subjectId: subjectIds.get(s.providerKey),
        genreIds: (s.genreKeys ?? []).map((k) => genreIds.get(k)).filter(Boolean),
      }))
      .filter((r) => r.subjectId),
  );

  /*
   * Drop events whose subject did not resolve.
   *
   * It should not happen -- every event names a subject the same payload
   * declared -- but subject_id is NOT NULL, so an unresolved key would abort the
   * whole batch and lose a good sync over one bad row. Counting them makes the
   * problem visible instead of silent.
   */
  const rows = [];
  let orphaned = 0;
  for (const e of result.events) {
    const subjectId = subjectIds.get(e.subjectKey);
    if (!subjectId) {
      orphaned++;
      continue;
    }
    rows.push({ ...e, subjectId });
  }

  const eventIds = await q.upsertEvents(rows);

  // An event's genres are its subject's genres, denormalised so a genre page is
  // one index scan rather than a join across the whole calendar.
  await q.replaceEventGenres(
    rows
      .map((e) => ({
        eventId: eventIds.get(e.providerKey),
        genreIds: (result.subjects.find((s) => s.providerKey === e.subjectKey)?.genreKeys ?? [])
          .map((k) => genreIds.get(k))
          .filter(Boolean),
      }))
      .filter((r) => r.eventId && r.genreIds.length),
  );

  // Only a completed pass stamps the clock. See the note on the registry.
  await q.markCategorySynced(category);

  const secs = Math.round((Date.now() - started) / 1000);
  log(
    `[sync] ${name}: ${result.genres.length} genres, ${result.subjects.length} subjects, ` +
      `${rows.length} events${orphaned ? `, ${orphaned} orphaned` : ''}` +
      `${result.lookupsSpent ? `, ${result.lookupsSpent} lookups` : ''} in ${secs}s`,
  );

  return {
    name,
    category,
    genres: result.genres.length,
    subjects: result.subjects.length,
    events: rows.length,
    orphaned,
    seconds: secs,
  };
}

/**
 * Run every enabled adapter, one at a time.
 *
 * Sequential on purpose. Running them concurrently would finish sooner and buy
 * nothing -- the slow ones are slow because their provider throttles them, not
 * because we are waiting on ourselves -- while making a rate-limit failure in one
 * category hard to attribute in the log.
 */
export async function syncAll({ log = console.log, only = null, force = false } = {}) {
  const list = adapters().filter((a) => !only || a.name === only || a.category === only);
  if (list.length === 0) {
    log(`[sync] nothing to run${only ? ` for "${only}"` : ''}`);
    return [];
  }

  const out = [];
  for (const entry of list) {
    try {
      out.push(await syncOne(entry, { log, force }));
    } catch (err) {
      // One provider being down is not a reason to skip the other four.
      log(`[sync] ${entry.name}: FAILED ${err.message}`);
      out.push({ name: entry.name, category: entry.category, error: err.message });
    }
  }
  return out;
}

/** True when any enabled category has not completed a pass inside its interval. */
export async function anythingStale() {
  for (const entry of adapters()) {
    const last = await q.lastSyncedAt(entry.category);
    if (!last) return true;
    if ((Date.now() - last.getTime()) / 60_000 >= entry.minIntervalMinutes) return true;
  }
  return false;
}

export {
  channelsForTitle,
  entryKind,
  groupsOf,
  isPlaceholder,
  MAX_CHANNELS,
  oneChannelM3u,
  parseM3u,
  rankChannelsForTitle,
} from './m3u.js';
export { keyFor, normaliseTitle, slugify } from './slug.js';

/**
 * Fill in the detail that costs a request per title.
 *
 * Separate from the catalogue pass because it scales with the number of FILMS
 * rather than the number of pages: everything else here is a handful of requests
 * however big the result, and this one is one per title. So it is budgeted, it
 * takes the soonest events first, and it stamps every attempt -- including the
 * ones that find nothing -- so a title with no cast listed is not re-fetched
 * every hour for the rest of its life.
 *
 * Only TMDB needs this. The other providers hand over everything they have in the
 * response we already make.
 */
export async function syncDetail({ log = console.log, limit = 120 } = {}) {
  if (!brandProviders().includes('tmdb')) return { skipped: 'tmdb not enabled' };

  const pending = await q.eventsNeedingDetail({ provider: 'tmdb', limit });
  if (pending.length === 0) return { enriched: 0 };

  // provider_key is "tmdb:release:<id>"; the id is the last segment.
  const byId = new Map(pending.map((r) => [String(r.provider_key).split(':').pop(), r.id]));
  const details = await tmdb.fetchDetail([...byId.keys()], {
    apiKey: config.catalog.tmdbKey,
    limit,
  });

  const rows = details
    .map((d) => ({ ...d, eventId: byId.get(d.providerId) }))
    .filter((d) => d.eventId);
  const saved = await q.saveEventDetail(rows);

  /*
   * Stamp the ones that came back with nothing too.
   *
   * Without this they stay pending forever and the budget is spent re-asking
   * about the same handful of titles every pass, so the queue never drains and
   * nothing further along it is ever reached.
   */
  const answered = new Set(rows.map((r) => r.eventId));
  const silent = pending.map((p) => p.id).filter((id) => !answered.has(id));
  await q.markDetailAttempted(silent);

  log(`[sync] detail: ${saved} enriched, ${silent.length} had nothing`);
  return { enriched: saved, empty: silent.length };
}

/** The provider names this deployment has switched on. */
function brandProviders() {
  return config.catalog.providers;
}

/**
 * Search locally, then ask TMDB for whatever we do not hold.
 *
 * The local catalogue is a few thousand titles; TMDB has about a million. Bulk
 * ingesting the rest is neither possible nor useful, so anything not found here
 * is looked up live and written down on the way past -- which means the second
 * person to search for a film gets a local hit, and the catalogue grows towards
 * what people actually ask for rather than towards what an ingest script guessed.
 *
 * The fallthrough only runs when the local answer is thin. A search that already
 * has good matches should not pay a network round trip to append worse ones.
 */
export async function searchWithFallthrough(term, { limit = 30, category = null } = {}) {
  const local = await q.searchCatalogue(term, { limit, category });
  const strong = local.filter((r) => Number(r.score) >= 0.35 || r.upcoming > 0);
  if (strong.length >= 5 || !config.catalog.tmdbKey) return local;
  if (category && category !== 'film') return local;

  let found = [];
  try {
    found = await tmdb.searchTitles(term, { apiKey: config.catalog.tmdbKey });
  } catch {
    // A search box must not fail because an upstream did.
    return local;
  }
  if (found.length === 0) return local;

  const ingested = await ingestSearchResults(found);
  // Local rows first: they are the ones we know something about.
  const seen = new Set(local.map((r) => r.id));
  return [...local, ...ingested.filter((r) => !seen.has(r.id))].slice(0, limit);
}

/**
 * Write live search results into the catalogue.
 *
 * Same shape the back-catalogue pass produces, so a title arrived at by searching
 * is indistinguishable from one that was ingested in bulk -- it has genres, a
 * poster, a release event, and it can be followed.
 */
async function ingestSearchResults(results) {
  const rows = tmdb.fromSearchResults(results);
  if (rows.subjects.length === 0) return [];

  const genreIds = await q.upsertGenres(rows.genres);
  const subjectIds = await q.upsertSubjects(rows.subjects);
  await q.replaceSubjectGenres(
    rows.subjects
      .map((s) => ({
        subjectId: subjectIds.get(s.providerKey),
        genreIds: (s.genreKeys ?? []).map((k) => genreIds.get(k)).filter(Boolean),
      }))
      .filter((r) => r.subjectId),
  );

  const events = rows.events
    .map((e) => ({ ...e, subjectId: subjectIds.get(e.subjectKey) }))
    .filter((e) => e.subjectId);
  const eventIds = await q.upsertEvents(events);
  await q.replaceEventGenres(
    events
      .map((e) => ({
        eventId: eventIds.get(e.providerKey),
        genreIds: (rows.subjects.find((s) => s.providerKey === e.subjectKey)?.genreKeys ?? [])
          .map((k) => genreIds.get(k))
          .filter(Boolean),
      }))
      .filter((r) => r.eventId && r.genreIds.length),
  );

  return rows.subjects
    .map((s) => ({
      id: subjectIds.get(s.providerKey),
      slug: s.slug,
      display_name: s.displayName,
      category: s.category,
      kind: s.kind,
      image_url: s.imageUrl,
      backdrop_url: s.backdropUrl,
      description: s.description,
      popularity: s.popularity,
      upcoming: 0,
    }))
    .filter((r) => r.id);
}

/**
 * Fill in the back catalogue, a slice at a time.
 *
 * Popularity-ordered and paged, so each pass takes the next slice and the whole
 * thing arrives over a few hours rather than in one enormous burst. It only ever
 * needs doing once -- what was released in 1999 does not change -- so the cursor
 * stops when it reaches the end and the pass becomes a no-op.
 *
 * Everything here is stored with state 'out', which is what keeps a few thousand
 * old films off the calendar pages: those filter on it.
 */
export async function syncBackCatalogue({ log = console.log, pages = 25 } = {}) {
  if (!config.catalog.providers.includes('tmdb') || !config.catalog.tmdbKey) {
    return { skipped: 'tmdb not enabled' };
  }

  const done = await q.backCataloguePagesDone();
  if (done >= config.catalog.backCataloguePages) return { done: true, pages: done };

  const startPage = done + 1;
  const result = await tmdb.fetchBackCatalogue({
    apiKey: config.catalog.tmdbKey,
    pages,
    startPage,
  });
  if (result.skipped) return result;

  const genreIds = await q.upsertGenres(result.genres);
  const subjectIds = await q.upsertSubjects(result.subjects);
  await q.replaceSubjectGenres(
    result.subjects
      .map((s) => ({
        subjectId: subjectIds.get(s.providerKey),
        genreIds: (s.genreKeys ?? []).map((k) => genreIds.get(k)).filter(Boolean),
      }))
      .filter((r) => r.subjectId),
  );
  const events = result.events
    .map((e) => ({ ...e, subjectId: subjectIds.get(e.subjectKey) }))
    .filter((e) => e.subjectId);
  await q.upsertEvents(events);
  await q.setBackCataloguePagesDone(startPage + pages - 1);

  log(`[sync] back catalogue: pages ${startPage}-${startPage + pages - 1}, ${events.length} films`);
  return { pages: startPage + pages - 1, films: events.length };
}
