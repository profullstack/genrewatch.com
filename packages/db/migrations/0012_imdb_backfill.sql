-- Backfilling the catalogue from IMDb's daily dumps.
--
-- Why this is needed at all, stated plainly: this site knows about a title when a
-- provider told it about one. TMDB's back-catalogue walk is popularity-ordered and
-- stops at a few thousand films; the forward passes cover what is scheduled. That
-- is a fine calendar and a poor catalogue -- and once a reader can play their own
-- VOD library through the site, the gap becomes the whole feature: a film that
-- came out last month is in their folder, is not in our database, and therefore
-- has no page to be offered on.
--
-- IMDb publishes everything, daily, free, with no key. What it does NOT publish is
-- a release DATE -- title.basics carries a start year and nothing finer -- so
-- these rows arrive at year precision and are browsable rather than alarmable.
-- That is the honest shape: see 0001's note on time_known.

/*
 * The IMDb id, on the subject rather than on a table of its own.
 *
 * A title is one thing whichever provider described it, and the alternative --
 * an imdb_titles table joined to subjects -- would mean every read that wants a
 * year or a rating grows a join for a column that belongs on the row.
 *
 * Unique, because two subjects claiming the same tconst is a duplicate by
 * definition and this is the constraint that makes the linking pass safe to
 * re-run.
 */
alter table subjects add column if not exists imdb_id text;
create unique index if not exists subjects_imdb_id_idx on subjects (imdb_id)
  where imdb_id is not null;

/*
 * The year, denormalised onto the subject.
 *
 * Derivable from the events table, and deliberately not derived: the linking pass
 * matches a candidate against existing rows on (normalised title, year) in bulk,
 * and doing that through a correlated subquery over events for every one of a
 * million candidates is the difference between a pass that finishes and one that
 * does not.
 */
alter table subjects add column if not exists year int;

/*
 * The title reduced to comparable words, written by the same normaliser that
 * matches a channel in somebody's playlist.
 *
 * This is the join key for linking IMDb rows to what we already hold, and it has
 * to be produced by the SAME function on both sides or the two disagree about
 * punctuation and accents -- "WALL·E" and "Amélie" being the obvious cases. So it
 * is written from JavaScript on every upsert rather than computed here in SQL,
 * and the importer backfills existing rows through the same function before its
 * first linking pass.
 *
 * Left NULL by this migration on purpose. A SQL approximation would be close
 * enough to look right and wrong often enough to create duplicates, which is the
 * one outcome this column exists to prevent.
 */
alter table subjects add column if not exists norm_title text;
create index if not exists subjects_norm_title_idx on subjects (norm_title, year);

-- Audience figures, kept beside the title rather than only on an event. Used to
-- rank a search and to decide what is worth keeping at all.
alter table subjects add column if not exists rating       numeric(3,1);
alter table subjects add column if not exists rating_count int;

/*
 * Where the last pass got to.
 *
 * A cursor, not a count. title.basics is ordered by tconst, so "resume after
 * tt1234567" is exact and survives the file growing underneath it -- where "skip
 * the first N rows" would silently shift by however many titles IMDb added
 * overnight.
 *
 * NULL cursor with a completed_at means the last pass reached the end. A cursor
 * with no completed_at means a pass ran out of its deadline partway, which is the
 * normal state during the first few days: eleven and a half million rows do not
 * fit in one wall-clock budget.
 */
create table if not exists imdb_progress (
  id           int primary key default 1,
  cursor       text,
  started_at   timestamptz,
  completed_at timestamptz,
  -- What the last finished pass did, so a human can tell "nothing new" from
  -- "nothing ran".
  seen         bigint not null default 0,
  linked       bigint not null default 0,
  created      bigint not null default 0,
  note         text,
  constraint imdb_progress_single_row check (id = 1)
);
