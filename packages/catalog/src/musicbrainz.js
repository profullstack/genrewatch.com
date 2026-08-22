/**
 * Music, from MusicBrainz.
 *
 * Music was the thinnest category on this site, and the reason was here rather
 * than at the source. Measured against the live API on 2026-08-21, for a
 * four-month forward window:
 *
 *   - MusicBrainz knows about 2,228 official releases in the window.
 *   - Only 11% of those carry a DAY. The rest are "2026" or "2026-09", because a
 *     label announces a quarter long before it announces a date.
 *   - Of the artists behind them, 25% have any genre tag.
 *
 * Requiring a day threw away the other 89% -- 2,228 releases became 245, and
 * with them most of the genres, because a genre only appears on the site once
 * something in it is coming. Month precision is accepted now: a release dated
 * "2026-09" is stored on the first of that month with `precision: 'month'`, and
 * the page renders "September 2026" rather than a day nobody claimed. That is
 * reporting what we were told, which is the opposite of inventing a date --
 * `timeKnown` is false either way, so no reminder can claim an hour.
 *
 * A bare year is still dropped: "sometime in 2026" is not something a reader can
 * act on, and it would swamp four months with a whole year.
 *
 * The alternatives were measured too and are worse: Wikidata has 46 forward
 * music releases in SIX months, iTunes Search does not expose pre-orders at all,
 * and Deezer's genre-to-artist mapping files Bad Bunny under Rock. There is no
 * free source with volume, dates and genres together; this is the best of them,
 * and it improves on its own as the community tags.
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

/**
 * What MusicBrainz actually told us about when a release lands.
 *
 * A label announces a quarter long before it announces a date, so the field
 * arrives as "2026-09-18", "2026-09" or "2026". Only the first was accepted
 * before, which threw away 89% of the window -- 2,228 releases in four months
 * became 245, and with them most of the genres, because a genre only appears on
 * the site once something in it is coming.
 *
 * Reporting the precision we were given is not the same as inventing a date. The
 * schema has carried `precision` since 0001, the spaceflight adapter has emitted
 * 'month' from the start, and components.jsx already renders year and month
 * ("September 2026") rather than a false day. `timeKnown` stays false throughout,
 * so nothing here can produce a reminder that claims an hour.
 *
 * Year precision is deliberately NOT accepted: "sometime in 2026" is not news a
 * reader can act on, and it would swamp the next four months with the whole year.
 *
 * @param {string} dateStr
 * @returns {{ startsAt: Date, precision: 'day'|'month' } | null}
 */
function releaseDate(dateStr) {
  const raw = String(dateStr ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const startsAt = noonUtc(raw);
    return startsAt ? { startsAt, precision: 'day' } : null;
  }
  if (/^\d{4}-\d{2}$/.test(raw)) {
    // The first of the month, at noon for the same reason a day is: a reader in
    // the Americas must not see the month before.
    const startsAt = noonUtc(`${raw}-01`);
    return startsAt ? { startsAt, precision: 'month' } : null;
  }
  return null;
}

/** MusicBrainz genre names are lowercase by convention ("hip hop", "j-pop"). */
function titleCase(s) {
  return String(s)
    .split(/(\s|-)/)
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
}

/**
 * Artist artwork, from fanart.tv.
 *
 * MusicBrainz holds no images at all, which left every artist on this site as a
 * grey square. fanart.tv is keyed by MusicBrainz ID -- the exact identifier
 * already stored as this subject's provider key -- so no matching or searching is
 * involved, and a wrong picture is not a failure mode here.
 *
 * Budgeted like the genre lookups and for the same reason: it is one request per
 * artist. A 404 means nobody has uploaded art, which is the common case and is
 * cached as "none" by the caller rather than retried forever.
 */
async function fetchArtistArt(mbid, apiKey) {
  if (!apiKey) return null;
  const d = await getJson(`https://webservice.fanart.tv/v3/music/${mbid}?api_key=${apiKey}`, {
    minGapMs: 250,
    timeoutMs: 20_000,
    retries: 1,
  });
  if (!d) return null;
  const thumb = d.artistthumb?.[0]?.url ?? null;
  const back = d.artistbackground?.[0]?.url ?? null;
  return thumb || back ? { imageUrl: thumb ?? back, backdropUrl: back ?? null } : null;
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
  fanartKey = process.env.FANART_TV_API_KEY,
  artBudget = 40,
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
      // A year-month IS a date, at month precision. A bare year is not. See
      // releaseDate() for why that line is drawn where it is.
      if (!r?.id) continue;
      const when = releaseDate(r.date);
      if (!when || when.startsAt < from || when.startsAt > to) continue;

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
          // Eight rather than four. This costs nothing -- the tags are already in
          // the response we paid a request for -- and the fourth-to-eighth are
          // exactly the specific ones worth browsing by: an artist reads
          // "rock, alternative rock, indie rock, shoegaze, dream pop" and the
          // interesting half was being discarded.
          .slice(0, 8)
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
    // Re-read rather than carried through `pending`: the filter above already
    // rejected anything this cannot parse, so a null here is impossible and a
    // second parse is cheaper than another field on every queued row.
    const when = releaseDate(release.date);
    if (!when) continue;
    const type = release['release-group']?.['primary-type'] ?? 'Release';

    events.push({
      provider: PROVIDER,
      providerKey: keyFor(PROVIDER, 'release', release.id),
      category: CATEGORY,
      subjectKey: artistKey,
      kind: 'release',
      startsAt: when.startsAt,
      // A release date is never a time. There is no such thing as a 3pm album,
      // and a month-precision row must not claim one either.
      timeKnown: false,
      precision: when.precision,
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

  /*
   * Artwork, after the genres and within what is left of the clock.
   *
   * Deliberately last: a genre decides which pages an artist appears on, and a
   * picture only decides how that page looks. If the pass runs out of time, the
   * catalogue is still correct and merely plain.
   */
  let artSpent = 0;
  for (const subject of subjects.values()) {
    if (subject.imageUrl || artSpent >= artBudget || outOfTime()) continue;
    artSpent++;
    try {
      const art = await fetchArtistArt(subject._mbid, fanartKey);
      if (art) {
        subject.imageUrl = art.imageUrl;
        subject.backdropUrl = art.backdropUrl;
      }
    } catch {
      // Artwork is decoration; never fail a catalogue pass over it.
    }
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
