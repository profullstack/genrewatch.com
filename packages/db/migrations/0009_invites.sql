-- Inviting people, and keeping that from becoming a way to send mail through us.
--
-- Two halves. A shareable link, which costs nothing and carries no risk because the
-- inviter does the sending themselves; and an "email it for me" convenience, which
-- is the half that needs limits, because it is a stranger's address receiving mail
-- from our domain at somebody else's request.

-- The personal code in an invite link. Null until the reader first asks for one --
-- generating one for every account would mint a few hundred thousand secrets nobody
-- asked for and most would never use.
alter table users add column if not exists invite_code text unique;

-- Who brought whom. One row per invited account, so accepting is idempotent: the
-- primary key is the INVITED user, which makes "you can only be invited once, by one
-- person" a property of the schema rather than of the code that writes it.
create table if not exists invite_claims (
  invited_user_id uuid primary key references users(id) on delete cascade,
  inviter_id      uuid not null references users(id) on delete cascade,
  claimed_at      timestamptz not null default now(),
  -- Inviting yourself is not a thing. Cheap to enforce here and impossible to
  -- forget later.
  constraint invite_claims_not_self check (invited_user_id <> inviter_id)
);

-- The read is "who has this person brought in", newest first.
create index if not exists invite_claims_inviter_idx
  on invite_claims (inviter_id, claimed_at desc);

-- Every invite email we send on somebody's behalf.
--
-- This exists to be counted. Without a per-account cap, an "invite your friends"
-- form is an open relay with our domain on the envelope, and the cost of that is
-- paid by the deliverability of every reminder we send to everybody else.
--
-- The address is recorded so a repeat send to the same person can be refused
-- quietly rather than turned into a way to badger somebody who ignored the first.
create table if not exists invite_sends (
  id         bigserial primary key,
  inviter_id uuid not null references users(id) on delete cascade,
  email      citext not null,
  sent_at    timestamptz not null default now()
);

create index if not exists invite_sends_inviter_idx on invite_sends (inviter_id, sent_at desc);
create index if not exists invite_sends_email_idx on invite_sends (email, sent_at desc);
