-- A name to sign a comment with, that is not a fragment of an email address.
--
-- Comments were signed with the LOCAL PART OF THE AUTHOR'S EMAIL -- anthony@…
-- rendered as "anthony" on a page anyone can read without an account. Nothing
-- beyond the local part was ever printed, but it was still publishing something
-- nobody chose to publish, and the fix is to give people something they did
-- choose.
--
-- Column names and semantics are taken verbatim from tipoffwatch's
-- 0016_profiles_and_messages.sql, which is upstream for this codebase. Only the
-- naming half is here -- following people, blocking and direct messages are not
-- ported yet -- so that when the rest arrives it lands on the same shapes rather
-- than colliding with a parallel invention.
--
-- A handle is deliberately NOT derived from the email address, for exactly the
-- reason above: it is null until someone chooses one.
alter table users add column if not exists handle       citext unique;
alter table users add column if not exists display_name text;
alter table users add column if not exists bio          text;

-- Opt-out rather than opt-in: a profile shows nothing an account did not choose to
-- put there. Carried now so the flag exists before anything reads it.
alter table users add column if not exists profile_public boolean not null default true;
