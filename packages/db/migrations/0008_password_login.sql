-- An optional password, for devices that cannot do the other two.
--
-- Magic link and passkey remain the way in for anyone who has a phone or a laptop,
-- and this does not replace either. It exists because a television has neither: no
-- mail client to open a link in, no authenticator to hold a passkey, and a remote
-- control instead of a keyboard. "Sign in on another device" is not an answer when
-- the TV is the device the account is being used on.
--
-- Null means no password, which is the default and stays the default -- an account
-- only has one if somebody deliberately set one while already signed in. So this
-- adds a way in without adding a credential to every existing account.
alter table users add column if not exists password_hash   text;
alter table users add column if not exists password_set_at timestamptz;

-- Every attempt, counted in the database so the limit survives a restart and is
-- shared across however many containers are running. An in-process counter is not a
-- rate limit when the process is replaceable.
--
-- Successes are recorded as well as failures, deliberately: the row is what lets
-- somebody be told where their account has been signed in from, and a table of only
-- failures cannot answer that.
create table if not exists login_attempts (
  id         bigserial primary key,
  -- Not a foreign key. An attempt against an address with no account is exactly
  -- the kind we most want counted, and it has no user id to point at.
  email      citext not null,
  ok         boolean not null,
  ip         text,
  at         timestamptz not null default now()
);

-- The read is always "recent attempts for this address", newest first.
create index if not exists login_attempts_email_idx on login_attempts (email, at desc);

-- Kept only long enough to enforce the limit and answer "was that you"; this is a
-- log of who tried to get into what, which is not something to hoard.
create index if not exists login_attempts_at_idx on login_attempts (at);
