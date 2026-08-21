-- The back catalogue, and being able to find it.
--
-- This site was built as a calendar, so every query filtered to things that had
-- not happened yet. That is right for "tell me before it drops" and useless for
-- the question a reader with a VOD subscription actually has, which is "can I
-- watch The Blair Witch Project tonight". A 1999 film is a perfectly good row --
-- it just has a start date in the past, and nothing about the schema objected.
-- What was missing was a way to reach it.

-- Popularity, so a search for "batman" leads with the ones people mean rather
-- than whatever sorts first alphabetically. TMDB's own figure, which is a moving
-- window of how much attention a title is getting rather than a quality score.
alter table subjects add column if not exists popularity numeric(10,3);

-- The searchable text, kept as its own column rather than computed per query:
-- a trigram index cannot be built over an expression that concatenates columns
-- without an immutable wrapper, and this is simpler to reason about.
alter table subjects add column if not exists search_text text;

update subjects
   set search_text = lower(coalesce(display_name, name))
 where search_text is null;

/*
 * Trigram, not full text.
 *
 * Titles are short names rather than prose, and the queries they get are
 * misspelled, partial and unpunctuated -- "blair witch", "top gun maverik". A
 * tsvector would stem and rank words it does not have; trigram similarity handles
 * a typo, which is what people actually type into a search box.
 */
create index if not exists subjects_search_trgm_idx
  on subjects using gin (search_text gin_trgm_ops);

-- Search sorts by popularity within a similarity band, so it needs an index that
-- does not force a sort over the whole table.
create index if not exists subjects_popularity_idx
  on subjects (popularity desc nulls last);

/*
 * Past events are a different working set from upcoming ones.
 *
 * The calendar pages read the future and search reads everything, so the partial
 * index that serves the calendar stops helping the moment the table fills up with
 * a back catalogue that is ninety-nine percent past. This one serves the other
 * direction.
 */
create index if not exists events_past_idx
  on events (subject_id, starts_at desc)
  where state = 'out';

/*
 * How far the back-catalogue walk has got.
 *
 * A one-row-per-provider cursor rather than something derived from the rows,
 * because "how many pages have I fetched" cannot be recovered from the data:
 * pages overlap as popularity shifts between requests, so counting films would
 * drift further from the truth on every pass and eventually re-walk the whole
 * thing.
 */
create table if not exists catalogue_progress (
  provider   text primary key,
  pages_done int not null default 0,
  updated_at timestamptz not null default now()
);
