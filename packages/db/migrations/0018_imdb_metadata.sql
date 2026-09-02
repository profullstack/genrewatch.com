-- Artwork and a synopsis for the titles IMDb told us about.
--
-- The IMDb backfill is why this catalogue knows about 314,000 titles, and also
-- why a large part of the forward calendar is a name and a year and nothing else:
-- title.basics carries no poster, no synopsis and no date finer than a year. So an
-- upcoming film reads "Star Wars: New Jedi Order, 2027" and stops, which is a
-- search result rather than a page worth opening. Measured in production: 1,204
-- upcoming events came from IMDb and every single one of them was missing its
-- image, its summary and its trailer.
--
-- TMDB indexes the same tconst, so the two can be joined EXACTLY rather than by
-- guessing from a title and a year. That distinction is why this can run
-- unattended: a fuzzy title match would eventually put the wrong poster on a film,
-- and a confidently wrong poster is worse than none.

/*
 * When we last asked TMDB about this title.
 *
 * A stamp rather than a flag, and it records the MISSES too. About a quarter of
 * these ids are not in TMDB at all -- they are obscure in both places -- and
 * without recording the attempt the pass would spend its whole budget every cycle
 * re-asking about the same unmatched titles and never reach the rest.
 *
 * Null means never asked. It is deliberately re-checkable: a film announced today
 * with no poster anywhere will have one nearer release, so a title that came back
 * thin is worth another look eventually, just not soon.
 */
alter table subjects add column if not exists meta_checked_at timestamptz;

comment on column subjects.meta_checked_at is
  'Last TMDB lookup by external IMDb id. Records misses as well as hits, so unmatched titles do not consume the budget every pass.';

/*
 * The TMDB id, once found.
 *
 * Kept so the join is done once. Everything else TMDB offers for this title --
 * a trailer, a cast list, the home-release dates -- is addressed by this id, so
 * storing it is what lets a later pass ask for those without paying for the
 * find again.
 */
alter table subjects add column if not exists tmdb_id text;

/*
 * The pass reads the forward calendar first.
 *
 * There are 314,000 of these and roughly a thousand of them are things somebody
 * is waiting for. A reader meets this gap on an upcoming title, so that is where
 * the budget goes; the back catalogue is reachable by search and can fill in over
 * a much longer horizon.
 */
create index if not exists subjects_meta_pending_idx
  on subjects (id)
  where provider = 'imdb' and meta_checked_at is null;
