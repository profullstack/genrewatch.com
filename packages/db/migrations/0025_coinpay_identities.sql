-- Sign in with CoinPay: bind a GenreWatch user to a CoinPay account by its
-- OIDC `sub`, never by email (CoinPay never verifies emails, so
-- email_verified is always false). One CoinPay account per user and one user
-- per CoinPay account.
--
-- created_via = 'connect': linked from Settings while signed in (the account
--   keeps its own email, link, passkeys and password).
-- created_via = 'signup': a first CoinPay login made the account. Its
--   users.email is a random placeholder under coinpay-users.genrewatch.com;
--   the CoinPay email is kept here as UNVERIFIED contact info and is never
--   used to find, merge or sign in to an account.
create table if not exists coinpay_identities (
  user_id uuid primary key references users (id) on delete cascade,
  coinpay_sub text not null unique,
  coinpay_email text,
  coinpay_name text,
  created_via text not null check (created_via in ('connect', 'signup')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
