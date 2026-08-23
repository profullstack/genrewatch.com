-- What KIND of thing each entry in a reader's list is.
--
-- parseM3u has worked this out since it was written -- live channel, film, or
-- episode of a series, read off the URL path and the group -- and it was thrown
-- away at the door. Nothing stored it, so `rankChannelsForTitle` fell back to
-- computing it at match time from the row it was handed... which carries the
-- SEALED url. entryKind then looked for "/movie/" inside a base64 blob, found
-- nothing, and returned 'live' for every entry ever imported.
--
-- The visible effect was that "Available on demand" -- the whole point of the
-- three-tier layout, and the better answer of the three, because a file is there
-- whenever you want it where a channel is a claim about right now -- could never
-- render for anybody. A matched film still appeared, just filed under live
-- channels.
--
-- So it is a column now, and it must be: the URL it is derived from is encrypted
-- at rest, so working it out on a page would mean decrypting several thousand rows
-- to look at their paths.
alter table user_playlist_channels
  add column if not exists kind text;

/*
 * Nullable, and null does not mean 'live'.
 *
 * Rows imported before this existed have no kind and must not be defaulted to
 * 'live' -- that would assert something false about every VOD entry already
 * stored, which is exactly the bug this migration fixes, re-introduced as data.
 * They repair themselves on the next refresh (every PLAYLIST_REFRESH_MINUTES,
 * five by default) because replacePlaylistChannels rewrites the list wholesale.
 */
comment on column user_playlist_channels.kind is
  'live | vod | series, decided at import. NULL means imported before the column existed.';

-- Counting a list by kind is what answers "does my provider actually carry films",
-- and it is a per-owner question.
create index if not exists user_playlist_channels_kind_idx
  on user_playlist_channels (playlist_id, kind);
