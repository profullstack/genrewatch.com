-- Refreshing a channel list on a schedule.
--
-- Ported from tipoffwatch's 0017_playlist_refresh.sql, which is upstream for this
-- codebase. The measurement behind it was taken against a real provider on
-- 2026-08-21: no ETag, no Last-Modified, no Content-Length, and If-Modified-Since
-- ignored and answered with a full 200. So every poll is the whole ~800KB file and
-- there is no way to ask "has it changed" cheaply.
--
-- What CAN be avoided is the write. A hash of the body decides whether the channel
-- rows are rewritten, and most polls will hash the same -- a provider rewrites the
-- few slots that changed and leaves the rest alone. Without this, a five-minute
-- poll is 288 delete-and-reinsert cycles a day over thousands of rows each, for a
-- file that changed a dozen times.
alter table user_playlists add column if not exists content_hash text;

-- When this list may next be fetched. Normally "now", but a provider that is down
-- or a line that has expired gets backed off rather than retried every interval --
-- there is no point pulling 800KB every five minutes from something answering 404,
-- and hammering a dead line is how the account behind it gets noticed.
alter table user_playlists add column if not exists refresh_after timestamptz;
alter table user_playlists add column if not exists error_streak int not null default 0;

-- The poller asks "which lists are due", which is a small scan over a small table,
-- but the index keeps it proportional to what is due rather than to how many
-- accounts exist.
create index if not exists user_playlists_due_idx
  on user_playlists (refresh_after nulls first);
