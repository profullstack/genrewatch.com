-- Following people, blocking them, and direct messages.
--
-- This is the other half of 0003, which said so at the time: it carried the
-- naming columns from the sibling brand's 0016_profiles_and_messages.sql and
-- noted that following, blocking and messages "are not ported yet -- so that when
-- the rest arrives it lands on the same shapes rather than colliding with a
-- parallel invention". This is the rest arriving. Column names, constraints and
-- indexes are taken verbatim, so a fix on either side ports as a diff.
--
-- The users columns (handle, display_name, bio, profile_public) are already here
-- from 0003 and are not repeated.

-- NOT an extension of `follows`. That table's subject_id is a bigint, because a
-- genre and a subject are bigserial; a user is a uuid. Widening it to text to
-- carry both would make every existing follow query cast on both sides and lose
-- its index, so following a person gets its own table with its own foreign keys --
-- which also means the database can enforce that a followee is a real account,
-- something the polymorphic table cannot do for any of its subjects.
create table if not exists user_follows (
  follower_id uuid not null references users(id) on delete cascade,
  followee_id uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  -- Following yourself is not a state worth supporting anywhere downstream.
  constraint user_follows_not_self check (follower_id <> followee_id)
);

-- "Who follows this person" is the follower list on a profile, and the primary key
-- only serves the other direction.
create index if not exists user_follows_followee_idx on user_follows (followee_id);

-- A block is one-directional and beats everything else: it stops messages and
-- hides the blocker from the blocked account's view of a follower list.
create table if not exists user_blocks (
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

create table if not exists messages (
  id           bigserial primary key,
  sender_id    uuid not null references users(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  body         text not null check (length(btrim(body)) between 1 and 4000),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  constraint messages_not_self check (sender_id <> recipient_id)
);

-- A thread is "everything between these two people, either direction", so both
-- orderings need an index or half of every conversation is a sequential scan.
create index if not exists messages_thread_idx
  on messages (sender_id, recipient_id, created_at desc);
create index if not exists messages_thread_rev_idx
  on messages (recipient_id, sender_id, created_at desc);

-- The unread badge is a count over one person's inbox, and it is read on every
-- page load, so it gets a partial index sized to the unread rows rather than the
-- whole table.
create index if not exists messages_unread_idx
  on messages (recipient_id)
  where read_at is null;
