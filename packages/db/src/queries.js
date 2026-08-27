import { sql } from './index.js';

/**
 * Every query the app runs lives here. Route handlers and workers import from this
 * module and never write SQL themselves -- that is what makes a schema change one
 * grep instead of an archaeology dig.
 */

/**
 * A Postgres array literal.
 *
 * Bun's parameter serialiser stringifies a JS array with Array.prototype.toString,
 * so `['internal','hybrid']` reaches Postgres as `internal,hybrid` and is rejected
 * as a malformed array literal -- silently breaking passkey registration, saving
 * reminder preferences, and the reminder fan-out's user lookup. Building the
 * literal here and casting at the call site is deterministic and does not depend
 * on how the driver decides to encode a parameter.
 */
export function pgArray(values) {
  const items = (values ?? []).map((v) =>
    // Unquoted NULL, not the string "null": a nullable column must arrive as SQL NULL.
    v === null || v === undefined ? 'NULL' : `"${String(v).replace(/(["\\])/g, '\\$1')}"`,
  );
  return `{${items.join(',')}}`;
}

/*
 * citext columns are cast to text on the way out.
 *
 * citext is an EXTENSION type, so its OID is assigned by the database when the
 * extension is installed rather than being one of Postgres' built-ins. A driver
 * can only decode it by recognising that OID, and when it does not, the value
 * arrives as something that is not a string -- which renders as "[object Object]"
 * the moment a page prints it, and compares unequal to every string it is checked
 * against.
 *
 * Casting here costs nothing and does not depend on the driver, the extension's
 * OID, or which database this happens to be pointed at. Case-insensitivity is a
 * property of the COLUMN and its unique index, so nothing is lost by handing the
 * application a plain string.
 */

/* ---------------------------------------------------------------- accounts -- */

/**
 * Magic-link consumption creates the account if the address is new. There is no
 * separate registration path: proving you can read the mailbox IS the account.
 */
export async function findOrCreateUser(email) {
  const [row] = await sql`
    insert into users ${sql({ email })}
    on conflict (email) do update set last_seen_at = now()
    -- Whether this row was inserted or updated, which upsert otherwise hides.
    -- xmax is the transaction that deleted the tuple; an INSERT leaves it zero and
    -- the ON CONFLICT update leaves it set. It is the only way to tell the two
    -- apart in one statement, and the alternative -- comparing created_at to now --
    -- is a guess with a clock in it. Used by the invite flow, which must credit an
    -- inviter for a new account and not for somebody who already had one.
    returning *, email::text as email, (xmax = 0) as created
  `;
  return row;
}

/* ------------------------------------------------------------- passwords -- */

/**
 * The row a password sign-in checks against.
 *
 * Returns null for an address with no account, and a row with a null hash for an
 * account that never set one. The caller must treat those two the same way from
 * the outside -- see verifyPassword, which spends the same time on both.
 */
export async function getUserForPassword(email) {
  const [row] = await sql`
    select id, email::text as email, password_hash
    from users where email = ${String(email).trim().toLowerCase()}
  `;
  return row ?? null;
}

export async function setPasswordHash({ userId, hash }) {
  await sql`
    update users set password_hash = ${hash}, password_set_at = now()
    where id = ${userId}
  `;
}

/** Removing it leaves the account reachable by link and passkey, never locked out. */
export async function clearPassword(userId) {
  await sql`
    update users set password_hash = null, password_set_at = null where id = ${userId}
  `;
}

export async function recordLoginAttempt({ email, ok, ip }) {
  await sql`
    insert into login_attempts (email, ok, ip)
    values (${String(email).trim().toLowerCase()}, ${ok}, ${ip ?? null})
  `;
}

/**
 * How many times this address has failed recently.
 *
 * Counted since the last SUCCESS, not over a flat window: signing in correctly is
 * the clearest possible evidence that the person is who they say, so it should not
 * leave them one typo away from a lockout inherited from an attacker.
 */
export async function recentFailedLogins({ email, minutes = 15 }) {
  const [row] = await sql`
    select count(*)::int as n from login_attempts
    where email = ${String(email).trim().toLowerCase()}
      and not ok
      and at > now() - (${`${minutes} minutes`})::interval
      and at > coalesce(
        (select max(at) from login_attempts
          where email = ${String(email).trim().toLowerCase()} and ok),
        'epoch'::timestamptz
      )
  `;
  return row.n;
}

/** This is a log of who tried to get into what, so it is not kept indefinitely. */
export async function pruneLoginAttempts({ days = 30 } = {}) {
  const rows = await sql`
    delete from login_attempts where at < now() - (${`${days} days`})::interval
    returning id
  `;
  return rows.length;
}

/**
 * A profile by its handle.
 *
 * Returns the row whether or not it is public: the ROUTE decides what to do with a
 * private one, because the owner is allowed to look at their own. Doing that
 * filtering here would make "private" and "does not exist" the same answer, and then
 * the owner could not see their own page either.
 */
export async function getUserByHandle(handle) {
  const [row] = await sql`
    select id, handle::text as handle, display_name, bio, profile_public, created_at
    from users where handle = ${String(handle ?? '').trim()}
  `;
  return row ?? null;
}

/**
 * Public profiles worth submitting to a search engine.
 *
 * Three filters, and the third is the one that matters. A handle and profile_public
 * are the obvious ones. But an account that has picked a name and done nothing else
 * is a thin page -- no bio, no follows, nothing to read -- and submitting thousands
 * of those is how a site teaches a crawler that most of it is empty. So a profile has
 * to have SOMETHING on it: a bio, a display name, or something followed.
 *
 * Upstream also counts following other PEOPLE; there is no user_follows table here,
 * so that clause is dropped rather than faked.
 *
 * A profile turned private, or emptied, simply stops appearing; the sitemap is
 * generated per request rather than stored, so removal needs no cleanup.
 */
export async function publicProfiles({ limit = 45000 } = {}) {
  return sql`
    select u.handle::text as handle, u.created_at
    from users u
    where u.handle is not null
      and u.profile_public
      and (
        u.bio is not null
        or u.display_name is not null
        or exists (select 1 from follows f where f.user_id = u.id)
      )
    order by u.created_at desc
    limit ${limit}
  `;
}

/* --------------------------------------------------------------- invites -- */

/**
 * The reader's own invite code, minted on first use.
 *
 * `where invite_code is null` makes this safe to call on every page load: the second
 * call updates nothing and the select returns what the first one wrote. Two requests
 * racing cannot produce two codes for one account, because only one of them matches
 * the null.
 */
export async function ensureInviteCode({ userId, code }) {
  await sql`update users set invite_code = ${code} where id = ${userId} and invite_code is null`;
  const [row] = await sql`select invite_code from users where id = ${userId}`;
  return row?.invite_code ?? null;
}

export async function getUserByInviteCode(code) {
  const [row] = await sql`
    select id, display_name, handle::text as handle
    from users where invite_code = ${code}
  `;
  return row ?? null;
}

/**
 * Record who brought whom.
 *
 * `on conflict do nothing` because the invited user is the primary key: being
 * invited twice, or by two people, resolves to whoever got there first rather than
 * to an error the sign-in path would have to handle.
 */
export async function recordInviteClaim({ inviterId, invitedUserId }) {
  if (!inviterId || !invitedUserId || inviterId === invitedUserId) return false;
  const rows = await sql`
    insert into invite_claims (invited_user_id, inviter_id)
    values (${invitedUserId}, ${inviterId})
    on conflict do nothing
    returning invited_user_id
  `;
  return rows.length > 0;
}

/**
 * Who accepted, for the inviter's own page.
 *
 * Deliberately does NOT select an email address. The inviter knows who they sent a
 * link to, but that is not the same as us confirming which addresses have accounts
 * -- and an invited person never agreed to have their sign-up reported back. A
 * chosen name is something they published themselves; anything else is just a date.
 */
export async function invitesAccepted(inviterId, { limit = 100 } = {}) {
  return sql`
    select c.claimed_at, u.display_name, u.handle::text as handle
    from invite_claims c
    join users u on u.id = c.invited_user_id
    where c.inviter_id = ${inviterId}
    order by c.claimed_at desc
    limit ${limit}
  `;
}

export async function recordInviteSend({ inviterId, email }) {
  await sql`
    insert into invite_sends (inviter_id, email)
    values (${inviterId}, ${String(email).trim().toLowerCase()})
  `;
}

/** How many this account has sent recently, which is what the cap is applied to. */
export async function invitesSentSince(inviterId, { hours = 24 } = {}) {
  const [row] = await sql`
    select count(*)::int as n from invite_sends
    where inviter_id = ${inviterId} and sent_at > now() - (${`${hours} hours`})::interval
  `;
  return row.n;
}

/**
 * Has anybody already invited this address?
 *
 * Not scoped to the inviter on purpose. The question is whether the person on the
 * other end has already had one of these, and being emailed the same pitch by three
 * different people is exactly what makes an invite feature feel like spam to the
 * only party who did not opt into it.
 */
export async function invitedRecently({ email, days = 30 }) {
  const [row] = await sql`
    select count(*)::int as n from invite_sends
    where email = ${String(email).trim().toLowerCase()}
      and sent_at > now() - (${`${days} days`})::interval
  `;
  return row.n > 0;
}

export async function insertLoginToken({ tokenHash, email, expiresAt }) {
  await sql`
    insert into login_tokens ${sql({ token_hash: tokenHash, email, expires_at: expiresAt })}
  `;
}

/** Single-use by construction: the update is the consumption. */
/**
 * Spend a sign-in link and hand back the ADDRESS it was minted for.
 *
 * The address, not the row. Returning the row shipped for three days and did
 * real damage: consumeLoginLink passes this straight to findOrCreateUser, which
 * interpolates it into `insert into users (email)`, and an object stringifies to
 * the literal text "[object Object]". So every magic-link sign-in upserted the
 * SAME email and everybody who signed in landed in one shared account -- each
 * seeing the previous person's lists, follows and settings.
 *
 * A single `?.email` is all that stands between those two behaviours, which is
 * why the test beside it asserts on the returned type rather than on the query.
 */
export async function consumeLoginToken(tokenHash) {
  const [row] = await sql`
    update login_tokens set consumed_at = now()
    where token_hash = ${tokenHash} and consumed_at is null and expires_at > now()
    returning email
  `;
  return row?.email ?? null;
}

export async function startSession({ userId, ttlDays, userAgent }) {
  const [row] = await sql`
    insert into sessions ${sql({
      user_id: userId,
      expires_at: new Date(Date.now() + ttlDays * 86_400_000),
      user_agent: userAgent ?? null,
    })}
    returning id
  `;
  return row.id;
}

export async function getSessionUser(sessionId) {
  const [row] = await sql`
    select u.*, u.email::text as email, u.handle::text as handle
    from sessions s
    join users u on u.id = s.user_id
    where s.id = ${sessionId}::uuid and s.expires_at > now()
  `;
  return row ?? null;
}

export async function endSession(sessionId) {
  await sql`delete from sessions where id = ${sessionId}::uuid`;
}

export async function setUserTimezone(userId, timezone) {
  await sql`update users set timezone = ${timezone} where id = ${userId}`;
}

/* ---------------------------------------------------------------- passkeys -- */

export async function insertPasskey({ credentialId, userId, publicKey, counter, transports }) {
  await sql`
    insert into passkeys ${sql({
      credential_id: credentialId,
      user_id: userId,
      public_key: publicKey,
      counter,
    })}
  `;
  // Separate statement so the array literal can be cast explicitly. See pgArray.
  await sql`
    update passkeys set transports = ${pgArray(transports)}::text[]
    where credential_id = ${credentialId}
  `;
}

export async function getPasskey(credentialId) {
  const [row] = await sql`select * from passkeys where credential_id = ${credentialId}`;
  return row ?? null;
}

export async function listPasskeys(userId) {
  return sql`
    select credential_id, created_at, last_used_at from passkeys
    where user_id = ${userId} order by created_at
  `;
}

export async function touchPasskey(credentialId, counter) {
  await sql`
    update passkeys set counter = ${counter}, last_used_at = now()
    where credential_id = ${credentialId}
  `;
}

/* ------------------------------------------------------ profiles & people -- */

/*
 * The naming half of tipoffwatch's 0016_profiles_and_messages, ported so that
 * comments stop being signed with a fragment of the author's email address.
 * Following people, blocking and direct messages are NOT ported yet -- the shapes
 * here match upstream exactly so the rest can land on them rather than colliding
 * with a parallel invention.
 */

/** Handles are the profile URL, so the shape is constrained rather than trusted. */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_]{1,28}[a-z0-9])$/i;

/**
 * Names we refuse to hand out, because a profile at one of these would shadow a
 * real page or impersonate the site. Checked here rather than in the route so it
 * cannot be bypassed by a second caller later.
 *
 * The list is this site's routes, not upstream's -- genres and subjects where it
 * has leagues and teams.
 */
const RESERVED_HANDLES = new Set([
  'about',
  'admin',
  'api',
  'calendar',
  'categories',
  'events',
  'feeds',
  'following',
  'genres',
  'genrewatch',
  'health',
  'healthz',
  'help',
  // Not because they would shadow a page -- profiles live under /u/ -- but because
  // @invite reads as something the site said rather than something a person chose.
  'i',
  'invite',
  'invites',
  'login',
  'logout',
  'me',
  'messages',
  'my',
  'settings',
  'signup',
  'sitemap',
  'sports',
  'staff',
  'subjects',
  'support',
  'u',
  'watch',
]);

export const handleAvailableShape = (h) =>
  HANDLE_RE.test(h ?? '') && !RESERVED_HANDLES.has(String(h).toLowerCase());

/**
 * Set or change the name a person is known by.
 *
 * The unique index is the real guard -- two people claiming the same handle in the
 * same instant is a race no read-then-write can close -- so a conflict is caught
 * and reported rather than pre-checked.
 */
export async function updateProfile({ userId, handle, displayName, bio, profilePublic }) {
  try {
    const [row] = await sql`
      update users set
        handle = ${handle ?? null},
        display_name = ${displayName ?? null},
        bio = ${bio ?? null},
        profile_public = ${profilePublic}
      where id = ${userId}
      returning id, handle::text as handle, display_name, bio, profile_public
    `;
    return { ok: true, user: row };
  } catch (err) {
    if (String(err?.message ?? '').includes('users_handle_key')) {
      return { ok: false, error: 'That handle is taken.' };
    }
    throw err;
  }
}

/* -------------------------------------------------------- catalogue writes -- */

/**
 * Bulk upsert, returning a provider key -> id map.
 *
 * The map is the point. Adapters cross-reference their three tiers by provider
 * key because they cannot know our ids, so every write step has to hand the next
 * one a translation table. Doing it as one multi-row statement rather than a loop
 * matters at this size: a TV sync touches ~6,500 events, and the cost is round
 * trips, not rows.
 */
async function upsertReturningMap(rows, run) {
  if (!rows || rows.length === 0) return new Map();

  /*
   * Deduplicate by provider key before inserting anything.
   *
   * Postgres rejects an INSERT ... ON CONFLICT DO UPDATE whose own batch names
   * the same conflict target twice -- "ON CONFLICT DO UPDATE command cannot
   * affect row a second time" -- and it fails the WHOLE statement, so one
   * repeated row loses the entire pass.
   *
   * This is not hypothetical and not one adapter's problem. TMDB's discover
   * endpoint is ordered by popularity and paginated, and popularity shifts
   * between the requests, so a film near a page boundary is returned on two
   * consecutive pages. It took the film category from 2,276 events to zero on
   * the first production sync. Any paginated provider whose ordering is not
   * stable can do the same, which is why this lives here rather than in the
   * adapter that happened to expose it.
   *
   * The LAST occurrence wins, matching the upsert's own semantics: within one
   * pass, later data is fresher.
   */
  const unique = new Map();
  for (const row of rows) {
    // These are the ADAPTER's rows, not the mapped ones -- each caller maps to
    // snake_case inside run(). Reading provider_key here would be undefined for
    // every row and collapse the whole batch to a single entry.
    const key = row.providerKey ?? row.provider_key;
    if (!key) continue;
    unique.set(key, row);
  }
  const deduped = [...unique.values()];

  const out = new Map();
  // Chunked because a single statement has a parameter ceiling and TV alone would
  // blow through it. 500 keeps each statement comfortably inside the limit.
  for (let i = 0; i < deduped.length; i += 500) {
    const returned = await run(deduped.slice(i, i + 500));
    for (const r of returned) out.set(r.provider_key, r.id);
  }
  return out;
}

export async function upsertGenres(genres) {
  return upsertReturningMap(genres, (chunk) => {
    const rows = chunk.map((g) => ({
      category: g.category,
      provider: g.provider,
      provider_key: g.providerKey,
      slug: g.slug,
      name: g.name,
      description: g.description ?? null,
      image_url: g.imageUrl ?? null,
      priority: g.priority ?? 100,
    }));
    return sql`
      insert into genres ${sql(rows)}
      on conflict (provider, provider_key) do update set
        name = excluded.name,
        description = coalesce(excluded.description, genres.description),
        image_url = coalesce(excluded.image_url, genres.image_url),
        active = true
      returning id, provider_key
    `;
  });
}

export async function upsertSubjects(subjects) {
  return upsertReturningMap(subjects, (chunk) => {
    const rows = chunk.map((s) => ({
      category: s.category,
      kind: s.kind,
      provider: s.provider,
      provider_key: s.providerKey,
      slug: s.slug,
      name: s.name,
      display_name: s.displayName ?? s.name,
      description: s.description ?? null,
      image_url: s.imageUrl ?? null,
      backdrop_url: s.backdropUrl ?? null,
      popularity: s.popularity ?? null,
      // Lowercased once here rather than per query: a trigram index cannot be
      // built over an expression, and matching has to be case-insensitive.
      search_text: String(s.displayName ?? s.name ?? '').toLowerCase(),
      /*
       * The linking key for the IMDb backfill, written on every upsert.
       *
       * Produced by the caller through @genre/catalog's normaliseTitle -- the same
       * function that normalises a channel title in somebody's playlist -- because
       * the two sides of a match have to agree about punctuation and accents.
       * Falls back to the lowercased name for callers that predate the column, so
       * an adapter that has not been updated writes something usable rather than
       * a null that the backfill would then have to repair.
       */
      norm_title:
        s.normTitle ??
        String(s.displayName ?? s.name ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim(),
      year: s.year ?? null,
      imdb_id: s.imdbId ?? null,
      rating: s.rating ?? null,
      rating_count: s.ratingCount ?? null,
      url: s.url ?? null,
    }));
    return sql`
      insert into subjects ${sql(rows)}
      on conflict (provider, provider_key) do update set
        name = excluded.name,
        display_name = excluded.display_name,
        -- coalesce: a provider that omits a field on one pass must not blank a
        -- value an earlier pass established. Description and artwork in
        -- particular arrive late and intermittently.
        description = coalesce(excluded.description, subjects.description),
        image_url = coalesce(excluded.image_url, subjects.image_url),
        backdrop_url = coalesce(excluded.backdrop_url, subjects.backdrop_url),
        popularity = coalesce(excluded.popularity, subjects.popularity),
        search_text = excluded.search_text,
        norm_title = excluded.norm_title,
        year = coalesce(subjects.year, excluded.year),
        -- Never reassigned by an ordinary sync: a tconst is established by the
        -- backfill's linking pass, and an adapter that does not know one must not
        -- be able to clear it.
        imdb_id = coalesce(subjects.imdb_id, excluded.imdb_id),
        rating = coalesce(excluded.rating, subjects.rating),
        rating_count = coalesce(excluded.rating_count, subjects.rating_count),
        url = coalesce(excluded.url, subjects.url)
      returning id, provider_key
    `;
  });
}

export async function upsertEvents(events) {
  return upsertReturningMap(events, (chunk) => {
    const rows = chunk.map((e) => ({
      provider: e.provider,
      provider_key: e.providerKey,
      category: e.category,
      subject_id: e.subjectId,
      kind: e.kind,
      starts_at: e.startsAt,
      time_known: e.timeKnown !== false,
      precision: e.precision ?? 'minute',
      state: e.state ?? 'upcoming',
      name: e.name,
      short_name: e.shortName ?? null,
      summary: e.summary ?? null,
      image_url: e.imageUrl ?? null,
      backdrop_url: e.backdropUrl ?? null,
      tagline: e.tagline ?? null,
      rating: e.rating ?? null,
      rating_count: e.ratingCount ?? null,
      trailer_url: e.trailerUrl ?? null,
      detail: e.detail ? JSON.stringify(e.detail) : null,
      url: e.url ?? null,
      venue: e.venue ?? null,
      venue_region: e.venueRegion ?? null,
      season: e.season ?? null,
      number: e.number ?? null,
      runtime_min: e.runtimeMin ?? null,
    }));
    return sql`
      insert into events ${sql(rows)}
      on conflict (provider, provider_key) do update set
        -- A date moving is the single most important thing this table records:
        -- a delayed film or a slipped launch has to be able to move, so these are
        -- assigned rather than coalesced.
        starts_at = excluded.starts_at,
        time_known = excluded.time_known,
        precision = excluded.precision,
        state = excluded.state,
        name = excluded.name,
        short_name = excluded.short_name,
        summary = coalesce(excluded.summary, events.summary),
        image_url = coalesce(excluded.image_url, events.image_url),
        backdrop_url = coalesce(excluded.backdrop_url, events.backdrop_url),
        tagline = coalesce(excluded.tagline, events.tagline),
        rating = coalesce(excluded.rating, events.rating),
        rating_count = coalesce(excluded.rating_count, events.rating_count),
        trailer_url = coalesce(excluded.trailer_url, events.trailer_url),
        -- coalesce, so a cheap pass that carries no detail cannot wipe what an
        -- expensive one already found.
        detail = coalesce(excluded.detail, events.detail),
        url = coalesce(excluded.url, events.url),
        venue = coalesce(excluded.venue, events.venue),
        venue_region = coalesce(excluded.venue_region, events.venue_region),
        -- Must be updated, not just set on insert. If a subject row is ever
        -- rebuilt, existing events would otherwise point at nothing forever --
        -- and it looks fine, because the event carries its own title, while every
        -- subject page sits empty.
        subject_id = excluded.subject_id,
        season = coalesce(excluded.season, events.season),
        number = coalesce(excluded.number, events.number),
        runtime_min = coalesce(excluded.runtime_min, events.runtime_min),
        updated_at = now()
      returning id, provider_key
    `;
  });
}

/**
 * Replace a subject's genre edges.
 *
 * Delete-then-insert rather than a merge, because a genre being REMOVED is real
 * information -- a provider re-tagging a show from Drama to Documentary should
 * take it out of the Drama feed, and an upsert-only path would leave it in both
 * forever.
 */
export async function replaceSubjectGenres(pairs) {
  const usable = (pairs ?? []).filter((p) => p.subjectId && p.genreIds?.length);
  if (usable.length === 0) return;

  for (let i = 0; i < usable.length; i += 500) {
    const chunk = usable.slice(i, i + 500);
    const ids = chunk.map((p) => p.subjectId);
    await sql`delete from subject_genres where subject_id = any(${pgArray(ids)}::bigint[])`;
    const rows = chunk.flatMap((p) =>
      p.genreIds.map((genreId, position) => ({
        subject_id: p.subjectId,
        genre_id: genreId,
        position,
      })),
    );
    if (rows.length === 0) continue;
    await sql`
      insert into subject_genres ${sql(rows)}
      on conflict (subject_id, genre_id) do nothing
    `;
  }
}

export async function replaceEventGenres(pairs) {
  const usable = (pairs ?? []).filter((p) => p.eventId && p.genreIds?.length);
  if (usable.length === 0) return;

  for (let i = 0; i < usable.length; i += 500) {
    const chunk = usable.slice(i, i + 500);
    const ids = chunk.map((p) => p.eventId);
    await sql`delete from event_genres where event_id = any(${pgArray(ids)}::bigint[])`;
    const rows = chunk.flatMap((p) =>
      p.genreIds.map((genreId) => ({ event_id: p.eventId, genre_id: genreId })),
    );
    if (rows.length === 0) continue;
    await sql`
      insert into event_genres ${sql(rows)}
      on conflict (event_id, genre_id) do nothing
    `;
  }
}

/**
 * When this category last COMPLETED a sync.
 *
 * Read from the genre rows rather than from a job record, because a repeatable
 * job's timer resets on every deploy and would report a sweep as recent when it
 * never ran. Only a finished pass writes synced_at.
 */
export async function lastSyncedAt(category) {
  const [row] = await sql`
    select max(synced_at) as at from genres where category = ${category} and active
  `;
  return row?.at ?? null;
}

export async function markCategorySynced(category) {
  await sql`update genres set synced_at = now() where category = ${category} and active`;
}

/**
 * Genres already known per subject, as a provider key -> genre name[] map.
 *
 * Feeds the music adapter's incremental backfill. An entry with an EMPTY array is
 * meaningful and must be preserved: it means "asked, has none", which is what
 * stops the next pass spending its whole one-request-per-second budget re-asking
 * about the same untagged artists.
 */
export async function knownSubjectGenres(category) {
  const rows = await sql`
    select s.provider_key,
           coalesce(array_agg(g.name) filter (where g.id is not null), '{}') as names
    from subjects s
    left join subject_genres sg on sg.subject_id = s.id
    left join genres g on g.id = sg.genre_id
    where s.category = ${category}
    group by s.provider_key
  `;
  return new Map(rows.map((r) => [r.provider_key, r.names ?? []]));
}

/**
 * Events that have never had a detail lookup, soonest first.
 *
 * Soonest first because that is what a reader is most likely to open. The pass is
 * budgeted, so the order decides what gets enriched this hour and what waits.
 */
export async function eventsNeedingDetail({ provider, limit = 120 }) {
  return sql`
    select id, provider_key from events
    where provider = ${provider}
      and detail_synced_at is null
      /*
       * Recently out, not just still to come.
       *
       * A bare "starts_at > now()" looked obviously right and quietly excluded any
       * released today: a film stored at the noon anchor is in the past by the
       * afternoon, so its page could never be enriched no matter how many passes
       * ran. Every list on this site shows things from a few hours back, so the
       * enrichment window has to reach back at least as far as the pages do.
       */
      and starts_at > now() - interval '7 days'
    order by starts_at
    limit ${limit}
  `;
}

/**
 * Record what a detail lookup found.
 *
 * The stamp is set whether or not anything came back, so a title with genuinely
 * no cast is not re-fetched every hour forever. That is the whole reason the
 * column is a timestamp rather than a boolean on the data being present.
 */
export async function saveEventDetail(rows) {
  if (!rows?.length) return 0;
  let n = 0;
  for (const r of rows) {
    await sql`
      update events set
        runtime_min = coalesce(${r.runtimeMin ?? null}, runtime_min),
        tagline = coalesce(${r.tagline ?? null}, tagline),
        trailer_url = coalesce(${r.trailerUrl ?? null}, trailer_url),
        detail = coalesce(${r.detail ? JSON.stringify(r.detail) : null}::jsonb, detail),
        detail_synced_at = now()
      where id = ${r.eventId}
    `;
    n++;
  }
  return n;
}

/** Mark an attempt that returned nothing, so it is not retried forever. */
export async function markDetailAttempted(eventIds) {
  if (!eventIds?.length) return;
  await sql`
    update events set detail_synced_at = now()
    where id = any(${pgArray(eventIds)}::bigint[])
  `;
}

/*
 * How far the back-catalogue walk has got.
 *
 * Kept in a one-row table rather than derived from the data, because "how many
 * pages have I fetched" is not answerable from the rows: pages overlap as
 * popularity shifts, and counting films would drift further from the truth on
 * every pass.
 */
export async function backCataloguePagesDone() {
  const [row] = await sql`
    select coalesce(max(pages_done), 0)::int as n from catalogue_progress
    where provider = 'tmdb'
  `;
  return row?.n ?? 0;
}

export async function setBackCataloguePagesDone(pages) {
  await sql`
    insert into catalogue_progress (provider, pages_done, updated_at)
    values ('tmdb', ${pages}, now())
    on conflict (provider) do update set
      pages_done = greatest(catalogue_progress.pages_done, excluded.pages_done),
      updated_at = now()
  `;
}

/* --------------------------------------------------------- catalogue reads -- */

/** Categories that actually have something in them, with counts. */
export async function listCategories() {
  return sql`
    select g.category,
           count(distinct g.id)::int as genres,
           count(distinct e.id) filter (where e.starts_at > now())::int as upcoming
    from genres g
    left join event_genres eg on eg.genre_id = g.id
    left join events e on e.id = eg.event_id
    where g.active
    group by g.category
    order by upcoming desc, g.category
  `;
}

/**
 * Genres in a category, most active first.
 *
 * Ordered by how much is actually coming up rather than alphabetically: a genre
 * page with nothing in it is a dead end, and on a site whose whole navigation is
 * genres, putting the empty ones first is the difference between looking stocked
 * and looking broken.
 */
export async function listGenres({ category = null, limit = 500 } = {}) {
  return sql`
    select g.*, count(e.id) filter (where e.starts_at > now())::int as upcoming
    from genres g
    left join event_genres eg on eg.genre_id = g.id
    left join events e on e.id = eg.event_id
    where g.active
      and (${category}::text is null or g.category = ${category})
    group by g.id
    order by upcoming desc, g.priority, g.name
    limit ${limit}
  `;
}

export async function getGenreBySlug(slug) {
  const [row] = await sql`select * from genres where slug = ${slug} and active`;
  return row ?? null;
}

export async function getSubjectBySlug(slug) {
  const [row] = await sql`select * from subjects where slug = ${slug}`;
  return row ?? null;
}

/** The genres a subject belongs to, in the adapter's own order. */
export async function genresForSubject(subjectId) {
  return sql`
    select g.* from subject_genres sg
    join genres g on g.id = sg.genre_id
    where sg.subject_id = ${subjectId} and g.active
    order by sg.position, g.name
  `;
}

/**
 * Subjects filed under a genre, the ones with something coming first.
 *
 * viewerId, when given, marks which are already followed so the picker can render
 * the right button without a second round trip per row.
 */
export async function subjectsForGenre(genreId, { viewerId = null, limit = 200 } = {}) {
  return sql`
    select s.*,
           count(e.id) filter (where e.starts_at > now())::int as upcoming,
           (${viewerId}::uuid is not null and f.user_id is not null) as following
    from subject_genres sg
    join subjects s on s.id = sg.subject_id
    left join events e on e.subject_id = s.id
    left join follows f
      on f.subject_type = 'subject' and f.subject_id = s.id and f.user_id = ${viewerId}::uuid
    where sg.genre_id = ${genreId}
    group by s.id, f.user_id
    order by upcoming desc, s.display_name
    limit ${limit}
  `;
}

/** The columns every event list renders. Kept in one place so they cannot drift. */
const EVENT_COLUMNS = sql`
  e.id, e.category, e.kind, e.starts_at, e.time_known, e.precision, e.state,
  e.name, e.short_name, e.summary, e.image_url, e.backdrop_url, e.url,
  e.venue, e.venue_region, e.tagline, e.rating, e.rating_count, e.trailer_url,
  e.detail, e.season, e.number, e.runtime_min,
  s.slug as subject_slug, s.display_name as subject_name, s.kind as subject_kind,
  s.image_url as subject_image, s.backdrop_url as subject_backdrop,
  /*
   * The one genre a row is tagged with.
   *
   * A thing belongs to five genres at once -- that is the entire reason
   * event_genres is a join table -- but a row in a list has space for one word,
   * and "which of these is a horror film" is the first question a mixed list has
   * to answer. So: the highest-priority genre, deterministically, with the slug
   * beside it so the tag can be a link.
   *
   * Two correlated subqueries rather than a join, because a join here would
   * multiply every event row by its genre count and every caller would then need
   * a distinct. They are cheap: event_genres is keyed on (event_id, genre_id) and
   * these lists are hundreds of rows, not millions.
   */
  (select g.name from event_genres eg_t join genres g on g.id = eg_t.genre_id
    where eg_t.event_id = e.id and g.active
    order by g.priority, g.name limit 1) as genre_name,
  (select g.slug from event_genres eg_t join genres g on g.id = eg_t.genre_id
    where eg_t.event_id = e.id and g.active
    order by g.priority, g.name limit 1) as genre_slug
`;

export async function upcomingForGenre(genreId, { limit = 200, viewerId = null } = {}) {
  return sql`
    select ${EVENT_COLUMNS},
           (${viewerId}::uuid is not null and f.user_id is not null) as following
    from event_genres eg
    join events e on e.id = eg.event_id
    join subjects s on s.id = e.subject_id
    left join follows f
      on f.subject_type = 'subject' and f.subject_id = s.id and f.user_id = ${viewerId}::uuid
    where eg.genre_id = ${genreId} and e.starts_at > now() - interval '6 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

export async function upcomingForSubject(subjectId, { limit = 60, viewerId = null } = {}) {
  return sql`
    select ${EVENT_COLUMNS},
           (${viewerId}::uuid is not null and f.user_id is not null) as following
    from events e
    join subjects s on s.id = e.subject_id
    left join follows f
      on f.subject_type = 'subject' and f.subject_id = s.id and f.user_id = ${viewerId}::uuid
    where e.subject_id = ${subjectId} and e.starts_at > now() - interval '24 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/**
 * What this subject has already put out, newest first.
 *
 * The page had only the query above, which is right for a calendar and leaves a
 * back catalogue as a dead end: Top Gun: Maverick came out in 2022, so its page
 * was a title, a poster and "Nothing scheduled." Somebody who searched for a film
 * they wanted to watch reached a page with nothing on it and no event to open.
 *
 * Bounded tightly on purpose. A show with fourteen seasons has hundreds of these
 * and the page is not an archive -- it is "what is this, and can I watch it".
 */
export async function pastForSubject(subjectId, { limit = 12, viewerId = null } = {}) {
  return sql`
    select ${EVENT_COLUMNS},
           (${viewerId}::uuid is not null and f.user_id is not null) as following
    from events e
    join subjects s on s.id = e.subject_id
    left join follows f
      on f.subject_type = 'subject' and f.subject_id = s.id and f.user_id = ${viewerId}::uuid
    where e.subject_id = ${subjectId} and e.starts_at <= now() - interval '24 hours'
    order by e.starts_at desc
    limit ${limit}
  `;
}

/**
 * How many entries of each kind are on a reader's list.
 *
 * The question this answers is "does my provider actually carry films", and until
 * the kind column existed there was no way to ask it -- the URL that says so is
 * sealed. A reader whose list is seven thousand live channels and no VOD should
 * be told that plainly rather than concluding the matching is broken.
 */
export async function playlistKindCounts(userId) {
  return sql`
    select coalesce(c.kind, 'unknown') as kind, count(*)::int as count
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
    group by coalesce(c.kind, 'unknown')
    order by count desc
  `;
}

/**
 * One day's calendar, optionally within a category.
 *
 * The day is a UTC day. Rendering it in the reader's zone is a client-side job --
 * these pages are stored in Redis byte-identical for everyone, so nothing
 * timezone-dependent can be baked into the markup.
 */
export async function scheduleForDay({ day, category = null, limit = 300, viewerId = null }) {
  return sql`
    select ${EVENT_COLUMNS},
           (${viewerId}::uuid is not null and f.user_id is not null) as following
    from events e
    join subjects s on s.id = e.subject_id
    left join follows f
      on f.subject_type = 'subject' and f.subject_id = s.id and f.user_id = ${viewerId}::uuid
    where e.starts_at >= ${day}::date
      and e.starts_at < (${day}::date + interval '1 day')
      and (${category}::text is null or e.category = ${category})
    order by e.starts_at
    limit ${limit}
  `;
}

export async function getEvent(eventId) {
  const [row] = await sql`
    select ${EVENT_COLUMNS}, e.provider, e.subject_id, s.url as subject_url,
           s.description as subject_description,
           -- One genre name, for matching a reader's own 24/7 genre channels.
           -- The first alphabetically rather than "the" genre: there is no primary
           -- one, and picking arbitrarily but STABLY beats picking differently on
           -- every read.
           (select g.name from event_genres eg
              join genres g on g.id = eg.genre_id
             where eg.event_id = e.id
             order by g.name limit 1) as genre_name
    from events e
    join subjects s on s.id = e.subject_id
    where e.id = ${eventId}
  `;
  return row ?? null;
}

/** The genres an event inherited, for the chips on its page. */
export async function genresForEvent(eventId) {
  return sql`
    select g.* from event_genres eg
    join genres g on g.id = eg.genre_id
    where eg.event_id = ${eventId} and g.active
    order by g.name
  `;
}

/**
 * What is out in the next few hours.
 *
 * Ported from the sibling brand's category page, where the gap it fills is the
 * same: between "coming up" over a fortnight and a whole day's schedule there was
 * nothing, and about-to-drop is the most actionable state there is.
 *
 * `time_known` is not optional here and this site is why the column exists. TMDB
 * and MusicBrainz rows are ALWAYS date-only, padded to noon UTC -- so without this
 * filter every album with a month and every film with just a year would appear in
 * a list counting down to an hour nobody chose. On the sports side that filter is
 * a precaution; here it is the difference between a useful list and a wrong one.
 */
export async function outSoon({ hours = 4, limit = 30, viewerId = null } = {}) {
  return sql`
    select ${EVENT_COLUMNS},
           (${viewerId}::uuid is not null and f.user_id is not null) as following
    from events e
    join subjects s on s.id = e.subject_id
    left join follows f
      on f.subject_type = 'subject' and f.subject_id = s.id and f.user_id = ${viewerId}::uuid
    where e.state = 'upcoming'
      and e.time_known
      and e.starts_at > now()
      and e.starts_at <= now() + (${hours} * interval '1 hour')
    order by e.starts_at
    limit ${limit}
  `;
}

/** How many are due inside the window, whether or not they all fit in the list. */
export async function outSoonCount({ hours = 4 } = {}) {
  const [row] = await sql`
    select count(*)::int as n from events
    where state = 'upcoming'
      and time_known
      and starts_at > now()
      and starts_at <= now() + (${hours} * interval '1 hour')
  `;
  return row?.n ?? 0;
}

/**
 * Search the whole catalogue, past and future.
 *
 * Deliberately unbounded by date. Every other read on this site filters to what
 * has not happened yet, which is right for a calendar and wrong here -- the
 * question behind a search box is "do you have this", and a film from 1999 is a
 * perfectly good answer.
 *
 * Ranked by similarity first and popularity second. Similarity alone puts an
 * exact match on an obscure title above a near match on a famous one, which is
 * wrong for the way people type; popularity alone ignores what was asked. The
 * band is the compromise: close matches together, then the ones people mean.
 */
export async function searchCatalogue(term, { limit = 30, category = null } = {}) {
  const q = String(term ?? '')
    .trim()
    .toLowerCase();
  if (q.length < 2) return [];

  return sql`
    select s.id, s.slug, s.display_name, s.category, s.kind, s.image_url,
           s.backdrop_url, s.description, s.popularity,
           similarity(s.search_text, ${q}) as score,
           (select e.id from events e where e.subject_id = s.id
             order by e.starts_at desc limit 1) as event_id,
           (select e.starts_at from events e where e.subject_id = s.id
             order by e.starts_at desc limit 1) as starts_at,
           (select count(*) from events e
             where e.subject_id = s.id and e.starts_at > now())::int as upcoming
    from subjects s
    where (${category}::text is null or s.category = ${category})
      and (s.search_text % ${q} or s.search_text like ${`%${q}%`})
    order by
      /*
       * One score, not a lexicographic cascade.
       *
       * Ordering by similarity and only then by popularity sounds right and
       * ranks badly: searching "blair witch" put the 2016 remake first because
       * its title matches exactly, and buried The Blair Witch Project behind
       * The Blair Witch Rejects. An exact match on something nobody has heard of
       * is not a better answer than a near match on the film they meant.
       *
       * So similarity and fame are weighted against each other. Popularity is
       * logged because TMDB's figure spans four orders of magnitude and a linear
       * term would let one blockbuster outrank every genuine match.
       */
      ((similarity(s.search_text, ${q}) * 0.75)
        + (least(ln(greatest(coalesce(s.popularity, 0), 1)) / 7.0, 1.0) * 0.25)
        -- A title that STARTS with what was typed still gets a nudge; it is a
        -- strong signal, just not one that should beat everything else.
        + (case when s.search_text like ${`${q}%`} then 0.15 else 0 end)) desc,
      s.popularity desc nulls last
    limit ${limit}
  `;
}

/** Does this catalogue already hold that provider key? Used before ingesting a
 *  live search result, so a repeated search does not write the same row twice. */
export async function subjectsByProviderKeys(keys) {
  if (!keys?.length) return new Map();
  const rows = await sql`
    select provider_key, id, slug from subjects
    where provider_key = any(${pgArray(keys)}::text[])
  `;
  return new Map(rows.map((r) => [r.provider_key, r]));
}

/** Powers the follow picker's search box. */
export async function searchSubjects(term, limit = 25) {
  const like = `%${term}%`;
  return sql`
    select s.id, s.slug, s.display_name, s.category, s.kind, s.image_url
    from subjects s
    where s.display_name ilike ${like}
    order by similarity(s.display_name, ${term}) desc, s.display_name
    limit ${limit}
  `;
}

/**
 * Genres whose name looks like what was typed.
 *
 * No index and none wanted: there are a few dozen active genres, so a sequential
 * scan with a similarity call on each is cheaper than maintaining a trigram index
 * that would never be large enough to earn its write cost.
 */
export async function searchGenres(term, { limit = 8, category = null } = {}) {
  const q = String(term ?? '')
    .trim()
    .toLowerCase();
  if (q.length < 2) return [];

  return sql`
    select g.id, g.slug, g.name, g.category, g.image_url,
           (select count(*) from event_genres eg
              join events e on e.id = eg.event_id
             where eg.genre_id = g.id and e.starts_at > now())::int as upcoming
    from genres g
    where g.active
      and (${category}::text is null or g.category = ${category})
      and (lower(g.name) % ${q} or lower(g.name) like ${`%${q}%`})
    order by similarity(lower(g.name), ${q}) desc, g.priority, g.name
    limit ${limit}
  `;
}

/**
 * Dated things by their own name, rather than by the name of what they belong to.
 *
 * An episode is called "The Constant" and its show is called "Lost"; a release is
 * called "Deluxe Edition" and its artist is not. searchCatalogue can only ever
 * find the second of each pair, so a search box that stops there cannot find the
 * thing somebody actually remembers the name of.
 *
 * Ordered by nearness to now in either direction rather than by date: for a title
 * with two hundred episodes the interesting ones are the next and the last, and
 * neither end of a plain date sort gives you both.
 */
export async function searchEvents(term, { limit = 10, category = null } = {}) {
  const q = String(term ?? '')
    .trim()
    .toLowerCase();
  if (q.length < 2) return [];

  return sql`
    select e.id, e.name, e.short_name, e.starts_at, e.time_known, e.precision,
           e.state, e.category, e.kind, e.image_url, e.season, e.number,
           s.slug as subject_slug, s.display_name as subject_name
    from events e
    join subjects s on s.id = e.subject_id
    where (${category}::text is null or e.category = ${category})
      and lower(e.name) like ${`%${q}%`}
      -- The subject's own name is already the first section of the results page.
      -- Without this, searching "severance" returns the show and then fifty of its
      -- episodes, which pushes everything else off the screen.
      and lower(s.display_name) not like ${`%${q}%`}
    order by abs(extract(epoch from (e.starts_at - now()))), e.starts_at desc
    limit ${limit}
  `;
}

/**
 * A reader's own channel list.
 *
 * The one search that is not about our catalogue at all, and the reason the box
 * says "everything": somebody with a subscription is asking whether THEY have it,
 * and until now the only way to find out was to open a film we happened to hold
 * and read the panel at the bottom of its page.
 *
 * `normTerm` is pre-normalised by the caller rather than here. norm_title is
 * written by @genre/catalog's normaliseTitle at import, and the needle has to go
 * through the same function or the two disagree about punctuation -- but this
 * module cannot import that package, because that package imports this one.
 *
 * Scoped by user_id through the playlist join, like every other read of this
 * table: the URLs are credentials and they only ever travel back to the account
 * that supplied them. Stream URLs are deliberately NOT selected -- this is a
 * "you have this" answer, and the sealed URL belongs to the download route.
 */
export async function searchOwnChannels(userId, { normTerm, limit = 12 } = {}) {
  const needle = String(normTerm ?? '').trim();
  if (!userId || needle.length < 2) return [];

  return sql`
    select c.id, c.title, c.group_title, c.is_live, c.checked_at
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
      and (c.norm_title like ${`%${needle}%`} or lower(c.group_title) like ${`%${needle}%`})
    -- A slot known to be dead sinks; unchecked stays where it is, because
    -- unchecked is not the same as dead. Then the plainest title, which is the
    -- primary rather than a regional alternate or a replay with a date in it.
    order by (c.is_live is false), length(c.title), c.position
    limit ${limit}
  `;
}

/**
 * People, by handle or by the name they chose.
 *
 * Only public profiles and only accounts that picked a handle: a row with no
 * handle has no page to link to, and profile_public is an explicit opt-out that
 * has to be honoured everywhere something is listed.
 */
export async function searchProfiles(term, { limit = 6 } = {}) {
  const q = String(term ?? '').trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;

  return sql`
    select u.handle::text as handle, u.display_name
    from users u
    where u.handle is not null
      and u.profile_public
      and (u.handle::text ilike ${like} or u.display_name ilike ${like})
    order by (u.handle::text ilike ${q}) desc, u.handle::text
    limit ${limit}
  `;
}

export async function catalogueStats() {
  const [row] = await sql`
    select
      (select count(*)::int from genres where active) as genres,
      (select count(*)::int from subjects) as subjects,
      (select count(*)::int from events where starts_at > now()) as upcoming,
      (select count(distinct category)::int from genres where active) as categories,
      (select max(synced_at) from genres) as last_sync
  `;
  return row;
}

/* ----------------------------------------------------------------- follows -- */

export async function addFollow({ userId, subjectType, subjectId }) {
  await sql`
    insert into follows ${sql({
      user_id: userId,
      subject_type: subjectType,
      subject_id: subjectId,
    })}
    on conflict do nothing
  `;
}

export async function removeFollow({ userId, subjectType, subjectId }) {
  await sql`
    delete from follows
    where user_id = ${userId} and subject_type = ${subjectType} and subject_id = ${subjectId}
  `;
}

/**
 * Follow every active genre in one statement.
 *
 * insert-select rather than a loop: the cost of doing it a row at a time is one
 * round trip per genre for something a single statement expresses exactly.
 * `on conflict do nothing` makes it idempotent, so a second press adds whatever
 * genres have appeared since the first and nothing else.
 *
 * Returns how many were NEW, which is what the page reports back -- claiming the
 * full count when nothing changed would be a lie to anyone pressing it twice.
 */
export async function followAllGenres(userId) {
  const rows = await sql`
    insert into follows (user_id, subject_type, subject_id)
    select ${userId}, 'genre', g.id from genres g where g.active
    on conflict do nothing
    returning subject_id
  `;
  return rows.length;
}

/** The undo. Only genres: a name was followed one at a time and is left alone. */
export async function unfollowAllGenres(userId) {
  const rows = await sql`
    delete from follows where user_id = ${userId} and subject_type = 'genre'
    returning subject_id
  `;
  return rows.length;
}

/**
 * Clear the whole follow list -- names as well as genres.
 *
 * Deliberately NOT the same thing as unfollowAllGenres. That one is the undo for
 * the follow-everything button, and it spares the individual names because they
 * were chosen one at a time. This one backs "Unfollow all" on the calendar page,
 * where the list being cleared is the one in front of you: leaving the names
 * behind there would be the surprise, not the safeguard.
 *
 * Returns the counts by kind, because a bare total tells someone who is about to
 * wonder whether the names they picked survived exactly nothing.
 */
export async function unfollowAll(userId) {
  const rows = await sql`
    delete from follows where user_id = ${userId}
    returning subject_type
  `;
  return {
    removed: rows.length,
    genres: rows.filter((r) => r.subject_type === 'genre').length,
    subjects: rows.filter((r) => r.subject_type === 'subject').length,
  };
}

/** How many genres this reader follows, and how many there are. */
export async function genreFollowCounts(userId) {
  const [row] = await sql`
    select
      (select count(*)::int from genres where active) as total,
      (select count(*)::int from follows
        where user_id = ${userId}::uuid and subject_type = 'genre') as following
  `;
  return row;
}

/**
 * How much a "follow everything" actually signs someone up for.
 *
 * Shown before they press it, because the honest number is large: every upcoming
 * release in the catalogue, each of which sends a reminder at every offset they
 * have turned on. A button that quietly enrols someone in thousands of
 * notifications is not a feature.
 *
 * Bounded to a fortnight rather than counting the whole table -- a genre calendar
 * carries announced dates years out, and "42,000 coming up" would overstate what
 * lands in the next couple of weeks badly enough to be its own kind of lie.
 */
export async function upcomingEventCount() {
  const [row] = await sql`
    select count(*)::int as n from events
    where starts_at > now() and starts_at < now() + interval '14 days'
  `;
  return row.n;
}

export async function isFollowing({ userId, subjectType, subjectId }) {
  if (!userId) return false;
  const [row] = await sql`
    select 1 as x from follows
    where user_id = ${userId} and subject_type = ${subjectType} and subject_id = ${subjectId}
  `;
  return Boolean(row);
}

/**
 * Everything a reader follows, both tiers, as one list.
 *
 * A union rather than two queries because the settings page renders them in one
 * section and the difference between following a genre and following a name is a
 * label, not a different concept.
 */
export async function listFollows(userId) {
  return sql`
    select 'genre' as subject_type, g.id as subject_id, g.slug, g.name as label,
           g.category, null::text as image_url
    from follows f join genres g on g.id = f.subject_id
    where f.user_id = ${userId} and f.subject_type = 'genre' and g.active
    union all
    select 'subject', s.id, s.slug, s.display_name, s.category, s.image_url
    from follows f join subjects s on s.id = f.subject_id
    where f.user_id = ${userId} and f.subject_type = 'subject'
    order by label
  `;
}

/**
 * The same list, capped, for somebody else's public profile.
 *
 * Ported from tipoffwatch, where the same page had the same problem: "follow
 * everything" is one button, so an uncapped public list prints the whole
 * catalogue for anyone who presses it. There are 134 active genres, and the
 * profile rendered a chip for every one.
 *
 * Names sort ahead of genres. Follow-everything adds genres in bulk, so ordering
 * by label alone buried the handful of names somebody actually chose one at a time
 * underneath a hundred they took in a single click -- and the cap would then cut
 * exactly the ones worth showing.
 *
 * The caller reads the real total from followTotal and says how many are not
 * shown, so the cap never reads as the whole story.
 */
export async function publicFollows(userId, { limit = 60 } = {}) {
  return sql`
    select * from (
      select 'genre' as subject_type, g.id as subject_id, g.slug, g.name as label,
             g.category, null::text as image_url
      from follows f join genres g on g.id = f.subject_id
      where f.user_id = ${userId} and f.subject_type = 'genre' and g.active
      union all
      select 'subject', s.id, s.slug, s.display_name, s.category, s.image_url
      from follows f join subjects s on s.id = f.subject_id
      where f.user_id = ${userId} and f.subject_type = 'subject'
    ) rows
    order by (subject_type = 'subject') desc, label
    limit ${Math.min(Math.max(Number(limit) || 60, 1), 200)}
  `;
}

/**
 * How many things somebody follows, counted the same way the list selects them.
 *
 * Counted rather than taken from the list's length, because the list is capped
 * now. An inactive genre is excluded on both sides: it is filtered out of the
 * list, so counting it would put a number above a list that could never reach it.
 */
export async function followTotal(userId) {
  const [row] = await sql`
    select
      (select count(*)::int
         from follows f join genres g on g.id = f.subject_id
        where f.user_id = ${userId} and f.subject_type = 'genre' and g.active)
      +
      (select count(*)::int
         from follows f join subjects s on s.id = f.subject_id
        where f.user_id = ${userId} and f.subject_type = 'subject')
      as n
  `;
  return row.n;
}

/**
 * A reader's own calendar: everything upcoming from anything they follow.
 *
 * distinct on the event, because following both a genre and a name inside it is
 * normal and must not double up the row.
 */
export async function upcomingForUser(userId, { limit = 100 } = {}) {
  return sql`
    select distinct on (e.starts_at, e.id) ${EVENT_COLUMNS}
    from events e
    join subjects s on s.id = e.subject_id
    join follows f
      on (f.subject_type = 'subject' and f.subject_id = s.id)
      or (f.subject_type = 'genre'
          and f.subject_id in (select genre_id from event_genres where event_id = e.id))
    where f.user_id = ${userId} and e.starts_at > now() - interval '6 hours'
    order by e.starts_at, e.id
    limit ${limit}
  `;
}

/* --------------------------------------------------------------- reminders -- */

/**
 * Which offsets any reader has asked for, per reminder class.
 *
 * The scheduler registers one repeatable job per distinct offset, so this decides
 * how many exist. `timed` picks the column: an event with a real clock time uses
 * offsets_minutes (60, 1), and a date-only one uses date_offsets_minutes
 * (1440, 0). Mixing them would remind someone about an album at 23:00 the night
 * before, because midnight-minus-sixty happened to land there.
 */
export async function distinctReminderOffsets(defaults, { timed = true } = {}) {
  const rows = timed
    ? await sql`select distinct unnest(offsets_minutes) as m from reminder_prefs`
    : await sql`select distinct unnest(date_offsets_minutes) as m from reminder_prefs`;
  const set = new Set(defaults);
  for (const r of rows) if (Number.isFinite(r.m)) set.add(r.m);
  return [...set].sort((a, b) => b - a);
}

/**
 * Events whose reminder for this offset has just come due.
 *
 * The lookback window is what makes this safe to run on a coarse tick: a job that
 * fires every 30 seconds will still catch an event whose moment passed 25 seconds
 * ago, and the delivery table makes the overlap harmless.
 *
 * `timed` must match the offset's class. Querying both classes with one offset is
 * the bug this parameter exists to prevent -- it would fire the 1-minute reminder
 * for every date-only release at 11:59 UTC, an hour nobody chose.
 */
export async function eventsDueForReminder({ offsetMinutes, lookbackSeconds, timed = true }) {
  return sql`
    select e.id, e.starts_at, e.time_known, e.name, e.short_name, e.category,
           e.venue, e.url, s.display_name as subject_name
    from events e
    join subjects s on s.id = e.subject_id
    where e.state = 'upcoming'
      and e.time_known = ${timed}
      -- A month- or year-precision date is not a promise, so it never triggers a
      -- reminder. It is still browsable; it just cannot be alarmed on.
      and e.precision in ('second', 'minute', 'hour', 'day')
      and e.starts_at - (${offsetMinutes} * interval '1 minute') <= now()
      and e.starts_at - (${offsetMinutes} * interval '1 minute')
          > now() - (${lookbackSeconds} * interval '1 second')
    order by e.starts_at
  `;
}

/**
 * One page of the people to notify about one event, keyset-paginated by user id.
 *
 * Keyset rather than OFFSET on purpose: a popular premiere can have a very large
 * following, and OFFSET re-scans everything it skips, so page N gets linearly
 * slower. The `> after` form stays flat, and it cannot repeat or drop a row when
 * a follow is added mid-fan-out.
 */
export async function followersOfEventPage({
  eventId,
  after = '00000000-0000-0000-0000-000000000000',
  limit = 500,
}) {
  return sql`
    select distinct f.user_id
    from events e
    join follows f
      on (f.subject_type = 'subject' and f.subject_id = e.subject_id)
      or (f.subject_type = 'genre'
          and f.subject_id in (select genre_id from event_genres where event_id = e.id))
    where e.id = ${eventId} and f.user_id > ${after}::uuid
    order by f.user_id
    limit ${limit}
  `;
}

/** Delivery targets for a page of users: their channels and live push endpoints. */
export async function deliveryTargets(userIds) {
  if (userIds.length === 0) return [];
  return sql`
    select u.id as user_id, u.email::text as email, u.timezone,
           coalesce(p.channels, '{webpush,email}') as channels,
           coalesce(p.offsets_minutes, '{60,1}') as offsets_minutes,
           coalesce(p.date_offsets_minutes, '{1440,0}') as date_offsets_minutes,
           coalesce(
             json_agg(json_build_object(
               'endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth))
               filter (where ps.id is not null and ps.disabled_at is null),
             '[]'
           ) as push_subscriptions
    from users u
    left join reminder_prefs p on p.user_id = u.id
    left join push_subscriptions ps on ps.user_id = u.id and ps.disabled_at is null
    where u.id = any(${pgArray(userIds)}::uuid[])
    group by u.id, p.channels, p.offsets_minutes, p.date_offsets_minutes
  `;
}

/**
 * Claim the right to send, before sending.
 *
 * The database is the arbiter: whichever worker inserts the row first owns that
 * delivery, and a concurrent or duplicated job gets an empty set back and sends
 * nothing. Claiming after the send instead would make every retry a second
 * notification to a real person's phone.
 *
 * The one exception is a delivery that already failed. Without it the claim row
 * from a failed send blocks every retry, so the queue's five attempts would
 * re-claim nothing and the reminder would be lost on the first transient push
 * error -- retries that exist but cannot do anything. A row already marked `sent`
 * is never re-claimed, so this can resurrect a failure without duplicating a
 * success.
 */
export async function claimDeliveries(rows) {
  if (rows.length === 0) return [];
  return sql`
    insert into reminder_deliveries ${sql(rows)}
    on conflict (event_id, user_id, offset_minutes, channel) do update
      set status = 'sent', sent_at = now()
      where reminder_deliveries.status = 'failed'
    returning event_id, user_id, offset_minutes, channel
  `;
}

export async function markDeliveryFailed({ eventId, userId, offsetMinutes, channel }) {
  await sql`
    update reminder_deliveries set status = 'failed'
    where event_id = ${eventId} and user_id = ${userId}
      and offset_minutes = ${offsetMinutes} and channel = ${channel}
  `;
}

/* -------------------------------------------------------------- push subs --- */

export async function savePushSubscription({ userId, endpoint, p256dh, auth }) {
  await sql`
    insert into push_subscriptions ${sql({ user_id: userId, endpoint, p256dh, auth })}
    on conflict (endpoint) do update set
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      -- A resubscribe from a browser we had marked dead is a repair, not a new
      -- device, so the row comes back to life rather than accumulating.
      disabled_at = null,
      last_ok_at = now()
  `;
}

export async function disablePushSubscription(endpoint) {
  await sql`update push_subscriptions set disabled_at = now() where endpoint = ${endpoint}`;
}

export async function deletePushSubscription({ userId, endpoint }) {
  await sql`
    delete from push_subscriptions where user_id = ${userId} and endpoint = ${endpoint}
  `;
}

/* ------------------------------------------------------------------ prefs -- */

export async function getPrefs(userId) {
  const [row] = await sql`select * from reminder_prefs where user_id = ${userId}`;
  return row ?? null;
}

export async function savePrefs({ userId, offsetsMinutes, dateOffsetsMinutes, channels }) {
  await sql`
    insert into reminder_prefs
      (user_id, offsets_minutes, date_offsets_minutes, channels, updated_at)
    values (
      ${userId},
      ${pgArray(offsetsMinutes)}::int[],
      ${pgArray(dateOffsetsMinutes)}::int[],
      ${pgArray(channels)}::text[],
      now()
    )
    on conflict (user_id) do update set
      offsets_minutes = excluded.offsets_minutes,
      date_offsets_minutes = excluded.date_offsets_minutes,
      channels = excluded.channels,
      updated_at = now()
  `;
}

/* --------------------------------------------------------------- calendar -- */

export async function userByCalendarToken(token) {
  const [row] = await sql`
    select u.*, u.email::text as email, u.handle::text as handle
    from users u where u.calendar_token = ${token}::uuid
  `;
  return row ?? null;
}

export async function rotateCalendarToken(userId) {
  const [row] = await sql`
    update users set calendar_token = gen_random_uuid() where id = ${userId}
    returning calendar_token
  `;
  return row?.calendar_token ?? null;
}

/* ------------------------------------------------------------------ feeds -- */

/**
 * Events for a feed, scoped to a genre, a subject, a category or a reader.
 *
 * One query with optional filters rather than four queries, because RSS, ICS and
 * the JSON API all want exactly the same rows differently formatted, and the last
 * time these diverged the calendar feed and the web page disagreed about what was
 * upcoming.
 */
export async function feedEvents({
  genreId = null,
  subjectId = null,
  category = null,
  userId = null,
  from = null,
  limit = 200,
} = {}) {
  return sql`
    select distinct on (e.starts_at, e.id) ${EVENT_COLUMNS}, e.updated_at
    from events e
    join subjects s on s.id = e.subject_id
    left join event_genres eg on eg.event_id = e.id
    left join follows f on f.user_id = ${userId}::uuid
      and ((f.subject_type = 'subject' and f.subject_id = s.id)
        or (f.subject_type = 'genre' and f.subject_id = eg.genre_id))
    where e.starts_at > coalesce(${from}::timestamptz, now() - interval '24 hours')
      and (${genreId}::bigint is null or eg.genre_id = ${genreId})
      and (${subjectId}::bigint is null or e.subject_id = ${subjectId})
      and (${category}::text is null or e.category = ${category})
      and (${userId}::uuid is null or f.user_id is not null)
    order by e.starts_at, e.id
    limit ${limit}
  `;
}

/** Genres worth a sitemap entry: the ones with something to show. */
export async function genresWithUpcoming(limit = 1000) {
  return sql`
    select g.slug, g.category, max(e.updated_at) as updated_at, count(e.id)::int as n
    from genres g
    join event_genres eg on eg.genre_id = g.id
    join events e on e.id = eg.event_id
    where g.active and e.starts_at > now()
    group by g.slug, g.category
    order by n desc
    limit ${limit}
  `;
}

export async function subjectsWithUpcoming(limit = 5000) {
  return sql`
    select s.slug, max(e.updated_at) as updated_at, count(e.id)::int as n
    from subjects s
    join events e on e.subject_id = s.id
    where e.starts_at > now()
    group by s.slug
    order by n desc
    limit ${limit}
  `;
}

/** Months that have any event, for the sitemap index. */
export async function eventMonths() {
  return sql`
    select to_char(date_trunc('month', starts_at), 'YYYY-MM') as month,
           count(*)::int as n, max(updated_at) as updated_at
    from events
    group by 1 order by 1 desc
  `;
}

export async function eventsForMonth(month, { limit = 45000, offset = 0 } = {}) {
  return sql`
    select id, updated_at from events
    where date_trunc('month', starts_at) = to_date(${month}, 'YYYY-MM')
    order by starts_at
    limit ${limit} offset ${offset}
  `;
}

/** The public JSON API's event list. */
export async function publicEvents({
  genreSlug = null,
  category = null,
  from = null,
  limit = 100,
}) {
  return sql`
    select distinct on (e.starts_at, e.id)
           e.id, e.category, e.kind, e.starts_at, e.time_known, e.precision,
           e.name, e.venue, e.venue_region, e.url,
           s.slug as subject_slug, s.display_name as subject_name
    from events e
    join subjects s on s.id = e.subject_id
    left join event_genres eg on eg.event_id = e.id
    left join genres g on g.id = eg.genre_id
    where e.starts_at > coalesce(${from}::timestamptz, now())
      and (${genreSlug}::text is null or g.slug = ${genreSlug})
      and (${category}::text is null or e.category = ${category})
    order by e.starts_at, e.id
    limit ${limit}
  `;
}

/* --------------------------------------------------------------- comments -- */

export async function commentsForEvent(eventId, { limit = 200 } = {}) {
  return sql`
    select c.id, c.body, c.created_at, c.user_id,
           u.email::text as email, u.handle::text as handle, u.display_name, u.profile_public
    from comments c join users u on u.id = c.user_id
    where c.event_id = ${eventId} and c.deleted_at is null
    order by c.created_at
    limit ${limit}
  `;
}

/** Rate limit input, counted in the database so it survives a restart. */
export async function recentCommentCount(userId, seconds = 60) {
  const [row] = await sql`
    select count(*)::int as n from comments
    where user_id = ${userId} and created_at > now() - (${seconds} * interval '1 second')
  `;
  return row.n;
}

export async function insertComment({ eventId, userId, body }) {
  const [row] = await sql`
    insert into comments ${sql({ event_id: eventId, user_id: userId, body })}
    returning id, body, created_at
  `;
  return row;
}

/** Soft delete, and only your own: the where clause is the authorisation. */
export async function deleteComment({ commentId, userId }) {
  const [row] = await sql`
    update comments set deleted_at = now()
    where id = ${commentId} and user_id = ${userId} and deleted_at is null
    returning event_id
  `;
  return row ?? null;
}

/* -------------------------------------------------------------- playlists -- */

export async function savePlaylist({ userId, label, sourceUrl }) {
  await sql`
    insert into user_playlists ${sql({ user_id: userId, label, source_url: sourceUrl })}
    on conflict (user_id) do update set
      label = excluded.label,
      source_url = excluded.source_url,
      last_error = null
  `;
}

export async function getPlaylist(userId) {
  const [row] = await sql`select * from user_playlists where user_id = ${userId}`;
  return row ?? null;
}

export async function deletePlaylist(userId) {
  await sql`delete from user_playlists where user_id = ${userId}`;
}

/* ------------------------------------------------------- the IMDb backfill -- */

/**
 * Where the last IMDb pass got to.
 *
 * One row, enforced by a check constraint rather than by everyone remembering to
 * pass the same id. A missing row means it has never run.
 */
export async function imdbProgress() {
  const [row] = await sql`select * from imdb_progress where id = 1`;
  return row ?? null;
}

/** Stamp the start, creating the row on the first ever pass. */
export async function startImdbPass() {
  await sql`
    insert into imdb_progress (id, started_at) values (1, now())
    on conflict (id) do update set started_at = now()
  `;
}

/**
 * Record what a pass did, and where to resume.
 *
 * `cursor` is null when the pass reached the end of the file, which is what makes
 * the next one start from the top. A non-null cursor with no completed_at is the
 * normal state for the first few days: eleven and a half million rows do not fit
 * in one wall-clock budget.
 *
 * The counters are per-pass rather than cumulative, because the question a human
 * asks of this row is "what happened last night", and a running total answers a
 * different one badly.
 */
export async function finishImdbPass({ cursor, completed, seen, linked, created, note }) {
  await sql`
    update imdb_progress set
      cursor = ${cursor ?? null},
      completed_at = case when ${Boolean(completed)} then now() else completed_at end,
      seen = ${seen ?? 0},
      linked = ${linked ?? 0},
      created = ${created ?? 0},
      note = ${note ?? null}
    where id = 1
  `;
}

/**
 * Subjects that have never been through the title normaliser.
 *
 * Only ever the rows that predate the column: every upsert writes one from here
 * on. Ordered by id so repeated calls walk forward rather than re-reading the same
 * page when two run concurrently.
 */
export async function subjectsMissingNormTitle({ limit = 2000 } = {}) {
  return sql`
    select id, name, display_name from subjects
    where norm_title is null
    order by id
    limit ${limit}
  `;
}

/**
 * Write back what the normaliser produced.
 *
 * `''` is a legitimate answer and MUST be stored.
 *
 * normaliseTitle keeps `[a-z0-9]` and folds accents, so any title with no Latin
 * characters at all reduces to an empty string -- and this site carries anime, so
 * "君の名は。" and every other AniList title does exactly that. Filtering those out
 * as falsy left their norm_title NULL, which put them straight back in the next
 * batch of subjectsMissingNormTitle: an infinite loop that logged thirteen million
 * "normalised" rows against a table of five thousand and never let the IMDb pass
 * start. Empty is the correct value -- it matches no IMDb candidate, which is the
 * right outcome for a title written in another script -- and, crucially, it is not
 * null, so the row leaves the queue.
 */
export async function setSubjectNormTitles(rows) {
  const usable = (rows ?? []).filter((r) => r.id != null && r.normTitle != null);
  if (usable.length === 0) return 0;

  /*
   * unnest over two parallel arrays, not a VALUES list.
   *
   * A JS array handed to Bun's parameter serialiser arrives as `a,b` and is
   * rejected as a malformed array literal -- the trap pgArray exists for, and the
   * one that silently broke passkey registration and the reminder fan-out before
   * it was found. Building the literals here is the pattern the rest of this file
   * already uses, and it does not depend on how the driver encodes anything.
   */
  for (let i = 0; i < usable.length; i += 500) {
    const chunk = usable.slice(i, i + 500);
    await sql`
      update subjects s set norm_title = v.norm_title
      from (
        select unnest(${pgArray(chunk.map((r) => Number(r.id)))}::bigint[]) as id,
               unnest(${pgArray(chunk.map((r) => String(r.normTitle)))}::text[]) as norm_title
      ) v
      where s.id = v.id
    `;
  }
  return usable.length;
}

/**
 * Which of these titles do we already hold?
 *
 * Keyed on (category, normalised title, year) -- the same key the importer builds
 * -- and answered for a whole batch in one statement, because the alternative is a
 * query per candidate and there are a million candidates.
 *
 * A row whose year we do not know is matched on title alone within its category.
 * That is looser than it sounds in practice: our own rows almost always have a
 * year, so this only fires for the handful IMDb gives no start year for.
 */
export async function subjectsByNormTitle(keys) {
  const usable = (keys ?? []).filter((k) => k.normTitle);
  if (usable.length === 0) return new Map();

  const norms = [...new Set(usable.map((k) => k.normTitle))];
  const rows = await sql`
    select id, category, norm_title, year from subjects
    where norm_title = any(${pgArray(norms)}::text[])
  `;

  const out = new Map();
  for (const r of rows) {
    // Last write wins, and the ordering is arbitrary -- two of our own rows with
    // the same title, year and category are already a duplicate, and picking
    // either of them is better than creating a third.
    out.set(`${r.category} ${r.norm_title} ${r.year ?? ''}`, r.id);
  }
  return out;
}

/**
 * Attach an IMDb id, and whatever it knows, to a row we already had.
 *
 * Everything except the id is coalesced: TMDB's own artwork, description and
 * popularity are better than IMDb's absence of them, and a linking pass must never
 * make an existing page worse. The id itself is assigned, because that is the
 * whole point of the pass and re-running it has to be idempotent.
 *
 * `where s.imdb_id is null or s.imdb_id = excluded` is not expressible in this
 * shape, so the guard is on the unique index instead: a second tconst claiming a
 * subject that already has a different one silently loses rather than raising,
 * which is the right outcome for a heuristic match.
 */
export async function linkImdbToSubjects(rows) {
  const usable = (rows ?? []).filter((r) => r.subjectId && r.tconst);
  if (usable.length === 0) return 0;

  for (let i = 0; i < usable.length; i += 500) {
    const chunk = usable.slice(i, i + 500);
    /*
     * unnest over parallel arrays, for the reason above: a VALUES list built from
     * JS arrays is exactly the shape Bun's serialiser mangles. Nulls travel as
     * real SQL NULLs because pgArray writes them unquoted, so the coalesces below
     * mean what they say rather than comparing against the string "null".
     */
    await sql`
      update subjects s set
        -- Assigned only when there is nothing there. An established id wins over a
        -- heuristic match, which is what this pass produces.
        imdb_id = coalesce(s.imdb_id, v.imdb_id),
        year = coalesce(s.year, v.year),
        rating = coalesce(s.rating, v.rating),
        rating_count = coalesce(s.rating_count, v.rating_count),
        -- IMDb's vote count as a stand-in for fame, but never over a figure another
        -- provider already gave us: a linking pass must not make a page worse.
        popularity = coalesce(s.popularity, v.rating_count::numeric)
      from (
        select unnest(${pgArray(chunk.map((r) => Number(r.subjectId)))}::bigint[]) as id,
               unnest(${pgArray(chunk.map((r) => String(r.tconst)))}::text[]) as imdb_id,
               unnest(${pgArray(chunk.map((r) => r.year ?? null))}::int[]) as year,
               unnest(${pgArray(chunk.map((r) => r.rating ?? null))}::numeric[]) as rating,
               unnest(${pgArray(chunk.map((r) => r.ratingCount ?? null))}::int[]) as rating_count
      ) v
      where s.id = v.id
        -- Another subject already claims this tconst. Leaving it alone is right:
        -- the unique index would reject the write anyway, and a heuristic match
        -- losing to an established one is the outcome we want.
        and not exists (select 1 from subjects o where o.imdb_id = v.imdb_id and o.id <> s.id)
    `;
  }
  return usable.length;
}

/* ----------------------------------------------------- sharing a playlist -- */
/**
 * Record a probe verdict on a SHARED entry.
 *
 * Deliberately not scoped by a viewer, and that is the difference from
 * markChannelChecked. Whether a slot is streaming is a fact about the owner's
 * line, not about who asked -- so a check run by any reader benefits everyone,
 * including the owner. `p.shared` is what makes the write legitimate: a row stops
 * being writable this way the moment its owner closes the list.
 */
export async function markSharedChannelChecked({ channelId, live, note }) {
  await sql`
    update user_playlist_channels c set
      is_live = ${live === null ? null : Boolean(live)},
      checked_at = now(),
      check_note = ${note ? String(note).slice(0, 200) : null}
    from user_playlists p
    where c.id = ${channelId} and p.id = c.playlist_id and p.shared
  `;
}

/**
 * Open one account's list to everybody signed in, or close it again.
 *
 * Owner-only by construction: the update is keyed on user_id, so there is no id a
 * caller could pass to open somebody else's list.
 *
 * `shared_at` is stamped on the transition rather than on every save, so a page
 * can say how long a list has been open rather than only that it is. Turning it
 * off leaves the timestamp alone -- it is a record of when this started, and a
 * flag that is currently false makes the distinction unambiguous.
 */
export async function setPlaylistShared({ userId, shared, label = null }) {
  const [row] = await sql`
    update user_playlists set
      shared = ${Boolean(shared)},
      shared_at = case
        when ${Boolean(shared)} and not shared then now()
        else shared_at
      end,
      -- Null clears it, which is the difference between "no label" and "do not
      -- change the label". The caller decides by passing one or not.
      shared_label = ${label === null ? null : String(label).slice(0, 80)}
    where user_id = ${userId}
    returning shared, shared_at, shared_label
  `;
  return row ?? null;
}

/**
 * How much has been opened to this reader at all, matched or not.
 *
 * This and the candidate query below are the only two reads in this file that
 * deliberately cross accounts. Everything else about this table is scoped through
 * the playlist join to the account that supplied it; these read other people's
 * rows, so the predicate that makes them legitimate -- `p.shared` -- is the first
 * thing in the where clause rather than buried in it.
 *
 * Note what is NOT in that clause: a follow. Sharing is a property of the list,
 * not of a relationship, and following somebody who has not opened theirs shows
 * nothing -- correctly. Adding a follow here would quietly widen who can reach
 * another person's provider line.
 *
 * The reader's own list is excluded -- it is already the first section on the
 * page, and a channel appearing in both reads as a duplicate rather than as two
 * facts.
 *
 * The count is separate from the rows because it is owed to the page even when
 * nothing matched: "none of the 41,000 channels shared with you name this" is an
 * answer, and silence is indistinguishable from the feature being broken.
 */
export async function sharedChannelCount({ viewerId = null } = {}) {
  const [row] = await sql`
    select count(*)::int as n
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.shared
      and (${viewerId}::uuid is null or p.user_id <> ${viewerId})
  `;
  return row?.n ?? 0;
}

/**
 * The shared rows that could plausibly carry a title, narrowed in the database.
 *
 * This replaced a `order by c.position limit 20000`, which took the first twenty
 * thousand rows of the shared set and ranked those. A reader's OWN list was
 * already narrowed by term across the whole thing (playlistCandidates), so on a
 * 300,000-entry VOD catalogue the two paths disagreed: the owner saw a film and
 * everybody they had shared with saw nothing, because the row carrying it sat
 * past the ceiling. From the outside that is indistinguishable from sharing
 * being broken, which is how it was reported.
 *
 * What comes back carries the OWNER's id, and that is load-bearing rather than
 * informational: the connection ceiling is a property of the owner's line, not of
 * whoever is watching, so every caller counts slots against `owner_id`. Counting
 * against the viewer would let twenty readers open twenty connections on one
 * subscription, which is how that subscription gets terminated.
 *
 * `c.kind` is selected here for the same reason it is in playlistCandidates: the
 * stream URL is sealed, so a caller cannot work out whether a row is a file or a
 * channel by looking at it. Without the column every shared entry ranked as live
 * and no follower could ever be offered a film on demand.
 */
export async function sharedPlaylistCandidates({ viewerId = null, terms = [], limit = 3000 } = {}) {
  const usable = (terms ?? []).filter((t) => t && t.length >= 2);
  if (usable.length === 0) return [];

  return sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url, c.norm_title,
           c.is_live, c.checked_at,
           p.user_id as owner_id,
           coalesce(p.shared_label, u.display_name, '@' || u.handle::text, 'someone') as owner_label
    from user_playlists p
    join users u on u.id = p.user_id
    join user_playlist_channels c on c.playlist_id = p.id
    where p.shared
      and (${viewerId}::uuid is null or p.user_id <> ${viewerId})
      -- Same freshness rule as a reader's own list: a "dead" verdict is respected
      -- only while it is recent, and NULL is never filtered out because unchecked
      -- is not the same as dead.
      and (c.is_live is not false or c.checked_at < now() - interval '30 minutes')
      and c.norm_title like any(${pgArray(usable.map((t) => `%${t}%`))}::text[])
    order by c.position
    limit ${limit}
  `;
}

/** Whose lists are open, for the page that says so. Never includes a URL. */
export async function sharedPlaylistOwners() {
  return sql`
    select p.user_id as owner_id,
           u.handle::text as handle,
           coalesce(p.shared_label, u.display_name, '@' || u.handle::text, 'someone') as label,
           p.channel_count, p.shared_at, p.last_synced_at
    from user_playlists p
    join users u on u.id = p.user_id
    where p.shared
    order by p.channel_count desc nulls last, p.shared_at
  `;
}

/**
 * One shared channel by its own id, with the owner beside it.
 *
 * Used by the routes that play a shared entry. Keyed by the channel id alone --
 * there is no viewer to scope by, which is the whole point of the feature -- so
 * `p.shared` is what authorises the read and it is checked here rather than by
 * the caller remembering to.
 */
export async function sharedChannelById(channelId) {
  const [row] = await sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url,
           p.user_id as owner_id,
           coalesce(p.shared_label, u.display_name, '@' || u.handle::text, 'someone') as owner_label
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    join users u on u.id = p.user_id
    where c.id = ${channelId} and p.shared
  `;
  return row ?? null;
}

/**
 * Record a failure, and back off before trying again.
 *
 * Exponential to a ceiling of an hour. There is nothing to gain from pulling 800KB
 * every five minutes from something answering 404, and hammering a dead line is how
 * the subscription behind it gets noticed. The streak is capped so it cannot
 * overflow the exponent on a provider that has been down for a week.
 */
export async function markPlaylistError({ userId, error }) {
  await sql`
    update user_playlists set
      last_error = ${String(error).slice(0, 300)},
      last_synced_at = now(),
      error_streak = least(error_streak + 1, 8),
      refresh_after = now() + (least(power(2, least(error_streak + 1, 6))::int, 60) || ' minutes')::interval
    where user_id = ${userId}
  `;
}

/** A successful poll: clear the error state and book the next one. */
export async function markPlaylistFresh({ userId, contentHash, nextAt }) {
  await sql`
    update user_playlists set
      last_synced_at = now(),
      last_error = null,
      error_streak = 0,
      content_hash = ${contentHash},
      refresh_after = ${nextAt}
    where user_id = ${userId}
  `;
}

/**
 * Which lists may be fetched now.
 *
 * `refresh_after is null` is the never-polled case and sorts first, so a list added
 * a minute ago is picked up on the next tick rather than waiting out an interval it
 * was never scheduled into.
 */
export async function playlistsDueForRefresh({ limit = 25 } = {}) {
  return sql`
    select user_id, source_url, label, content_hash
    from user_playlists
    where refresh_after is null or refresh_after <= now()
    order by refresh_after nulls first, last_synced_at nulls first
    limit ${Math.min(Math.max(Number(limit) || 25, 1), 200)}
  `;
}

/** For the idle log line: when the poller expects to have something to do. */
export async function nextPlaylistRefreshAt() {
  return sql`
    select min(coalesce(refresh_after, now())) as next_at,
           count(*)::int as lists
    from user_playlists
  `;
}

/**
 * Swap a reader's channels for a freshly imported set.
 *
 * Delete-then-insert inside one transaction: a provider list is replaced whole,
 * never merged, so a channel that has gone away actually goes away. Doing it
 * outside a transaction would leave the account with no channels at all if the
 * insert failed halfway.
 */
export async function replacePlaylistChannels({ userId, channels }) {
  const [pl] = await sql`select id from user_playlists where user_id = ${userId}`;
  if (!pl) throw new Error('no playlist for user');

  await sql.begin(async (tx) => {
    await tx`delete from user_playlist_channels where playlist_id = ${pl.id}`;
    for (let i = 0; i < channels.length; i += 500) {
      const rows = channels.slice(i, i + 500).map((c, j) => ({
        playlist_id: pl.id,
        position: i + j,
        title: c.title,
        group_title: c.group ?? null,
        kind: c.kind ?? null,
        stream_url: c.streamUrl,
        norm_title: c.normTitle,
      }));
      await tx`insert into user_playlist_channels ${tx(rows)}`;
    }
    await tx`
      update user_playlists
      set channel_count = ${channels.length}, last_synced_at = now(), last_error = null
      where id = ${pl.id}
    `;
  });
}

export async function playlistChannels(userId, { limit = 20000 } = {}) {
  return sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url, c.norm_title,
           c.is_live, c.checked_at
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
      -- A verdict of "dead" is respected only while it is fresh. Providers rewrite
      -- their event slots around airtime, so a slot that was empty an hour ago is
      -- exactly the one that fills when the thing starts. NULL is never filtered
      -- out: unchecked is not the same as dead, and thousands of channels cannot
      -- all be probed on import.
      and (c.is_live is not false or c.checked_at < now() - interval '30 minutes')
    order by c.position
    limit ${limit}
  `;
}

/**
 * Do this reader's stored rows predate a column a fresh parse would fill?
 *
 * The refresh short-circuits on an unchanged content hash, which is right --
 * re-writing several thousand identical rows every five minutes is pure churn, and
 * most polls DO see a byte-identical file. What it also does is freeze the schema
 * those rows were imported under: `kind` arrived in 0013 and, for anybody whose
 * provider had not touched their playlist since, never got written at all. Their
 * films therefore kept falling back to the sealed-url guess and landing in the
 * generic tier instead of "Available on demand" -- which is exactly the bug 0013
 * was supposed to fix, surviving in the data.
 *
 * So the hash is only allowed to skip a rewrite when the rows are current. A
 * future column added to this table gets its own clause here, and the same
 * self-healing on the next poll.
 */
export async function playlistNeedsReparse(userId) {
  const [row] = await sql`
    select exists (
      select 1
      from user_playlist_channels c
      join user_playlists p on p.id = c.playlist_id
      where p.user_id = ${userId} and c.kind is null
    ) as stale
  `;
  return Boolean(row?.stale);
}

/**
 * One of the reader's own entries, by id.
 *
 * Scoped through the playlist join like every other read of this table, so an id
 * from anywhere else returns nothing rather than somebody else's row.
 *
 * Exists because the ranked lists are addressed by (tier, INDEX), and an index
 * only means something inside one ranked list on one page. A subject page ranks
 * the same entries against the same title and has no event to hang an index off,
 * so it needs a stable handle -- and the row id is the only one there is.
 */
export async function ownChannelById(userId, channelId) {
  const [row] = await sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url, c.is_live, c.checked_at
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId} and c.id = ${channelId}
  `;
  return row ?? null;
}

/**
 * How many entries this reader has, without fetching any of them.
 *
 * Carried back to the page even when nothing matched -- "none of your 7,059
 * channels carry this" is an answer where silence is not -- and it used to
 * come free from having loaded the list. It does not any more, so it is its own
 * cheap count.
 */
export async function playlistChannelCount(userId) {
  const [row] = await sql`
    select count(*)::int as n
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
  `;
  return row?.n ?? 0;
}

/**
 * The entries worth ranking against one title.
 *
 * The read used to be "give me every row" and the ranking happened entirely in
 * JavaScript. That was free at seven thousand entries and is not at three hundred
 * thousand: a provider that exposes its VOD catalogue ships one, and normalising
 * every title on every page view is a third of a second of CPU to find four rows.
 *
 * So the obviously-irrelevant rows are dropped in the database first. `norm_title`
 * is written at import by the same normaliser the ranker uses, and carries a
 * trigram index, so a substring test on it is the cheapest question available. The
 * survivors are ranked in JS exactly as before -- this narrows the input, it does
 * not decide anything.
 *
 * The terms come from matchTerms, so the query asks for precisely the words the
 * ranker would have matched on. A word it would match but this never asked for is
 * a channel the reader is silently not offered, which is why they share one
 * function rather than two lists that look alike.
 */
export async function playlistCandidates(userId, { terms = [], limit = 3000 } = {}) {
  const usable = (terms ?? []).filter((t) => t && t.length >= 2);
  if (!userId || usable.length === 0) return [];

  return sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url, c.norm_title,
           c.is_live, c.checked_at
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
      /*
       * No liveness filter here, deliberately, and it is the opposite of what
       * this used to do.
       *
       * A recent "dead" verdict used to remove the row for thirty minutes. On a
       * title the provider consistently fails that produced a flicker: the entry
       * appeared, was probed, 404'd, vanished for half an hour, came back, and
       * vanished again -- so "Top Gun: Maverick is not on this page" was true or
       * false depending on when you looked, and the page never said why.
       *
       * The verdict still travels, on is_live and checked_at, and the caller
       * files a failing entry under "unavailable" instead of offering it. Hiding
       * was the wrong lever: the reader wants to know their list HAS the film and
       * that the provider will not serve it.
       *
       * No backticks in this comment, and that is not style: it sits INSIDE a
       * tagged template literal, so one would end the query mid-sentence.
       */
      and c.norm_title like any(${pgArray(usable.map((t) => `%${t}%`))}::text[])
    order by c.position
    limit ${limit}
  `;
}

/**
 * Record what a probe saw.
 *
 * Scoped by user as well as by channel id, so an id from anywhere else cannot write
 * a verdict into somebody else's list.
 */
export async function markChannelChecked({ userId, channelId, live, note }) {
  await sql`
    update user_playlist_channels c set
      is_live = ${live},
      checked_at = now(),
      check_note = ${String(note ?? '').slice(0, 200)}
    from user_playlists p
    where c.playlist_id = p.id
      and p.user_id = ${userId}
      and c.id = ${channelId}
  `;
}

/**
 * The reader's own genre index, built from their playlist's group titles.
 *
 * Counted in SQL rather than by pulling 7,000 rows and grouping in the app, which
 * is what the sports version had to do because it had no group column to group by.
 */
export async function playlistGroups(userId, { limit = 300 } = {}) {
  return sql`
    select c.group_title as name, count(*)::int as count
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId} and c.group_title is not null and c.group_title <> ''
    group by c.group_title
    order by count desc, name
    limit ${limit}
  `;
}
