-- Everything an event page needs to be worth opening.
--
-- The page had a title, a date, a one-line summary and some genre chips, which
-- is roughly a search result rather than a page. Meanwhile every provider was
-- already handing us far more and we were discarding it at the adapter: TMDB
-- returns a wide backdrop, a rating and a language in the SAME response we
-- already make, and one further request adds runtime, cast, director and a
-- trailer. AniList returns a banner and a studio in the query we already send.
--
-- So this is mostly about keeping what we are already given.

-- A wide image, distinct from the portrait one. A poster and a backdrop are
-- different shapes for different jobs -- a banner across the top of a page cannot
-- be a 2:3 poster without either cropping the faces off or being enormous.
alter table events   add column if not exists backdrop_url text;
alter table subjects add column if not exists backdrop_url text;

-- The one line a marketing department wrote to sell it. Often absent, and worth
-- showing when it is there.
alter table events add column if not exists tagline text;

-- Audience score, 0-10, with the count so a page can decline to show "10.0" that
-- rests on a single vote.
alter table events add column if not exists rating       numeric(3,1);
alter table events add column if not exists rating_count int;

-- A watchable trailer, stored as a full URL rather than a provider key so the
-- renderer does not need to know which site it came from.
alter table events add column if not exists trailer_url text;

/*
 * Everything else, as jsonb.
 *
 * Cast, director, studios, spoken languages, streaming providers. It is read
 * whole, written whole, and only ever on the way to one page -- there is no query
 * that wants to filter or join on an individual cast member, and a child table per
 * credit would add a write and a join to every event read for nothing.
 *
 * Shape: {"cast": ["..."], "director": "...", "studios": ["..."],
 *         "language": "...", "watch": ["Netflix", "Max"]}
 */
alter table events add column if not exists detail jsonb;

comment on column events.detail is
  'Read whole, written whole: cast, director, studios, language, watch providers. Nothing queries inside it.';

-- Detail costs one extra upstream request per title, so it is filled
-- incrementally and this is how a pass knows what it has already done. Null means
-- never attempted; a timestamp means attempted, whether or not it found anything.
alter table events add column if not exists detail_synced_at timestamptz;
create index if not exists events_detail_pending_idx
  on events (starts_at)
  where detail_synced_at is null and state = 'upcoming';
