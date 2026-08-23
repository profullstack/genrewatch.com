/**
 * Filling in the catalogue from IMDb's daily dumps.
 *
 * This site learns about a title when a provider mentions one. TMDB's
 * back-catalogue walk is popularity-ordered and stops after a few thousand films;
 * the forward passes cover what is scheduled. That is a good calendar and a thin
 * catalogue, and once a reader can play their own VOD library through the site the
 * thinness becomes the whole problem: a film released last month is sitting in
 * their folder, has no row here, and therefore has no page it could be offered on.
 * "New releases do not quite work" is exactly that gap.
 *
 * IMDb publishes the whole catalogue every day, free, keyless, at
 * datasets.imdbws.com. What it does not publish is a release DATE -- title.basics
 * has a start year and nothing finer -- so everything from here arrives at year
 * precision: browsable, searchable, matchable against a playlist, and never
 * alarmable. Anything with a real date still comes from TMDB, TVmaze or AniList,
 * and this pass never overwrites one.
 *
 * Three properties make it safe to run against production:
 *
 *   - It STREAMS. The production database is internal to Railway with no public
 *     proxy, so this has to run in the container that already holds a connection,
 *     and that container cannot land a gigabyte on disk. Nothing bigger than one
 *     line is held (see tsv.js).
 *   - It LINKS before it inserts. A candidate is matched against what we already
 *     hold on normalised title and year, so an IMDb row for a film TMDB already
 *     gave us enriches that row rather than creating a second page for it.
 *   - It is BOUNDED and RESUMABLE. A pass stops on a wall-clock deadline and
 *     records the tconst it reached; the next one resumes there. Eleven and a half
 *     million rows do not fit in one budget, and pretending otherwise produces a
 *     job that is killed halfway every time and never makes progress.
 */

import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { keyFor, normaliseTitle, slugify } from './slug.js';
import { intOf, streamTsvGz } from './tsv.js';

const BASE = 'https://datasets.imdbws.com';

/**
 * Which title types are worth holding.
 *
 * tvEpisode is deliberately absent and it is the whole reason this list exists:
 * there are roughly eight and a half million of them, they are the bulk of the
 * file, and an episode is only interesting through the show it belongs to -- which
 * TVmaze already gives us with real air times. `short` and `videoGame` are out for
 * the opposite reason: nobody browses a release calendar for them and nobody's VOD
 * folder has them.
 */
const KINDS = new Set(['movie', 'tvMovie', 'tvSeries', 'tvMiniSeries', 'tvSpecial', 'video']);

/** What each IMDb type is called on a page, and which of our categories it is. */
const KIND_MAP = {
  movie: { kind: 'film', category: 'film' },
  tvMovie: { kind: 'film', category: 'film' },
  video: { kind: 'film', category: 'film' },
  tvSeries: { kind: 'show', category: 'tv' },
  tvMiniSeries: { kind: 'show', category: 'tv' },
  tvSpecial: { kind: 'show', category: 'tv' },
};

/**
 * IMDb genre names this site does not carry.
 *
 * Everything else becomes a genre row. IMDb has 28 of them and most are the same
 * words TMDB uses, which is what makes the slug prefix below the normal case
 * rather than an edge one.
 */
const SKIP_GENRES = new Set(['Adult', 'Short', 'Game-Show', 'Reality-TV', 'Talk-Show', 'News']);

/**
 * Ratings, packed into one number per title.
 *
 * About one and a half million titles carry a rating and the ones worth keeping are
 * a few hundred thousand of those -- but a Map that size holding an object per
 * entry is a hundred megabytes of small allocations in a container that also has a
 * Postgres pool and an HTTP server in it. One integer per key is a fraction of
 * that: the rating in the high digits, the vote count in the low seven.
 */
const packRating = (rating, votes) =>
  Math.round((rating ?? 0) * 10) * 10_000_000 + Math.min(votes ?? 0, 9_999_999);
const unpackRating = (packed) => ({
  rating: Math.floor(packed / 10_000_000) / 10,
  votes: packed % 10_000_000,
});

/**
 * Read title.ratings and keep the titles anybody has heard of.
 *
 * Loaded first and in full, because the decision about whether to keep a title in
 * the much larger basics pass depends on it -- and a lookup per row against the
 * database would be eleven million queries.
 *
 * The threshold is what keeps this affordable, and it is a MEMORY budget rather
 * than a taste one. Measured against the real dump on 2026-08-23: 1,708,507 rated
 * titles, of which 428,513 clear a hundred votes, and that map retains 92MB after
 * a collection (338MB RSS for the whole process). Lowering the threshold raises
 * that roughly linearly, in a container that also holds a Postgres pool and an
 * HTTP server. Most of what it excludes has single-digit vote counts and will
 * never be searched for -- and anything recent is kept regardless by the other
 * half of the filter.
 */
async function loadRatings({ minVotes, signal, log }) {
  const keep = new Map();
  let seen = 0;
  for await (const row of streamTsvGz(`${BASE}/title.ratings.tsv.gz`, { signal })) {
    seen++;
    const votes = intOf(row.numVotes);
    if (!votes || votes < minVotes) continue;
    const rating = Number.parseFloat(row.averageRating);
    keep.set(row.tconst, packRating(Number.isFinite(rating) ? rating : null, votes));
  }
  log(
    `[imdb] ratings: ${seen.toLocaleString('en-US')} read, ` +
      `${keep.size.toLocaleString('en-US')} above ${minVotes} votes`,
  );
  return keep;
}

/**
 * Turn one basics row into the shape the upserts want, or null to skip it.
 *
 * Pure and exported so the filtering rules can be tested without a network or a
 * database. These rules decide what the catalogue contains, and getting them wrong
 * is either a million rows of noise or a missing film.
 */
export function candidateFrom(row, { rated, thisYear, recentYears }) {
  if (!row?.tconst || !row.primaryTitle) return null;
  if (!KINDS.has(row.titleType)) return null;
  // isAdult is "0"/"1" in the dump.
  if (row.isAdult === '1') return null;

  const year = intOf(row.startYear);
  const votes = rated ? unpackRating(rated) : null;

  /*
   * Two ways in, and the second is the point of the whole exercise.
   *
   * A title with a real audience is worth holding whenever it came out. A title
   * from the last couple of years is worth holding whether or not anybody has
   * rated it yet -- because a film released last month has almost no votes, and it
   * is precisely the film sitting unmatched in somebody's VOD folder.
   */
  const known = Boolean(votes);
  const recent = year !== null && year >= thisYear - recentYears;
  if (!known && !recent) return null;

  const map = KIND_MAP[row.titleType];
  if (!map) return null;

  const title = row.primaryTitle;
  const genres = (row.genres ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g && !SKIP_GENRES.has(g));

  return {
    tconst: row.tconst,
    title,
    norm: normaliseTitle(title),
    year,
    category: map.category,
    kind: map.kind,
    runtimeMin: intOf(row.runtimeMinutes),
    rating: votes?.rating ?? null,
    ratingCount: votes?.votes ?? null,
    genres,
  };
}

/**
 * The date to file a year against.
 *
 * Noon UTC on 1 January, the same anchor the other adapters use for a date they
 * were not given -- so a year-precision row sorts sensibly and cannot drift a day
 * either way for a reader in Auckland or Los Angeles. It is a placeholder and the
 * row says so: precision 'year', time_known false.
 */
function anchorFor(year) {
  return new Date(Date.UTC(year, 0, 1, 12, 0, 0));
}

/** The key both sides of a link agree on. Category is included so a show and a
 *  film of the same name in the same year stay two things. */
export function matchKey({ normTitle, norm, year, category }) {
  return `${category} ${normTitle ?? norm} ${year ?? ''}`;
}

/**
 * One pass over the dump.
 *
 * Returns what it did rather than logging and forgetting, because the scheduler
 * decides whether to run again from the progress row, and a human reads the
 * numbers to tell "nothing new today" from "this has not run in a week".
 */
export async function syncImdb({
  log = console.log,
  deadlineMs = config.catalog.imdbDeadlineMs,
  minVotes = config.catalog.imdbMinVotes,
  recentYears = config.catalog.imdbRecentYears,
  signal = null,
} = {}) {
  if (!config.catalog.imdbEnabled) return { skipped: 'imdb is off' };

  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  const thisYear = new Date().getUTCFullYear();

  /*
   * Bring existing rows up to date with the normaliser before matching anything.
   *
   * norm_title is the join key and it MUST be produced by the same function on
   * both sides. Doing it here rather than in the migration is deliberate: a SQL
   * approximation would be close enough to look right and wrong often enough to
   * create duplicate pages, which is the one outcome this is all built to avoid.
   */
  const backfilled = await backfillNormTitles({ log });

  const rated = await loadRatings({ minVotes, signal, log });

  const progress = await q.imdbProgress();
  const resumeAfter = progress?.cursor ?? null;
  await q.startImdbPass();
  if (resumeAfter) log(`[imdb] resuming after ${resumeAfter}`);

  let seen = 0;
  let skipped = 0;
  let linked = 0;
  let created = 0;
  let cursor = resumeAfter;
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const result = await writeBatch(batch, { thisYear });
    linked += result.linked;
    created += result.created;
    batch = [];
  };

  for await (const row of streamTsvGz(`${BASE}/title.basics.tsv.gz`, { signal })) {
    /*
     * Skip forward to where the last pass stopped.
     *
     * The file is ordered by tconst, so this is a string comparison rather than a
     * count -- a count would shift by however many titles IMDb added overnight and
     * quietly re-walk or skip a slice.
     */
    if (resumeAfter && row.tconst <= resumeAfter) {
      skipped++;
      continue;
    }

    seen++;
    cursor = row.tconst;

    const candidate = candidateFrom(row, { rated: rated.get(row.tconst), thisYear, recentYears });
    if (candidate) batch.push(candidate);

    if (batch.length >= 500) await flush();

    /*
     * The deadline is checked against ROWS READ, not against batches written.
     *
     * Checking it only after a flush looked equivalent and is not: the file is
     * mostly episodes, which are skipped, so there are stretches of millions of
     * rows that fill no batch at all. A pass could therefore run to the end of the
     * file however long that took, which is precisely the unbounded job the
     * deadline exists to prevent.
     */
    if (seen % 50_000 === 0 && Date.now() > deadline) {
      await flush();
      break;
    }
  }
  await flush();

  /*
   * The loop ends either because the file did or because the deadline did, and
   * only the first clears the cursor.
   *
   * The ambiguous case -- the file ending at the same moment the budget did -- is
   * self-correcting rather than guarded: it records a cursor at the last tconst,
   * and the next pass reads to the end finding nothing after it, which completes
   * and clears the cursor. One wasted read beats a wrong "complete".
   */
  const finished = Date.now() <= deadline;

  await q.finishImdbPass({
    cursor: finished ? null : cursor,
    completed: finished,
    seen,
    linked,
    created,
    note: finished ? null : `stopped at ${cursor} after ${Math.round(deadlineMs / 1000)}s`,
  });

  const secs = Math.round((Date.now() - startedAt) / 1000);
  log(
    `[imdb] ${finished ? 'complete' : 'partial'}: ${seen.toLocaleString('en-US')} rows read` +
      `${skipped ? ` (${skipped.toLocaleString('en-US')} skipped to the cursor)` : ''}, ` +
      `${linked.toLocaleString('en-US')} linked, ${created.toLocaleString('en-US')} added` +
      `${backfilled ? `, ${backfilled.toLocaleString('en-US')} normalised` : ''}, ${secs}s`,
  );

  return { finished, seen, linked, created, backfilled, seconds: secs };
}

/**
 * Give every existing subject a norm_title, in batches, through the real
 * normaliser.
 *
 * Runs at the top of every pass and is a no-op once done -- the column is written
 * on every upsert from here on, so only rows that predate the migration can be
 * missing one.
 */
async function backfillNormTitles({ log }) {
  let total = 0;
  for (;;) {
    const rows = await q.subjectsMissingNormTitle({ limit: 2000 });
    if (rows.length === 0) break;

    const written = await q.setSubjectNormTitles(
      rows.map((r) => ({ id: r.id, normTitle: normaliseTitle(r.display_name ?? r.name) })),
    );

    /*
     * A batch that wrote nothing means the same rows are coming back forever.
     *
     * Not hypothetical: normaliseTitle returns '' for any title with no Latin
     * characters -- every AniList title -- the write filtered '' out as falsy, the
     * rows stayed NULL, and this loop logged thirteen million normalised rows
     * against a table of five thousand while the IMDb pass behind it never
     * started. The cause is fixed in setSubjectNormTitles; this is the guard that
     * turns a repeat into a log line rather than a worker pinned until the next
     * deploy.
     */
    if (written === 0) {
      log(`[imdb] ${rows.length} rows will not normalise; leaving them and moving on`);
      break;
    }

    total += written;
    if (total % 20_000 === 0) {
      log(`[imdb] normalised ${total.toLocaleString('en-US')} existing rows`);
    }
  }
  return total;
}

/**
 * Write one batch: link what we already have, insert what we do not.
 *
 * The link half is the important one. Matching on (normalised title, year) is not
 * perfect -- two different films really can share both -- but the cost of a wrong
 * link is one page carrying an extra id, and the cost of no linking at all is two
 * pages for every film TMDB already gave us.
 */
async function writeBatch(candidates, { thisYear }) {
  const existing = await q.subjectsByNormTitle(
    candidates.map((c) => ({ normTitle: c.norm, year: c.year, category: c.category })),
  );

  const toLink = [];
  const toCreate = [];
  for (const c of candidates) {
    const hit = existing.get(matchKey(c));
    if (hit) toLink.push({ ...c, subjectId: hit });
    else toCreate.push(c);
  }

  if (toLink.length) await q.linkImdbToSubjects(toLink);

  let created = 0;
  if (toCreate.length) created = await insertNew(toCreate, { thisYear });

  return { linked: toLink.length, created };
}

/** Everything an unseen title needs: genres, a subject, an event, and the edges. */
async function insertNew(candidates, { thisYear }) {
  // Genres first: the subject and event edges both need their ids.
  const genreRows = new Map();
  for (const c of candidates) {
    for (const name of c.genres) {
      const providerKey = keyFor(name);
      if (genreRows.has(providerKey)) continue;
      genreRows.set(providerKey, {
        category: c.category,
        provider: 'imdb',
        providerKey,
        /*
         * Prefixed, and it is not cosmetic.
         *
         * `slug` is globally unique across genres, and TMDB already owns "horror",
         * "drama" and most of the words IMDb uses. An unprefixed slug therefore
         * fails the unique index and takes the whole chunk with it -- which reads
         * as "the importer is broken" rather than "two providers named the same
         * genre".
         */
        slug: slugify(`imdb ${name}`),
        name,
      });
    }
  }
  const genreIds = await q.upsertGenres([...genreRows.values()]);

  const subjects = candidates.map((c) => ({
    category: c.category,
    kind: c.kind,
    provider: 'imdb',
    providerKey: c.tconst,
    /*
     * The year is the discriminator, not the id.
     *
     * "the-matrix-1999" is readable and stable; "the-matrix-t0133093" is neither.
     * Two titles sharing a name AND a year fall back to the id, which is rare
     * enough to be worth the ugliness when it happens.
     */
    slug: c.year ? slugify(c.title, String(c.year)) : slugify(c.title, c.tconst),
    name: c.title,
    displayName: c.title,
    normTitle: c.norm,
    year: c.year,
    imdbId: c.tconst,
    rating: c.rating,
    ratingCount: c.ratingCount,
    /*
     * Fame as a popularity figure, so IMDb rows rank against TMDB rows.
     *
     * They are different scales and there is no honest conversion, so this is a
     * deliberate approximation: the vote count, which is what "how many people
     * know this" actually measures on IMDb.
     *
     * It survives the mismatch because searchCatalogue takes ln(popularity)/7 and
     * clamps at 1, so both scales saturate rather than diverging: a TMDB figure of
     * 1,100 and an IMDb count of 1,100 votes both score 0.99, and everything above
     * either is level. The band that genuinely differs is the middle -- a title
     * with 5,000 votes outranks a TMDB row at popularity 20 -- and that is the
     * right way round, because a vote count is a better fame signal than TMDB's
     * moving attention window. The similarity term is weighted three times as
     * heavily either way.
     */
    popularity: c.ratingCount ?? null,
    url: `https://www.imdb.com/title/${c.tconst}/`,
    genreKeys: c.genres.map((g) => keyFor(g)),
  }));

  const subjectIds = await q.upsertSubjects(subjects);

  await q.replaceSubjectGenres(
    subjects
      .map((s) => ({
        subjectId: subjectIds.get(s.providerKey),
        genreIds: (s.genreKeys ?? []).map((k) => genreIds.get(k)).filter(Boolean),
      }))
      .filter((r) => r.subjectId),
  );

  /*
   * Only titles with a year get an event.
   *
   * An event is a dated thing. A title IMDb has no year for is a subject that can
   * be searched and matched against a playlist, and inventing a date for it would
   * put it on a calendar under a year nobody claimed.
   */
  const dated = candidates.filter((c) => c.year && subjectIds.get(c.tconst));
  if (dated.length) {
    const events = dated.map((c) => ({
      provider: 'imdb',
      providerKey: `imdb:release:${c.tconst}`,
      category: c.category,
      subjectId: subjectIds.get(c.tconst),
      kind: 'release',
      startsAt: anchorFor(c.year),
      // IMDb gives a year and nothing finer. Saying otherwise would put a
      // countdown on an hour nobody chose.
      timeKnown: false,
      precision: 'year',
      state: c.year > thisYear ? 'upcoming' : 'out',
      name: c.title,
      shortName: c.title,
      rating: c.rating,
      ratingCount: c.ratingCount,
      runtimeMin: c.runtimeMin,
      url: `https://www.imdb.com/title/${c.tconst}/`,
    }));

    const eventIds = await q.upsertEvents(events);
    await q.replaceEventGenres(
      dated
        .map((c) => ({
          eventId: eventIds.get(`imdb:release:${c.tconst}`),
          genreIds: c.genres.map((g) => genreIds.get(keyFor(g))).filter(Boolean),
        }))
        .filter((r) => r.eventId && r.genreIds.length),
    );
  }

  return subjects.length;
}
