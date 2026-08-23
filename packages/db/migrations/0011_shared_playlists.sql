-- Letting one account's channel list be seen by the others.
--
-- Everything about this table was built to make that impossible: 0002 says
-- outright "there is no sharing column and no visibility flag, because a list
-- belongs to exactly one account and is never pooled". That was the right default
-- and it stays the default. This adds an explicit, per-list, owner-set opt-out
-- from it, because the owner of the line asked for one.
--
-- What the owner is actually agreeing to, and why the UI says it in these words:
--
--   1. The stream URL carries their provider username and password in its path.
--      Handing somebody a channel from a shared list hands them that credential.
--      It is sealed at rest and never rendered into a page, but a downloaded .m3u
--      is the credential, and there is no version of "let other people play this"
--      that is not also "let other people have this".
--   2. A provider line permits a small number of concurrent connections and
--      suspends the account for exceeding it. One list, many readers, one line.
--
-- So: false by default, set only by the owner, and every read of somebody else's
-- list goes through a query that checks this column rather than through the
-- ownership join the rest of the file uses.
alter table user_playlists
  add column if not exists shared boolean not null default false;

-- Set when the flag was last turned on, so a page can say how long it has been
-- open rather than only that it is. Null while it has never been shared.
alter table user_playlists
  add column if not exists shared_at timestamptz;

-- The label other people see. The owner's own label defaults to the provider
-- hostname, which is exactly the thing not to publish -- it names their provider
-- to everybody on the site. Null means "fall back to the owner's handle".
alter table user_playlists
  add column if not exists shared_label text;

-- The read is "every shared list", which is a handful of rows out of one per
-- account. A partial index keeps it that size regardless of how many accounts
-- import a list of their own.
create index if not exists user_playlists_shared_idx
  on user_playlists (user_id) where shared;
