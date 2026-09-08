-- More than one line per reader.
--
-- 0002 wrote "One list per account. A second add replaces the first rather than
-- accumulating credentials nobody remembers giving us", and enforced it with a
-- UNIQUE on user_id. That was the right instinct about credentials and the wrong
-- shape for the product: a reader with two subscriptions could only ever tell us
-- about one, and the second was silently destroyed by adding it.
--
-- It bites harder here than on the sibling site. A provider list on a genre site
-- is a catalogue, not a channel lineup -- one line carries the films, another
-- carries the series, and a reader who subscribes to both was being asked to pick
-- which half of their own library we were allowed to know about.
--
-- It also forced an awkward mechanism on the paid line. A managed pass could not
-- sit alongside a reader's own list, so it had to STASH their source url, take the
-- row for itself, and hand it back when the pass lapsed (see 0019_live_pass). With
-- several rows allowed the stash has nothing left to do: our line is simply one
-- provider among the reader's, and a lapse removes that row and disturbs nothing
-- else.
--
-- The credentials concern from 0002 does not go away, it just moves. A cap lives
-- in the handler rather than the schema, because "too many" is a product question
-- that should not need a migration to answer, and every list is still sealed and
-- still never rendered.

/* ---------------------------------------------------------- the constraint -- */

-- Named implicitly by 0002 (`user_id uuid not null unique`), so Postgres called it
-- user_playlists_user_id_key. Dropped by that name, guarded so a database built
-- after this migration -- or one where it was already removed -- still applies.
alter table user_playlists drop constraint if exists user_playlists_user_id_key;

-- Where a list sits in the reader's own ordering, which is also the tie-break when
-- two providers both carry a title. Defaulted rather than backfilled per row:
-- every existing account has exactly one list, so they are all position 0 and
-- correct.
--
-- Added BEFORE the index below, which sorts on it. A migration that creates the
-- index first fails outright on a fresh database, and only there -- on an existing
-- one every statement is guarded and the file appears to apply cleanly.
alter table user_playlists add column if not exists position int not null default 0;

-- What replaces the constraint. Not a uniqueness rule: source_url is sealed with a
-- random nonce per write, so the same provider url encrypts to different bytes
-- every time and a UNIQUE on it would never fire. This is only the lookup the new
-- queries make constantly: "every list this reader has, in their order".
create index if not exists user_playlists_user_idx on user_playlists (user_id, position, id);

/* -------------------------------------------------------------- the stash --- */

-- Give back anything the stash is currently holding, as a row of its own.
--
-- Order matters here and it is the only destructive step in this file. A reader
-- part-way through a live pass has their own list sitting in stashed_source_url
-- with our managed line in source_url. Dropping the columns first would delete a
-- provider subscription they gave us and expect back, so the stash is materialised
-- into a real row BEFORE the columns go.
--
-- The label is carried across where there was one. `position` puts the returned
-- list after the managed line rather than in front of it: the reader is currently
-- paying us for the managed one, so it stays first until they say otherwise.
insert into user_playlists (user_id, label, source_url, position, managed)
select user_id,
       coalesce(stashed_label, 'My other list'),
       stashed_source_url,
       1,
       false
  from user_playlists
 where stashed_source_url is not null;

-- Only now, once nothing is held in them.
alter table user_playlists drop column if exists stashed_source_url;
alter table user_playlists drop column if exists stashed_label;

/* --------------------------------------------------------------- channels -- */

-- Nothing here needs changing, which is worth saying rather than leaving implied.
-- A channel already belongs to a PLAYLIST rather than to a user, so the fan-out is
-- a wider IN list against an index 0002 already created
-- (user_playlist_channels_playlist_idx) rather than a new access path.
