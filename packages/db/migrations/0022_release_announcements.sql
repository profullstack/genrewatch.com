-- Telling a follower that a film's next window has been DATED.
--
-- A film is three dates -- cinemas, rent or buy, a subscription service -- and the
-- second and third are announced weeks after the first. Following a film already
-- reminded you the day before and the day of each one, but only once its row
-- existed, so the news that mattered most ("it is on Netflix on the 30th") arrived
-- as a reminder the night before rather than when it was announced.
--
-- `announced_at` is when followers were told the row exists. NULL means not yet.
-- The scan reads it rather than hooking the code that writes events, because two
-- writers create these rows (the TMDB digital pass and the nichedb mirror) and a
-- third would silently skip the announcement.
alter table events add column if not exists announced_at timestamptz;

-- Every row that exists today counts as already announced. Without this the first
-- scan after deploy would tell every follower about every date they already had.
update events set announced_at = now()
where announced_at is null
  and provider = 'tmdb'
  and (provider_key like 'tmdb:release:%'
       or provider_key like 'tmdb:digital:%'
       or provider_key like 'tmdb:stream:%');

create index if not exists events_unannounced_idx
  on events (id)
  where announced_at is null and provider = 'tmdb';

comment on column events.announced_at is
  'When followers were told this release window was dated. NULL = not yet announced.';
