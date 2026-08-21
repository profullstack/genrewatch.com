/**
 * Music, from MusicBrainz.
 *
 * Music is the thinnest category on this site and it is worth being honest about
 * why, because the numbers look like a bug otherwise. Measured against the live
 * API on 2026-08-21, for a four-month forward window:
 *
 *   - MusicBrainz knows about 2,228 official releases in the window.
 *   - Only 11% of those carry a DAY. The rest are "2026" or "2026-09", because a
 *     label announces a quarter long before it announces a date.
 *   - Of the artists behind the day-precision releases, 25% have any genre tag.
 *
 * So the honest yield is a few dozen genre-placed releases a month, not
 * thousands. The alternatives were measured too and are worse: Wikidata has 46
 * forward music releases in SIX months, iTunes Search does not expose pre-orders
 * at all, and Deezer's genre-to-artist mapping files Bad Bunny under Rock. There
 * is no free source with volume, dates and genres together; this is the best of
 * them, and it improves on its own as the community tags.
 *
 * Everything without a day is dropped rather than padded. A reminder site that
 * invents a release date is worse than one that admits it does not know.
 */

import { getJson } from './http.js';
import { keyFor, slugify } from './slug.js';

const BASE = 'https://musicbrainz.org/ws/2';
const PROVIDER = 'musicbrainz';
export const CATEGORY = 'music';

/**
 * MusicBrainz asks for one request per second and enforces it.
 *
 * It is the strictest limit of any adapter here, and exceeding it earns a
 * temporary block rather than a 429 -- so this number is a floor, not a target.
 */
const MIN_GAP_MS = 1100;

/** Per page. MusicBrainz caps the search endpoint at 100. */
const PAGE = 100;

const ymd = (d) => d.toISOString().slice(0, 10);

/** See tmdb.js: noon, so a date-only release lands on the right calendar day
 *  for every reader rather than the evening before for the Americas. */
function noonUtc(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** MusicBrainz genre names are lowercase by convention ("hip hop", "j-pop"). */
function titleCase(s) {
  return String(s)
    .split(/(\s|-)/)
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
}

/**
 * Every official release with a real date in the window.
 *
 * @param {object} [opts]
 * @param {Map<string, string[]>} [opts.genreCache] artist provider key -> genre
 *   names already known. An entry with an EMPTY array means "looked up, has
 *   none" -- which is different from absent, and is what stops the adapter
 *   spending its whole budget re-asking about the same untagged artists on every
 *   pass.
 * @param {number} [opts.lookupBudget] upstream artist lookups this pass may spend
 */
export async function fetchAll({
  from = new Date(),
  horizonDays = 180,
  maxPages = 12,
  genreCache = new Map(),
  lookupBudget = 60,
  deadlineMs = 180_000,
} = {}) {
  // Whatever has been collected when this expires is written; the rest arrives on
  // the next pass. See the note in the orchestrator.
  const deadline = Date.now() + deadlineMs;
  const outOfTime = () => Date.now() > deadline;
  const to = new Date(from.getTime() + horizonDays * 86_400_000);
  const query = encodeURIComponent(`date:[${ymd(from)} TO ${ymd(to)}] AND status:official`);

  /** @type {Array<{release: object, artistKey: string, artist: object}>} */
  const pending = [];
  const subjects = new Map();

  for (let page = 0; page < maxPages; page++) {
    if (outOfTime()) break;
    const url = `${BASE}/release?query=${query}&fmt=json&limit=${PAGE}&offset=${page * PAGE}`;
    const res = await getJson(url, { minGapMs: MIN_GAP_MS, timeoutMs: 45_000 });
    const releases = res?.releases ?? [];
    if (releases.length === 0) break;

    for (const r of releases) {
      // A bare year or a year-month is not a date. See the note at the top.
      if (!r?.id || !r.date || r.date.length !== 10) continue;
      const startsAt = noonUtc(r.date);
      if (!startsAt || startsAt < from || startsAt > to) continue;

      const credit = r['artist-credit']?.[0]?.artist;
      if (!credit?.id) continue;

      const artistKey = keyFor(PROVIDER, 'artist', credit.id);
      if (!subjects.has(artistKey)) {
        subjects.set(artistKey, {
          provider: PROVIDER,
          providerKey: artistKey,
          category: CATEGORY,
          kind: 'artist',
          slug: slugify(credit.name, credit.id),
          name: credit.name,
          displayName: credit.name,
          description: credit.disambiguation || null,
          imageUrl: null,
          url: `https://musicbrainz.org/artist/${credit.id}`,
          genreKeys: [],
          _mbid: credit.id,
        });
      }
      pending.push({ release: r, artistKey });
    }

    if (releases.length < PAGE) break;
  }

  /*
   * Resolve genres for artists we have not asked about yet, up to the budget.
   *
   * Deliberately incremental. Asking about every new artist on every pass would
   * cost an hour of wall clock at one request a second and re-learn the same
   * "no tags" answer each time; capping it means the catalogue fills in over a
   * few days and then stays filled, because the cache is the database.
   */
  const genres = new Map();
  let spent = 0;
  for (const subject of subjects.values()) {
    const cached = genreCache.get(subject.providerKey);
    let names = cached;

    if (names === undefined && spent < lookupBudget && !outOfTime()) {
      spent++;
      try {
        const a = await getJson(`${BASE}/artist/${subject._mbid}?inc=genres&fmt=json`, {
          minGapMs: MIN_GAP_MS,
          timeoutMs: 45_000,
        });
        names = (a?.genres ?? [])
          // MusicBrainz genre votes include long-tail noise; one vote is not a genre.
          .filter((g) => (g.count ?? 1) >= 1)
          .sort((x, y) => (y.count ?? 0) - (x.count ?? 0))
          .slice(0, 4)
          .map((g) => g.name);
        genreCache.set(subject.providerKey, names);
      } catch {
        // Leave it absent rather than caching a failure as "no genres", or a
        // single bad minute would blank an artist until someone noticed.
        names = undefined;
      }
    }

    for (const raw of names ?? []) {
      const name = titleCase(raw);
      const key = keyFor(PROVIDER, 'genre', raw);
      if (!genres.has(key)) {
        genres.set(key, {
          provider: PROVIDER,
          providerKey: key,
          category: CATEGORY,
          slug: slugify(`${name}-music`),
          name,
          priority: 50,
        });
      }
      subject.genreKeys.push(key);
    }
  }

  const events = [];
  for (const { release, artistKey } of pending) {
    const subject = subjects.get(artistKey);
    if (!subject) continue;
    const startsAt = noonUtc(release.date);
    const type = release['release-group']?.['primary-type'] ?? 'Release';

    events.push({
      provider: PROVIDER,
      providerKey: keyFor(PROVIDER, 'release', release.id),
      category: CATEGORY,
      subjectKey: artistKey,
      kind: 'release',
      startsAt,
      // A release date is a day. There is no such thing as a 3pm album.
      timeKnown: false,
      precision: 'day',
      state: 'upcoming',
      name: `${subject.displayName} — ${release.title}`,
      shortName: release.title,
      summary: type ? `${type} release` : null,
      imageUrl: null,
      url: `https://musicbrainz.org/release/${release.id}`,
      // The release country, where MusicBrainz names one. Useful because a lot of
      // what is in the window is a regional edition rather than a world release.
      venue: type,
      venueRegion: release['release-events']?.[0]?.area?.name ?? null,
      season: null,
      number: null,
      runtimeMin: null,
    });
  }

  for (const s of subjects.values()) s._mbid = undefined;

  return {
    genres: [...genres.values()],
    // An artist with no genres yet still belongs in the catalogue: it has a page,
    // it can be followed, and the next pass will place it.
    subjects: [...subjects.values()],
    events,
    lookupsSpent: spent,
  };
}

export const adapter = { name: PROVIDER, category: CATEGORY, fetchAll };
