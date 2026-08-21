-- A reader's own channel list, for their own use.
--
-- This is a personal-player feature and the schema is shaped to keep it that way.
-- There is no sharing column and no visibility flag, because a list belongs to
-- exactly one account and is never pooled, relayed or resold. Everything is keyed
-- by user_id and cascades on delete, so removing an account removes the
-- credentials with it.
--
-- What it adds over the sibling site's version is `group_title`. A provider
-- playlist is already a genre catalogue -- "Movies | Horror", "UK | Documentary",
-- "Kids" -- and on a genre site that is the most interesting column in the file.
-- It is what lets a reader browse their own subscription the same way they browse
-- ours, without any of it leaving their account.
create table user_playlists (
  id             bigserial primary key,
  -- One list per account. A second add replaces the first rather than accumulating
  -- credentials nobody remembers giving us.
  user_id        uuid not null unique references users(id) on delete cascade,
  label          text,
  -- AES-256-GCM, sealed by packages/auth/src/secretbox.js. The URL carries the
  -- reader's provider username and password in its path, so it is never stored in
  -- the clear and never rendered into a page.
  source_url     text not null,
  channel_count  int not null default 0,
  last_synced_at timestamptz,
  last_error     text,
  created_at     timestamptz not null default now()
);

create table user_playlist_channels (
  id          bigserial primary key,
  playlist_id bigint not null references user_playlists(id) on delete cascade,
  position    int not null,
  title       text not null,
  -- The provider's own `group-title` attribute, verbatim. Not mapped onto our
  -- genres table: every provider names these differently and a wrong mapping is
  -- worse than the raw string, which at least matches what the reader sees in
  -- their own player.
  group_title text,
  -- Sealed like the source URL, and for the same reason: it is the same credential
  -- with a channel id on the end.
  stream_url  text not null,
  -- The title reduced to lowercase words, so matching is an index scan rather than
  -- normalising 7,000 rows per page view. Written once at import.
  norm_title  text not null
);

create index user_playlist_channels_playlist_idx
  on user_playlist_channels (playlist_id);

-- Browsing a reader's own list by group is the whole point of storing the column,
-- and it is a per-owner grouping rather than a global one.
create index user_playlist_channels_group_idx
  on user_playlist_channels (playlist_id, group_title);

-- Substring search over normalised titles, for matching an event to a channel.
create index user_playlist_channels_norm_idx
  on user_playlist_channels using gin (norm_title gin_trgm_ops);
