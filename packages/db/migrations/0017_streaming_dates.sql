-- When a film reaches the reader's own television.
--
-- The calendar knew one date per film: the day it opened in cinemas. For most
-- readers most of the time that is a date they cannot act on, which made a film
-- page a notice that they were not allowed to watch something yet. TMDB has
-- carried the other dates all along, in the release_dates section of a response
-- the enrichment pass was already making and throwing away.
--
-- Those dates arrive as their own events rather than as columns here, because an
-- event is this site's unit of "tell me before it drops": a column cannot be
-- followed, cannot sort into a genre page by date, and cannot enter the reminder
-- queue. So a film now has up to three rows -- cinemas, rent-or-buy, and the
-- subscription service -- keyed apart as tmdb:release:, tmdb:digital: and
-- tmdb:stream:.
--
-- This migration adds only the bookkeeping that makes the second and third
-- findable.

/*
 * When we last asked TMDB about this film's home-release dates.
 *
 * Distinct from detail_synced_at, and the distinction is the entire point. Detail
 * is asked once and is then true forever: a film's director does not change. A
 * digital date is the opposite -- it usually does not EXIST when a film is first
 * swept, and is announced somewhere between two and ten weeks after the film
 * reaches cinemas. Reusing the detail stamp would mean every film was asked the
 * question exactly once, at the only time the answer was guaranteed to be absent,
 * and the calendar would fill up with theatrical dates and nothing else.
 *
 * So this stamp is re-checkable: a pass takes the films whose stamp is null or
 * old, which makes the question repeat on a slow cycle until the answer arrives.
 * Null means never asked.
 */
alter table events add column if not exists digital_checked_at timestamptz;

comment on column events.digital_checked_at is
  'Last home-release-date lookup. Re-checked on a cycle, unlike detail_synced_at: a digital date is announced after the theatrical one, so asking once always asks too early.';

/*
 * The pass reads newest-released first.
 *
 * A digital date is announced in the weeks AFTER a film opens, so the films most
 * likely to have gained one since we last looked are the ones that came out most
 * recently. Ordering the other way would spend the whole budget on the far end of
 * the back catalogue, where the answer has been settled for years.
 */
create index if not exists events_digital_pending_idx
  on events (starts_at desc)
  where provider = 'tmdb' and kind = 'release';
