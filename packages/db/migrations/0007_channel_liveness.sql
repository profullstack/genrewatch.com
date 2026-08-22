-- Whether a channel actually plays, rather than merely existing in a playlist.
--
-- Ported from tipoffwatch's 0019_channel_liveness.sql. A provider list is mostly
-- aspirational: of the entries we hand people, a large share answer with an HTML
-- error page instead of video -- the slot exists, the title is right, and there is
-- nothing behind it. Offering one of those is worse than offering nothing, because
-- the reader taps it and finds out the hard way.
--
-- So a channel now carries the result of the last time we asked. Three states, and
-- the third is load-bearing: null means never checked, which must not be confused
-- with checked-and-dead. A never-checked channel is still offered -- probing
-- thousands of them on import is not possible against a provider that limits
-- concurrent connections -- and it is checked at the moment somebody reaches for it.
alter table user_playlist_channels add column if not exists is_live boolean;
alter table user_playlist_channels add column if not exists checked_at timestamptz;

-- What the probe saw, so a human can tell "returned an HTML error page" from
-- "connection refused" without re-running it.
alter table user_playlist_channels add column if not exists check_note text;

-- The read is "this playlist's channels, freshest verdict first", and the verdict
-- is only meaningful for a while: a slot that was dead an hour ago may be live now,
-- because providers rewrite their event slots around airtime.
create index if not exists user_playlist_channels_live_idx
  on user_playlist_channels (playlist_id, is_live, checked_at);

comment on column user_playlist_channels.is_live is
  'Last probe result. NULL means never checked, which is not the same as dead.';
