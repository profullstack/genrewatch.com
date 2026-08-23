-- Searching the things that are not subjects.
--
-- The box in the header now looks in five places, and four of them were already
-- indexed for it: subjects has a trigram index on search_text, genres is a few
-- dozen rows, user_playlist_channels has one on norm_title, and users.handle is
-- unique. events was the exception -- and it is the table that grows fastest, so
-- a sequential scan there is the one that turns into an outage rather than a slow
-- page.

/*
 * lower(name), not name.
 *
 * The query lowercases the needle once in JS and compares against lower(name), so
 * the index has to be over the same expression or it is never used -- an index on
 * `name` cannot serve a predicate on `lower(name)`. lower(text) is IMMUTABLE, so
 * this is a legal expression index without any wrapper of our own; that is not
 * true of the concatenations that made subjects.search_text a stored column.
 *
 * gin rather than gist: this is a read-mostly table written in bulk by the sync
 * passes, which is the shape gin is faster for, and a gin trigram index answers
 * `like '%...%'` as well as similarity.
 */
create index if not exists events_name_trgm_idx
  on events using gin (lower(name) gin_trgm_ops);
