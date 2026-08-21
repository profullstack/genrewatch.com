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
    returning *, email::text as email
  `;
  return row;
}

export async function insertLoginToken({ tokenHash, email, expiresAt }) {
  await sql`
    insert into login_tokens ${sql({ token_hash: tokenHash, email, expires_at: expiresAt })}
  `;
}

/** Single-use by construction: the update is the consumption. */
export async function consumeLoginToken(tokenHash) {
  const [row] = await sql`
    update login_tokens set consumed_at = now()
    where token_hash = ${tokenHash} and consumed_at is null and expires_at > now()
    returning email
  `;
  return row ?? null;
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
  s.image_url as subject_image, s.backdrop_url as subject_backdrop
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

export async function markPlaylistError({ userId, error }) {
  await sql`
    update user_playlists set last_error = ${error}, last_synced_at = now()
    where user_id = ${userId}
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
    select c.title, c.group_title, c.stream_url, c.norm_title
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
    order by c.position
    limit ${limit}
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
