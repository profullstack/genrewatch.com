-- Live TV passes: a line of our own, sold by the week, month or year.
--
-- Until now a reader could only watch a channel they already paid somebody else
-- for: "bring your own list" was the whole rail. This adds the other half. We
-- hold a reseller account with a provider, a pass buys a line on it, and that
-- line is dropped into user_playlists like any list the reader could have
-- pasted -- so Play, Multiview, the probes and the connection cap all work
-- unchanged. The reader never sees who the provider is and never sees the
-- credential: a managed list plays in the page and nowhere else.

/* ------------------------------------------------------------------ passes -- */

-- One row per TERM PAID FOR, exactly like memberships beside it. A renewal is a
-- new row that starts where the last one ends, and "do they hold a pass" is
-- `max(expires_at) > now()`. Same shape for the same reasons: which payment
-- bought which stretch of time, and a replayed webhook that can insert nothing.
create table if not exists live_passes (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  -- Unique: `payments` is unique on (provider, provider_ref), so a webhook
  -- replayed ten times updates one payment row and can grant exactly one term.
  payment_id  bigint unique references payments(id) on delete set null,
  plan        text not null check (plan in ('week', 'month', 'year')),
  status      text not null default 'active',
  started_at  timestamptz not null default now(),
  -- Never null. A pass with no expiry is a perpetual line nobody decided to sell.
  expires_at  timestamptz not null,
  price_cents int not null check (price_cents >= 0),
  currency    text not null default 'USD',
  created_at  timestamptz not null default now(),
  constraint live_passes_term_forwards check (expires_at > started_at)
);

create index if not exists live_passes_user_idx on live_passes (user_id, expires_at desc);

/* ------------------------------------------------------------------- lines -- */

-- The line the provider issued for this account. One per reader, kept across
-- passes: somebody whose pass lapses and who buys again gets the same line back,
-- extended, rather than a second one on our reseller balance.
--
-- Every credential column is sealed with packages/auth/src/secretbox.js, like
-- user_playlists.source_url. The provider's own id for the line is not a secret
-- and is what extensions are addressed by.
create table if not exists provider_lines (
  user_id         uuid primary key references users(id) on delete cascade,
  line_id         bigint not null unique,
  line_user       text not null,
  line_secret     text not null,
  source_url      text not null,
  max_connections int,
  -- What the PROVIDER believes: when the line itself stops answering. Distinct
  -- from the pass, which is what WE sold; a weekly pass rides a monthly line and
  -- access is gated on the pass, never on this.
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

/* ------------------------------------------------------- the managed list -- */

-- A managed list is our line, not the reader's. Three things follow from the
-- flag and nothing else does: the address is never revealed, the entries are
-- never handed to an external player or a .m3u, and the list cannot be shared --
-- each of those is the same act, handing our reseller credential to somebody
-- who did not pay for it.
alter table user_playlists add column if not exists managed boolean not null default false;

-- A reader who already had a list of their own when the pass was set up. Their
-- address is parked here, sealed as it was, and put back when the pass lapses --
-- buying a week of ours must not cost them the list they pay somebody else for.
alter table user_playlists add column if not exists stashed_source_url text;
alter table user_playlists add column if not exists stashed_label text;
