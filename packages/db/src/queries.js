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
 * as a malformed array literal — silently breaking passkey registration, saving
 * reminder preferences, and the reminder fan-out's user lookup. Building the
 * literal here and casting at the call site is deterministic and does not depend
 * on how the driver decides to encode a parameter.
 */
export function pgArray(values) {
  const items = (values ?? []).map((v) =>
    // Unquoted NULL, not the string "null": a nullable column (a score before
    // kickoff, a clock for a sport that has none) must arrive as SQL NULL.
    v === null || v === undefined ? 'NULL' : `"${String(v).replace(/(["\\])/g, '\\$1')}"`,
  );
  return `{${items.join(',')}}`;
}

/* ---------------------------------------------------------------- accounts -- */

/**
 * Magic-link consumption creates the account if the address is new. There is no
 * separate registration path: proving you can read the mailbox IS the account.
 */
export async function findOrCreateUser(email) {
  const [row] = await sql`
    insert into users ${sql({ email })}
    on conflict (email) do update set last_seen_at = now()
    returning *
  `;
  return row;
}

export async function insertLoginToken({ tokenHash, email, expiresAt }) {
  await sql`insert into login_tokens ${sql({ token_hash: tokenHash, email, expires_at: expiresAt })}`;
}

/** Spent on first use -- the update is the guard, so a replayed link is inert. */
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
    insert into sessions (user_id, expires_at, user_agent)
    values (${userId}, now() + ${`${ttlDays} days`}::interval, ${userAgent ?? null})
    returning id
  `;
  return row.id;
}

export async function getSessionUser(sessionId) {
  const [row] = await sql`
    select u.* from sessions s
    join users u on u.id = s.user_id
    where s.id = ${sessionId} and s.expires_at > now()
  `;
  return row ?? null;
}

export async function endSession(sessionId) {
  await sql`delete from sessions where id = ${sessionId}`;
}

/* ---------------------------------------------------------------- passkeys -- */

export async function insertPasskey({ credentialId, userId, publicKey, counter, transports }) {
  await sql`
    insert into passkeys (credential_id, user_id, public_key, counter, transports)
    values (${credentialId}, ${userId}, ${publicKey}, ${counter}, ${pgArray(transports)}::text[])
    on conflict (credential_id) do update set
      public_key = excluded.public_key,
      counter = excluded.counter,
      transports = excluded.transports
  `;
}

export async function getPasskey(credentialId) {
  const [row] = await sql`select * from passkeys where credential_id = ${credentialId}`;
  return row ?? null;
}

export async function listPasskeys(userId) {
  return sql`select credential_id, transports, created_at, last_used_at from passkeys where user_id = ${userId}`;
}

export async function touchPasskey(credentialId, counter) {
  await sql`update passkeys set counter = ${counter}, last_used_at = now() where credential_id = ${credentialId}`;
}

/* ---------------------------------------------------------- own playlists -- */

/**
 * Every query here takes a user_id and uses it, without exception.
 *
 * That is the whole security model for this feature: a channel list is one
 * person's own subscription, and there must be no query that can return another
 * account's rows even by mistake. A `getPlaylistById` taking only an id is exactly
 * the shape that leaks it later, so it does not exist -- ownership is part of the
 * lookup rather than something a caller is trusted to remember.
 */

/** One list per account: adding a second replaces the first. */
export async function savePlaylist({ userId, label, sourceUrl }) {
  const [row] = await sql`
    insert into user_playlists (user_id, label, source_url)
    values (${userId}, ${label ?? null}, ${sourceUrl})
    on conflict (user_id) do update set
      label = excluded.label,
      source_url = excluded.source_url,
      last_error = null
    returning id, user_id, label, channel_count, last_synced_at, last_error, created_at
  `;
  return row;
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
    update user_playlists set last_error = ${String(error).slice(0, 300)}, last_synced_at = now()
    where user_id = ${userId}
  `;
}

/**
 * Replace a list's channels wholesale.
 *
 * Delete-then-insert rather than a diff: a provider rewrites its numbered event
 * slots constantly, so almost every row changes on every refresh and a diff would
 * be more work for the same answer. Both statements run in one transaction so a
 * failed import cannot leave the reader holding half a list.
 */
export async function replacePlaylistChannels({ userId, channels }) {
  return sql.begin(async (tx) => {
    const [pl] = await tx`select id from user_playlists where user_id = ${userId}`;
    if (!pl) return 0;

    await tx`delete from user_playlist_channels where playlist_id = ${pl.id}`;

    // Chunked because a real list is thousands of rows, and one statement per row
    // would be thousands of round trips.
    const CHUNK = 500;
    for (let i = 0; i < channels.length; i += CHUNK) {
      const slice = channels.slice(i, i + CHUNK).map((c, n) => ({
        playlist_id: pl.id,
        position: i + n,
        title: c.title,
        stream_url: c.streamUrl,
        norm_title: c.normTitle,
      }));
      if (slice.length) await tx`insert into user_playlist_channels ${tx(slice)}`;
    }

    await tx`
      update user_playlists
         set channel_count = ${channels.length}, last_synced_at = now(), last_error = null
       where id = ${pl.id}
    `;
    return channels.length;
  });
}

/**
 * The reader's own channels, for matching against a fixture.
 *
 * Joined through user_playlists on user_id, so ownership is enforced by the
 * statement rather than by the caller remembering to check it.
 */
export async function playlistChannels(userId, { limit = 20000 } = {}) {
  return sql`
    select c.title, c.stream_url, c.norm_title
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
    order by c.position
    limit ${limit}
  `;
}

/* --------------------------------------------------------------- catalogue -- */

/**
 * Upsert from the catalogue endpoint.
 *
 * Note what is NOT updated: name, abbreviation and logo. The catalogue only knows a
 * league's slug, so it seeds those on insert and must never touch them again --
 * otherwise the daily catalogue sync overwrites "English Premier League" with
 * "eng.1" every night. The scoreboard is the authority for display metadata; see
 * renameLeague.
 */
export async function upsertLeague(league) {
  const [row] = await sql`
    insert into leagues ${sql(league)}
    on conflict (provider, provider_key) do update set
      sport = excluded.sport,
      active = true
    returning *
  `;
  return row;
}

/**
 * How many leagues are still named after their raw slug.
 *
 * A non-zero count means display names have never been backfilled from the
 * scoreboard, which is a reason to sync even when the fixtures themselves are
 * fresh -- otherwise the site shows "eng.1" until something else happens to
 * trigger a sweep.
 */
export async function leaguesMissingRealName() {
  const [row] = await sql`
    select count(*)::int as n from leagues
    where active and name = split_part(provider_key, '/', 2)
  `;
  return row.n;
}

export async function upsertTeams(teams) {
  if (teams.length === 0) return [];
  return sql`
    insert into teams ${sql(teams)}
    on conflict (provider, provider_key) do update set
      name = excluded.name,
      display_name = excluded.display_name,
      abbreviation = excluded.abbreviation,
      logo_url = coalesce(excluded.logo_url, teams.logo_url)
    returning id, provider_key
  `;
}

/**
 * Bulk upsert in one statement. A sync touches hundreds of rows per league and the
 * cost is round trips, not rows -- one multi-row insert beats a loop by an order of
 * magnitude, and keeps the whole league's schedule atomically consistent.
 */
export async function upsertEvents(events) {
  if (events.length === 0) return [];
  return sql`
    insert into events ${sql(events)}
    on conflict (provider, provider_key) do update set
      starts_at = excluded.starts_at,
      state = excluded.state,
      status_detail = excluded.status_detail,
      name = excluded.name,
      short_name = excluded.short_name,
      venue = coalesce(excluded.venue, events.venue),
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      -- Must be updated, not just set on insert. Rebuilding the team rows leaves
      -- existing fixtures pointing at nothing, and without this they stay that way
      -- forever: the league page falls back to the provider's own title string and
      -- looks fine, while every team reports "no fixtures scheduled" and each team
      -- page is empty. coalesce so a provider omitting a side (individual sports)
      -- cannot wipe a reference we already resolved.
      home_team_id = coalesce(excluded.home_team_id, events.home_team_id),
      away_team_id = coalesce(excluded.away_team_id, events.away_team_id),
      venue_city = coalesce(excluded.venue_city, events.venue_city),
      venue_region = coalesce(excluded.venue_region, events.venue_region),
      -- Not coalesced: a fixture moved to or from a neutral ground must be able to
      -- go back to false, and false is a real value rather than an absent one.
      neutral_site = excluded.neutral_site,
      -- ESPN wins whenever it actually has a listing: it is the more precise
      -- source for the US leagues it covers, and it is the one that fills in
      -- late as kickoff approaches. Its NULL must not wipe a value the fallback
      -- pass found, which is what the coalesce is for -- and the provenance
      -- columns have to move WITH the value or a row ends up labelled with the
      -- market of a listing it no longer holds.
      broadcast = coalesce(excluded.broadcast, events.broadcast),
      broadcast_source =
        case when excluded.broadcast is not null then 'espn' else events.broadcast_source end,
      broadcast_country =
        case when excluded.broadcast is not null then 'United States' else events.broadcast_country end,
      broadcast_markets =
        case when excluded.broadcast is not null
             then excluded.broadcast_markets else events.broadcast_markets end,
      attendance = coalesce(excluded.attendance, events.attendance),
      period = excluded.period,
      display_clock = excluded.display_clock,
      home_record = coalesce(excluded.home_record, events.home_record),
      away_record = coalesce(excluded.away_record, events.away_record),
      updated_at = now()
    returning id, provider_key
  `;
}

/**
 * Leagues with a fixture in a given window.
 *
 * The lever the whole near-window refresh turns on. Measured against production on
 * 2026-08-21: of 359 active leagues, 48 had a fixture today and 74 within 48 hours
 * -- so asking only these costs a fifth of a full sweep, and the four fifths it
 * skips are competitions that are out of season or not playing until next week.
 *
 * Distinct on the league, not the fixture: one request answers a whole league's
 * window, so a league with nine games today is still one row here.
 */
export async function leaguesWithFixturesBetween({ from, to }) {
  return sql`
    select distinct l.*
    from leagues l
    join events e on e.league_id = l.id
    where l.active
      and e.starts_at >= ${from}
      and e.starts_at < ${to}
    order by l.priority, l.name
  `;
}

/**
 * Fixtures inside the horizon that still have nobody broadcasting them.
 *
 * This is the work list for the fallback pass, and it is deliberately narrow. Most
 * of the table is in this state -- ESPN carries listings for a minority of the 354
 * leagues -- so the query is bounded by the same window the sweep keeps populated
 * rather than by row count, and leans on the partial index added in 0013.
 *
 * Both sides are required. A fixture with an unresolved team cannot be matched
 * against a listing titled "Home vs Away", so fetching it would only waste a
 * request; individual sports (tennis, golf, racing) fall out here for that reason.
 */
export async function listEventsMissingBroadcast({ from, to, limit = 500 }) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  return sql`
    select e.id, e.starts_at, l.sport,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    join teams ht on ht.id = e.home_team_id
    join teams at on at.id = e.away_team_id
    where e.broadcast is null
      and e.starts_at >= ${from}
      and e.starts_at < ${to}
    order by e.starts_at
    limit ${cap}
  `;
}

/**
 * Write listings found by the fallback pass.
 *
 * Guarded by `broadcast is null` in the statement itself, not just in the query
 * that built the work list. The pass fetches over the network between the two, and
 * a live tick landing an ESPN listing in that gap is the expected case rather than
 * a race worth ignoring -- ESPN is the better source when it has an answer, so the
 * writer that would downgrade it declines instead.
 *
 * @param {Array<{id:number, broadcast:string, country:string|null}>} rows
 */
export async function fillMissingBroadcasts(rows) {
  if (rows.length === 0) return [];
  return sql`
    update events e set
      broadcast = v.broadcast,
      broadcast_source = 'thesportsdb',
      broadcast_country = v.country,
      broadcast_markets = v.markets::jsonb,
      updated_at = now()
    from (
      select * from unnest(
        ${pgArray(rows.map((r) => r.id))}::bigint[],
        ${pgArray(rows.map((r) => r.broadcast))}::text[],
        ${pgArray(rows.map((r) => r.country ?? null))}::text[],
        -- Serialised here rather than bound as an object: these go through the
        -- same text[] unnest as everything else, and Bun's client flattens a JS
        -- array with Array.prototype.toString rather than into a Postgres literal.
        ${pgArray(rows.map((r) => JSON.stringify(r.markets ?? [])))}::text[]
      ) as t(id, broadcast, country, markets)
    ) v
    where e.id = v.id and e.broadcast is null
    returning e.id
  `;
}

export async function listLeagues({ sport = null, limit = 500 } = {}) {
  if (sport) {
    return sql`select * from leagues where active and sport = ${sport} order by priority, name limit ${limit}`;
  }
  return sql`select * from leagues where active order by priority, name limit ${limit}`;
}

export async function listSports() {
  return sql`select sport, count(*)::int as leagues from leagues where active group by sport order by sport`;
}

/** Trigram search over team names, for the follow picker. */
export async function searchTeams(term, limit = 25) {
  return sql`
    select t.id, t.slug, t.display_name, t.logo_url, l.name as league_name, l.sport
    from teams t left join leagues l on l.id = t.league_id
    where t.display_name ilike ${`%${term}%`}
    order by similarity(t.display_name, ${term}) desc
    limit ${limit}
  `;
}

/* ----------------------------------------------------------------- follows -- */

export async function addFollow({ userId, subjectType, subjectId }) {
  await sql`
    insert into follows ${sql({ user_id: userId, subject_type: subjectType, subject_id: subjectId })}
    on conflict do nothing
  `;
}

export async function removeFollow({ userId, subjectType, subjectId }) {
  await sql`delete from follows where user_id = ${userId} and subject_type = ${subjectType} and subject_id = ${subjectId}`;
}

export async function listFollows(userId) {
  return sql`
    select f.subject_type, f.subject_id,
           coalesce(t.display_name, l.name) as label,
           coalesce(t.logo_url, l.logo_url) as logo_url,
           coalesce(tl.sport, l.sport) as sport
    from follows f
    left join teams t on f.subject_type = 'team' and t.id = f.subject_id
    left join leagues tl on tl.id = t.league_id
    left join leagues l on f.subject_type = 'league' and l.id = f.subject_id
    where f.user_id = ${userId}
    order by label
  `;
}

/* ---------------------------------------------------------------- schedule -- */

/** The signed-in calendar: every upcoming game involving anything the user follows. */
export async function upcomingForUser(userId, { limit = 100 } = {}) {
  return sql`
    select distinct e.*, l.name as league_name, l.sport, true as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    join follows f on f.user_id = ${userId}
      and (
        (f.subject_type = 'league' and f.subject_id = e.league_id)
        or (f.subject_type = 'team' and f.subject_id in (e.home_team_id, e.away_team_id))
      )
    where e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/** The public calendar, identical for every visitor, so it is cacheable wholesale. */
export async function scheduleForDay({ day, sport = null, limit = 300, viewerId = null }) {
  if (sport) {
    return sql`
      select e.*, l.name as league_name, l.sport,
             exists (
               select 1 from follows vf
               where vf.user_id = ${viewerId}
                 and (
                   (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                   or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
                 )
             ) as following,
             ht.display_name as home_name, ht.logo_url as home_logo,
             at.display_name as away_name, at.logo_url as away_logo
      from events e
      join leagues l on l.id = e.league_id
      left join teams ht on ht.id = e.home_team_id
      left join teams at on at.id = e.away_team_id
      where e.starts_at >= ${day}::date and e.starts_at < ${day}::date + interval '1 day'
        and l.sport = ${sport}
      order by e.starts_at limit ${limit}
    `;
  }
  return sql`
    select e.*, l.name as league_name, l.sport,
           exists (
             select 1 from follows vf
             where vf.user_id = ${viewerId}
               and (
                 (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                 or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
               )
           ) as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.starts_at >= ${day}::date and e.starts_at < ${day}::date + interval '1 day'
    order by l.priority, e.starts_at limit ${limit}
  `;
}

export async function getEvent(eventId) {
  const [row] = await sql`
    select e.*, l.name as league_name, l.slug as league_slug, l.sport,
           ht.display_name as home_name, ht.logo_url as home_logo, ht.slug as home_slug,
           at.display_name as away_name, at.logo_url as away_logo, at.slug as away_slug
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.id = ${eventId}
  `;
  return row ?? null;
}

/* --------------------------------------------------------------- reminders -- */

/**
 * Events crossing a reminder threshold in this tick.
 *
 * The window is bounded on both sides. The lower bound is what stops a backlog from
 * firing "starts in 1 hour" for games that kicked off twenty minutes ago after the
 * worker has been down -- late reminders are worse than absent ones.
 */
export async function eventsDueForReminder({ offsetMinutes, lookbackSeconds }) {
  return sql`
    select e.id, e.starts_at, e.name, e.short_name, e.league_id
    from events e
    where e.state = 'pre'
      and e.starts_at - (${offsetMinutes} * interval '1 minute') <= now()
      and e.starts_at - (${offsetMinutes} * interval '1 minute') > now() - (${lookbackSeconds} * interval '1 second')
    order by e.starts_at
  `;
}

/**
 * One page of the people to notify about one event, keyset-paginated by user id.
 *
 * Keyset rather than OFFSET on purpose: a popular final can have millions of
 * followers, and OFFSET re-scans everything it skips, so page N gets linearly
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
      on (f.subject_type = 'league' and f.subject_id = e.league_id)
      or (f.subject_type = 'team' and f.subject_id in (e.home_team_id, e.away_team_id))
    where e.id = ${eventId} and f.user_id > ${after}::uuid
    order by f.user_id
    limit ${limit}
  `;
}

/** Delivery targets for a page of users: their channels and live push endpoints. */
export async function deliveryTargets(userIds) {
  if (userIds.length === 0) return [];
  return sql`
    select u.id as user_id, u.email, u.timezone,
           coalesce(p.channels, '{webpush,email}') as channels,
           coalesce(p.offsets_minutes, '{60,1}') as offsets_minutes,
           coalesce(
             json_agg(json_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth))
               filter (where ps.id is not null and ps.disabled_at is null),
             '[]'
           ) as push_subscriptions
    from users u
    left join reminder_prefs p on p.user_id = u.id
    left join push_subscriptions ps on ps.user_id = u.id and ps.disabled_at is null
    where u.id = any(${pgArray(userIds)}::uuid[])
    group by u.id, p.channels, p.offsets_minutes
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
 * from a failed send blocks every retry, so BullMQ's five attempts would re-claim
 * nothing and the reminder would be lost on the first transient push error --
 * retries that exist but cannot do anything. A row already marked `sent` is never
 * re-claimed, so this can resurrect a failure without ever duplicating a success.
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

/* ------------------------------------------------------------- push subs --- */

export async function savePushSubscription({ userId, endpoint, p256dh, auth }) {
  await sql`
    insert into push_subscriptions ${sql({ user_id: userId, endpoint, p256dh, auth })}
    on conflict (endpoint) do update set
      user_id = excluded.user_id, p256dh = excluded.p256dh,
      auth = excluded.auth, disabled_at = null
  `;
}

/** Called on a 404/410 from the push service: the browser threw the subscription away. */
export async function disablePushSubscription(endpoint) {
  await sql`update push_subscriptions set disabled_at = now() where endpoint = ${endpoint}`;
}

export async function getPrefs(userId) {
  const [row] = await sql`select * from reminder_prefs where user_id = ${userId}`;
  return row ?? null;
}

export async function savePrefs({ userId, offsetsMinutes, channels }) {
  await sql`
    insert into reminder_prefs (user_id, offsets_minutes, channels)
    values (${userId}, ${pgArray(offsetsMinutes)}::int[], ${pgArray(channels)}::text[])
    on conflict (user_id) do update set
      offsets_minutes = excluded.offsets_minutes,
      channels = excluded.channels,
      updated_at = now()
  `;
}

/**
 * Every reminder offset any user has actually chosen, unioned with the defaults.
 *
 * The scanner must look for exactly these thresholds. Scanning only the defaults
 * would silently never fire a custom offset; scanning a fixed wide range would burn
 * a query per minute-value nobody uses.
 */
export async function distinctReminderOffsets(defaults) {
  const rows = await sql`
    select distinct unnest(offsets_minutes) as m from reminder_prefs
  `;
  return [...new Set([...defaults, ...rows.map((r) => r.m)])]
    .filter((m) => m > 0)
    .sort((a, b) => b - a);
}

/** Replace a catalogue slug with the provider's real display name once we see it. */
export async function renameLeague({ id, name, abbreviation, logoUrl }) {
  await sql`
    update leagues set
      name = ${name},
      abbreviation = coalesce(${abbreviation ?? null}, abbreviation),
      logo_url = coalesce(${logoUrl ?? null}, logo_url)
    where id = ${id}
  `;
}

export async function getLeagueBySlug(slug) {
  const [row] = await sql`select * from leagues where slug = ${slug} and active`;
  return row ?? null;
}

/**
 * A league's own upcoming fixtures.
 *
 * Not "today's schedule filtered to this league" -- that was the first cut, and it
 * told anyone visiting a league with no game today that it had no fixtures at all.
 */
export async function upcomingForLeague(leagueId, { limit = 200, viewerId = null } = {}) {
  return sql`
    select e.*, l.name as league_name, l.sport,
           exists (
             select 1 from follows vf
             where vf.user_id = ${viewerId}
               and (
                 (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                 or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
               )
           ) as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.league_id = ${leagueId} and e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/** Counts for the public API index and the about page. */
export async function catalogueStats() {
  const [row] = await sql`
    select
      (select count(*)::int from leagues where active)                as leagues,
      (select count(distinct sport)::int from leagues where active)   as sports,
      (select count(*)::int from teams)                               as teams,
      (select count(*)::int from events where starts_at > now())      as upcoming_events,
      (select max(updated_at) from events)                            as last_sync
  `;
  return row;
}

/** Public API event feed. Bounded and ordered so it cannot be used to scrape the lot. */
export async function publicEvents({ leagueSlug = null, sport = null, from = null, limit = 100 }) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return sql`
    select e.id, e.starts_at, e.state, e.status_detail, e.name, e.short_name, e.venue,
           e.venue_city, e.venue_region, e.neutral_site,
           e.home_score, e.away_score,
           l.slug as league, l.name as league_name, l.sport,
           ht.display_name as home, at.display_name as away
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.starts_at > coalesce(${from}::timestamptz, now() - interval '3 hours')
      and (${leagueSlug}::text is null or l.slug = ${leagueSlug})
      and (${sport}::text is null or l.sport = ${sport})
    order by e.starts_at
    limit ${cap}
  `;
}

/** Months that actually contain fixtures, for the sitemap index. */
export async function eventMonths() {
  return sql`
    select to_char(starts_at, 'YYYY-MM') as month, count(*)::int as n, max(updated_at) as lastmod
    from events
    group by 1 order by 1
  `;
}

/** One month of events for a sitemap chunk. Ordered by (starts_at, id): ordering by
 *  the timestamp alone leaves rows stamped in the same bulk write in an undefined
 *  order, and paginating an undefined order can repeat a row in one chunk while
 *  dropping it from another. */
export async function eventsForMonth(month, { limit = 45000, offset = 0 } = {}) {
  return sql`
    select id, updated_at from events
    where to_char(starts_at, 'YYYY-MM') = ${month}
    order by starts_at, id
    limit ${limit} offset ${offset}
  `;
}

/* ------------------------------------------------------- browse + follow -- */

/**
 * Teams in a league, with whether this user already follows each.
 *
 * The follow state is joined rather than fetched separately so the picker can render
 * the right button in one pass; a second round trip per team is what makes a
 * 500-team league page crawl.
 */
export async function teamsForLeague(leagueId, userId = null) {
  return sql`
    select t.id, t.slug, t.display_name, t.logo_url,
           (f.user_id is not null) as following,
           (select count(*)::int from events e
             where (e.home_team_id = t.id or e.away_team_id = t.id)
               and e.starts_at > now()) as upcoming
    from team_leagues tl
    join teams t on t.id = tl.team_id
    left join follows f
      on f.subject_type = 'team' and f.subject_id = t.id and f.user_id = ${userId}::uuid
    where tl.league_id = ${leagueId}
    order by t.display_name
  `;
}

export async function getTeamBySlug(slug) {
  const [row] = await sql`
    select t.*, l.name as league_name, l.slug as league_slug, l.sport
    from teams t left join leagues l on l.id = t.league_id
    where t.slug = ${slug}
  `;
  return row ?? null;
}

export async function isFollowing({ userId, subjectType, subjectId }) {
  if (!userId) return false;
  const [row] = await sql`
    select 1 from follows
    where user_id = ${userId} and subject_type = ${subjectType} and subject_id = ${subjectId}
  `;
  return Boolean(row);
}

/** A single team's upcoming fixtures, home or away. */
export async function upcomingForTeam(teamId, { limit = 60, viewerId = null } = {}) {
  return sql`
    select e.*, l.name as league_name, l.sport,
           exists (
             select 1 from follows vf
             where vf.user_id = ${viewerId}
               and (
                 (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                 or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
               )
           ) as following,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where (e.home_team_id = ${teamId} or e.away_team_id = ${teamId})
      and e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/** Remember the viewer's timezone, which is what email reminders are stamped in. */
export async function setUserTimezone(userId, timezone) {
  await sql`update users set timezone = ${timezone} where id = ${userId}`;
}

/** Leagues in a sport, with whether this user follows each. */
export async function leaguesForSport(sport, userId = null) {
  return sql`
    select l.*, (f.user_id is not null) as following
    from leagues l
    left join follows f
      on f.subject_type = 'league' and f.subject_id = l.id and f.user_id = ${userId}::uuid
    where l.active and l.sport = ${sport}
    order by l.priority, l.name
  `;
}

/** Stamp a league as roster-checked, whether or not it had one. */
export async function markRostersSynced(leagueId) {
  await sql`update leagues set rosters_synced_at = now() where id = ${leagueId}`;
}

/** How many active leagues have never had their roster fetched. */
export async function leaguesMissingRosters() {
  const [row] = await sql`
    select count(*)::int as n from leagues where active and rosters_synced_at is null
  `;
  return row.n;
}

/**
 * Record which competitions a team plays in.
 *
 * Separate from the teams upsert because it is many-to-many: a club appears in its
 * league, its cup and often a continental competition, and each sweep should add
 * its own edge rather than overwrite the others.
 */
export async function linkTeamsToLeague(teamIds, leagueId) {
  if (teamIds.length === 0) return;
  await sql`
    insert into team_leagues (team_id, league_id)
    select unnest(${pgArray(teamIds)}::bigint[]), ${leagueId}
    on conflict do nothing
  `;
}

/**
 * Leagues with a game in progress, or one that just kicked off.
 *
 * Drives the live tick. Deliberately narrow: on a normal evening this is a handful
 * of leagues out of 354, so refreshing scores every minute costs a handful of
 * requests rather than a full sweep.
 */
export async function leaguesWithLiveGames() {
  return sql`
    select distinct l.*
    from leagues l
    join events e on e.league_id = l.id
    where l.active
      and (
        e.state = 'in'
        -- A game that has just started but whose state we have not refreshed yet;
        -- without this the first minutes of every match show no score at all.
        or (e.state = 'pre' and e.starts_at between now() - interval '30 minutes' and now() + interval '5 minutes')
      )
  `;
}

/**
 * Write only what changes during a game.
 *
 * Deliberately not the full event upsert: a live tick must never touch kickoff
 * time, teams or venue, so a provider hiccup mid-match cannot rewrite the fixture
 * itself. Rows that do not already exist are ignored rather than inserted.
 */
export async function updateEventScores(rows) {
  if (rows.length === 0) return [];

  // Column-wise arrays through unnest, not a row-wise VALUES list.
  //
  // `from (values ${sql(rows)})` looks natural and fails at runtime with "Cannot
  // use array of objects for UPDATE" -- Bun's helper builds VALUES for INSERT, not
  // for an UPDATE ... FROM. The live tick caught that, counted it as a failure and
  // printed nothing, so every score froze for two hours and it read like an
  // upstream block.
  return sql`
    update events e set
      state = v.state,
      status_detail = v.status_detail,
      home_score = v.home_score,
      away_score = v.away_score,
      period = v.period,
      display_clock = v.display_clock,
      attendance = coalesce(v.attendance, e.attendance),
      -- Same rule as the sweep. This tick is where a US listing usually appears:
      -- ESPN assigns most of them close to kickoff, so the live pass is the one
      -- that upgrades a fallback listing to the real broadcaster.
      broadcast = coalesce(v.broadcast, e.broadcast),
      broadcast_source = case when v.broadcast is not null then 'espn' else e.broadcast_source end,
      broadcast_country = case when v.broadcast is not null then 'United States' else e.broadcast_country end,
      broadcast_markets =
        case when v.broadcast is not null then v.markets::jsonb else e.broadcast_markets end,
      updated_at = now()
    from (
      select * from unnest(
        ${pgArray(rows.map((r) => r.provider))}::text[],
        ${pgArray(rows.map((r) => r.provider_key))}::text[],
        ${pgArray(rows.map((r) => r.state))}::text[],
        ${pgArray(rows.map((r) => r.status_detail ?? null))}::text[],
        ${pgArray(rows.map((r) => r.home_score ?? null))}::int[],
        ${pgArray(rows.map((r) => r.away_score ?? null))}::int[],
        ${pgArray(rows.map((r) => r.period ?? null))}::int[],
        ${pgArray(rows.map((r) => r.display_clock ?? null))}::text[],
        ${pgArray(rows.map((r) => r.attendance ?? null))}::int[],
        ${pgArray(rows.map((r) => r.broadcast ?? null))}::text[],
        ${pgArray(rows.map((r) => (r.broadcast ? JSON.stringify(r.markets ?? []) : null)))}::text[]
      ) as t(provider, provider_key, state, status_detail, home_score, away_score,
             period, display_clock, attendance, broadcast, markets)
    ) v
    where e.provider = v.provider and e.provider_key = v.provider_key
    returning e.id
  `;
}

/** Forget a push subscription entirely: the browser has revoked it or the user
 *  turned notifications off, and a disabled row would still look like a device. */
export async function deletePushSubscription({ userId, endpoint }) {
  await sql`delete from push_subscriptions where user_id = ${userId} and endpoint = ${endpoint}`;
}

/* ------------------------------------------------------------- feeds/ics -- */

/** Resolve a calendar subscription URL back to its owner. */
export async function userByCalendarToken(token) {
  const [row] = await sql`select * from users where calendar_token = ${token}::uuid`;
  return row ?? null;
}

/** Issue a new token, invalidating every calendar URL already handed out. */
export async function rotateCalendarToken(userId) {
  const [row] = await sql`
    update users set calendar_token = gen_random_uuid() where id = ${userId}
    returning calendar_token
  `;
  return row?.calendar_token ?? null;
}

/**
 * Public feed of upcoming fixtures, optionally scoped.
 *
 * Ordered by start time and bounded: a feed is a window on what is next, not a
 * dump of the catalogue. Includes team names and the league so an item reads
 * standalone in a reader that shows nothing else.
 */
export async function feedEvents({
  sport = null,
  leagueSlug = null,
  teamSlug = null,
  limit = 100,
}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return sql`
    select e.id, e.starts_at, e.name, e.short_name, e.venue, e.state,
           e.venue_city, e.venue_region, e.neutral_site,
           e.home_score, e.away_score, e.status_detail, e.broadcast, e.broadcast_country,
           e.updated_at,
           l.name as league_name, l.slug as league_slug, l.sport,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.starts_at > now() - interval '3 hours'
      and (${sport}::text is null or l.sport = ${sport})
      and (${leagueSlug}::text is null or l.slug = ${leagueSlug})
      and (${teamSlug}::text is null or ht.slug = ${teamSlug} or at.slug = ${teamSlug})
    order by e.starts_at
    limit ${cap}
  `;
}

/** Leagues with something upcoming, for the feed directory. */
export async function leaguesWithUpcoming(limit = 400) {
  return sql`
    select l.slug, l.name, l.sport, count(e.id)::int as upcoming
    from leagues l
    join events e on e.league_id = l.id and e.starts_at > now()
    where l.active
    group by l.slug, l.name, l.sport
    order by count(e.id) desc, l.name
    limit ${limit}
  `;
}

/* --------------------------------------------------------------- plays --- */

/**
 * Events whose play log is due a refresh.
 *
 * A summary response is ~500KB, so this is deliberately narrow and spaced: games
 * actually in progress, oldest-refreshed first, and capped. Re-reading every live
 * game every minute would cost more bandwidth than the rest of the app combined --
 * and all of it metered, since these go through the proxy.
 *
 * Plus one last read after the whistle. Scoping this to `in` alone lost the end of
 * every game: the poll runs every two minutes, the final score and the flip to
 * `post` arrive on the one-minute score tick, and the event stops matching before
 * the last drive is ever fetched -- so the recap on a finished game ended somewhere
 * short of the finish. `plays_final` is what closes one out, and we set it
 * ourselves: inferring it from `updated_at` moving looked equivalent and was not,
 * because the score tick writes that column for every fixture on a league's
 * scoreboard -- finished ones included -- for as long as that league has any game
 * in progress. Games that had ended hours earlier kept re-qualifying every minute,
 * so the queue churned instead of draining and each pass spent another 500KB per
 * fixture. `catchupHours` bounds how far back that closing read reaches, which is a
 * cost limit rather than a rule -- see config.sports.playsCatchupHours for widening
 * it to backfill history.
 *
 * `state = 'in'` on its own is not a claim that a game is on right now, only that
 * nothing ever said otherwise. A fixture the provider stops returning keeps that
 * state forever, and those accumulate -- so the poller spent its whole quota
 * re-reading finished games while the fixtures someone was actually watching sat
 * behind the cap and never got a first read at all. `updated_at` is the honest
 * signal: the score tick stamps it every minute for the leagues that have a game
 * on, so a row it is still touching is genuinely live, and one it has stopped
 * touching drops out on its own without anyone having to decide what counts as
 * "too long" for a sport whose fixtures can legitimately run for days.
 *
 * `plays_supported` keeps competitions that can never have a log out of the queue
 * entirely. Ten of the sixteen sports in the catalogue either return a boxscore and
 * nothing else, or have no summary for the kind of id we store -- and their fixtures
 * were taking slots every cycle to come back empty, ahead of leagues that do have a
 * log. See 0012_plays_supported.sql for how that was measured.
 *
 * Each row also carries how many matched in total. The caller only ever sees the
 * capped slice, so a queue it can never drain looks exactly like a queue it just
 * drained -- which is how live fixtures went a whole game without a play log while
 * the worker logged "0 failed" every two minutes. A window function is evaluated
 * before the limit, so this is the true total and costs no second round trip.
 *
 * One state at a time, because the two are not interchangeable and must not queue
 * behind each other. A live game needs reading again and again while it is on; a
 * finished one needs reading exactly once more. Drawn from one pool the finished
 * ones win on age alone -- 252 of them took every slot for an hour while the
 * fixtures actually being played got nothing -- so the caller asks for each
 * separately and gives the live ones the bulk of the quota.
 */
export async function eventsNeedingPlays({
  staleSeconds = 120,
  limit = 10,
  state = 'in',
  catchupHours = 12,
} = {}) {
  return sql`
    select e.id, e.state, e.provider_key, l.provider_key as league_key, l.provider,
           (count(*) over ())::int as total_due
    from events e
    join leagues l on l.id = e.league_id
    where e.state = ${state}
      and l.plays_supported
      and (
        (e.state = 'in'
          and e.updated_at > now() - interval '10 minutes'
          and (e.plays_synced_at is null
               or e.plays_synced_at < now() - (${staleSeconds} * interval '1 second')))
        or
        (e.state = 'post'
          and e.starts_at > now() - (${catchupHours} * interval '1 hour')
          and not e.plays_final)
      )
    -- Each queue wants the opposite end. Among live games the fairest next read is
    -- the one waiting longest, so they take turns. Among finished ones age is the
    -- wrong tiebreak entirely: the game that just went final is the one somebody is
    -- refreshing for the recap, and ordering by last-read put it behind a backlog
    -- of yesterday's fixtures -- roughly five hours behind, at two reads a tick.
    -- The case is null for every row in the live queue, so that falls straight
    -- through to the second key.
    order by (case when e.state = 'post' then e.starts_at end) desc nulls last,
             e.plays_synced_at asc nulls first
    limit ${limit}
  `;
}

/** Close out a finished game's log, so its one catch-up read is not repeated. */
export async function markPlaysFinal(eventId) {
  await sql`update events set plays_final = true, plays_synced_at = now() where id = ${eventId}`;
}

export async function markPlaysSynced(eventId) {
  await sql`update events set plays_synced_at = now() where id = ${eventId}`;
}

/** Append only what is new; a re-read of the same game is a no-op. */
export async function insertPlays(rows) {
  if (rows.length === 0) return [];
  return sql`
    insert into event_plays ${sql(rows)}
    on conflict (event_id, provider_play_id) do nothing
    returning id
  `;
}

export async function playsForEvent(eventId, { limit = 60 } = {}) {
  return sql`
    select * from event_plays
    where event_id = ${eventId}
    order by sequence desc nulls last, id desc
    limit ${limit}
  `;
}

/* ------------------------------------------------------------ comments --- */

export async function commentsForEvent(eventId, { limit = 200 } = {}) {
  return sql`
    select c.id, c.body, c.created_at, u.email, u.id as user_id
    from event_comments c
    join users u on u.id = c.user_id
    where c.event_id = ${eventId} and c.deleted_at is null
    order by c.created_at desc
    limit ${limit}
  `;
}

/** How many this person has posted in the last minute, for rate limiting. */
export async function recentCommentCount(userId, seconds = 60) {
  const [row] = await sql`
    select count(*)::int as n from event_comments
    where user_id = ${userId} and created_at > now() - (${seconds} * interval '1 second')
  `;
  return row.n;
}

export async function insertComment({ eventId, userId, body }) {
  const [row] = await sql`
    insert into event_comments ${sql({ event_id: eventId, user_id: userId, body })}
    returning id, body, created_at
  `;
  return row;
}

/** Soft delete, and only your own: the row stays for moderation history. */
export async function deleteComment({ commentId, userId }) {
  const [row] = await sql`
    update event_comments set deleted_at = now()
    where id = ${commentId} and user_id = ${userId} and deleted_at is null
    returning id
  `;
  return Boolean(row);
}
