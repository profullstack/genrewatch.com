-- Accounts. Magic link + passkey only: there is no password column on purpose,
-- so there is nothing to reset, rotate or leak.
create extension if not exists citext;
create extension if not exists pg_trgm;

create table users (
  id           uuid primary key default gen_random_uuid(),
  email        citext not null unique,
  timezone     text not null default 'UTC',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Magic links. Only the hash is stored, so a database read cannot mint a session.
create table login_tokens (
  token_hash  bytea primary key,
  email       citext not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index login_tokens_expires_idx on login_tokens (expires_at);

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table passkeys (
  credential_id text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

-- ---------------------------------------------------------------------------
-- Catalogue: category -> genre -> subject -> event.
--
-- The three tiers are deliberately the same shape as a sports ladder
-- (sport -> league -> team -> fixture), because that is the shape a reminder
-- product needs: a broad thing to browse, a narrow thing to follow, and a dated
-- thing to be told about. What changes here is that a genre site has no fixed
-- ladder -- a show belongs to five genres at once and an artist to three -- so
-- the subject/genre edge is a join table rather than a foreign key.
--
-- `category` is a plain text column rather than a table for the same reason
-- `sport` was: there are five of them, they change roughly never, and every
-- query that touches one wants to filter on it rather than join to it.
-- ---------------------------------------------------------------------------

create table genres (
  id           bigserial primary key,
  -- tv | film | music | anime | space. 'sports' is reserved and never populated:
  -- it redirects to tipoffwatch.com, which is the site that does it properly.
  category     text not null,
  -- provider + provider_key is the natural key from whichever adapter supplied
  -- the row, so two adapters can describe "Drama" without colliding.
  provider     text not null,
  provider_key text not null,
  slug         text not null unique,
  name         text not null,
  description  text,
  image_url    text,
  -- Drives polling cadence and ordering: hand-tuned for genres people follow.
  priority     int not null default 100,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (provider, provider_key)
);
create index genres_category_idx on genres (category) where active;

-- The followable specific thing: a show, a film, an artist, an anime, a launch
-- provider. `kind` is what the page calls it, and it is per-row rather than
-- per-category because one category holds several -- space has both agencies and
-- rocket families, music has both artists and labels.
create table subjects (
  id           bigserial primary key,
  category     text not null,
  kind         text not null,
  provider     text not null,
  provider_key text not null,
  slug         text not null unique,
  name         text not null,
  display_name text not null,
  description  text,
  image_url    text,
  url          text,
  created_at   timestamptz not null default now(),
  unique (provider, provider_key)
);
create index subjects_category_idx on subjects (category);
-- Powers the follow picker's search box.
create index subjects_name_trgm_idx on subjects using gin (display_name gin_trgm_ops);

-- A show is Drama AND Science-Fiction AND Thriller. Modelling that as a column
-- would force the adapter to pick one and throw the rest away, which is exactly
-- the information a genre site exists to keep.
create table subject_genres (
  subject_id bigint not null references subjects(id) on delete cascade,
  genre_id   bigint not null references genres(id) on delete cascade,
  -- The adapter's own ordering, so "the first genre" means something on a page.
  position   int not null default 0,
  primary key (subject_id, genre_id)
);
create index subject_genres_genre_idx on subject_genres (genre_id);

create table events (
  id            bigserial primary key,
  provider      text not null,
  provider_key  text not null,
  category      text not null,
  -- The subject this is an event OF. Unlike a fixture there is exactly one:
  -- an episode belongs to a show, a release to an artist, a launch to a provider.
  subject_id    bigint not null references subjects(id) on delete cascade,
  -- episode | premiere | finale | release | launch | film
  kind          text not null default 'release',
  starts_at     timestamptz not null,
  /*
   * Whether starts_at is a real clock time or a date we padded.
   *
   * This is the one thing a genre calendar has that a sports calendar does not.
   * A fixture always has a kickoff; a release date is very often "September
   * 2026" and nothing more. MusicBrainz returns a bare "2026" for a fifth of
   * what it knows about, and TheSpaceDevs says so explicitly in net_precision.
   *
   * Sending "starts in 60 minutes" for a date we invented would be a lie, so
   * date-only events get their own reminder offsets (see reminder_prefs) and
   * every renderer reads this before printing a time.
   */
  time_known    boolean not null default true,
  -- second | minute | hour | day | month | year, straight from the provider where
  -- it says. Kept alongside time_known because "day" and "year" are both untimed
  -- and only one of them is worth putting on a page.
  precision     text not null default 'minute',
  -- upcoming | out. There is no in-progress state: a release is not live for
  -- three hours, and the sites that do have one (sports) are not this site.
  state         text not null default 'upcoming',
  name          text not null,
  short_name    text,
  summary       text,
  image_url     text,
  -- The provider's own page, so every event can be verified by a reader.
  url           text,
  -- Where it happens or where it can be got: a network, a streaming service, a
  -- launch pad, a label. One column because only one of them is ever populated.
  venue         text,
  venue_region  text,
  -- Episodes only. Null everywhere else rather than zero, so a page can tell
  -- "season 1 episode 0" from "not a thing with episodes".
  season        int,
  number        int,
  runtime_min   int,
  updated_at    timestamptz not null default now(),
  unique (provider, provider_key)
);
create index events_starts_at_idx on events (starts_at);
create index events_subject_starts_idx on events (subject_id, starts_at);
create index events_category_starts_idx on events (category, starts_at);
-- The reminder scheduler's hot query: upcoming events only.
create index events_upcoming_idx on events (starts_at) where state = 'upcoming';
-- The scheduler runs two passes, one per reminder class, and each wants only its
-- own half of the table.
create index events_upcoming_timed_idx on events (starts_at)
  where state = 'upcoming' and time_known;

-- An event inherits its genres from its subject, but denormalised so that
-- "everything in Science-Fiction next week" is one index scan rather than a
-- three-table join over the whole calendar. Written by the same upsert that
-- writes subject_genres.
create table event_genres (
  event_id bigint not null references events(id) on delete cascade,
  genre_id bigint not null references genres(id) on delete cascade,
  primary key (event_id, genre_id)
);
create index event_genres_genre_idx on event_genres (genre_id);

-- ---------------------------------------------------------------------------
-- Following and reminders.
-- ---------------------------------------------------------------------------

-- subject_type lets one table carry both genre and subject follows, which keeps
-- the fan-out query a single union rather than two divergent code paths.
create table follows (
  user_id      uuid not null references users(id) on delete cascade,
  subject_type text not null check (subject_type in ('genre', 'subject')),
  subject_id   bigint not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, subject_type, subject_id)
);
create index follows_subject_idx on follows (subject_type, subject_id);

create table reminder_prefs (
  user_id         uuid primary key references users(id) on delete cascade,
  -- Minutes before an event that has a real clock time.
  offsets_minutes int[] not null default '{60,1}',
  /*
   * Minutes before an event that only has a date.
   *
   * A separate list because the sensible answers are different by two orders of
   * magnitude: you want to know an hour before a launch and the morning of a
   * book. 1440 is "the day before", 0 is "on the day", both measured against the
   * noon-UTC anchor the adapters store for an undated release.
   */
  date_offsets_minutes int[] not null default '{1440,0}',
  channels        text[] not null default '{webpush,email}',
  updated_at      timestamptz not null default now()
);

create table push_subscriptions (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  -- Set when the push service answers 404/410. Kept rather than deleted so a
  -- resubscribe from the same browser is visible as a repair, not a new device.
  disabled_at timestamptz
);
create index push_subs_user_idx on push_subscriptions (user_id) where disabled_at is null;

-- At-most-once delivery. The primary key IS the idempotency guard: a retried or
-- duplicated fan-out job cannot send the same person the same reminder twice.
create table reminder_deliveries (
  event_id       bigint not null references events(id) on delete cascade,
  user_id        uuid not null references users(id) on delete cascade,
  offset_minutes int not null,
  channel        text not null,
  status         text not null default 'sent',
  sent_at        timestamptz not null default now(),
  primary key (event_id, user_id, offset_minutes, channel)
);
create index reminder_deliveries_sent_idx on reminder_deliveries (sent_at);

-- Private calendar feed token, rotatable without touching the session.
alter table users add column calendar_token uuid not null default gen_random_uuid();
create unique index users_calendar_token_idx on users (calendar_token);

-- ---------------------------------------------------------------------------
-- Sync bookkeeping.
--
-- Kept on the genre row rather than in a jobs table for the reason trap 4 in the
-- sibling repo exists: a repeatable timer resets on every deploy, so "is this
-- overdue" has to be answered from data that only a completed pass writes.
-- ---------------------------------------------------------------------------
alter table genres add column synced_at timestamptz;
create index genres_synced_idx on genres (synced_at nulls first) where active;

-- ---------------------------------------------------------------------------
-- Comments. One thread per event, no nesting: the thing being discussed has a
-- date on it, so the thread has a natural end.
-- ---------------------------------------------------------------------------
create table comments (
  id         bigserial primary key,
  event_id   bigint not null references events(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index comments_event_idx on comments (event_id, created_at) where deleted_at is null;
create index comments_user_recent_idx on comments (user_id, created_at);
