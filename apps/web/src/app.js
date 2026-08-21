import * as auth from '@genre/auth';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { sendLoginLink } from '@genre/notify';
import * as pay from '@genre/payments';
import { connection } from '@genre/queue';
import { oneChannelM3u } from '@genre/catalog';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { assetUrl, isCurrentVersion, loadAssetVersions } from './lib/asset-version.js';
import { buildCalendar } from './lib/ics.js';
import { importPlaylist, ownChannelsForEvent, refreshPlaylist } from './lib/playlist.js';
import { buildFeed } from './lib/rss.js';
import { Feeds } from './views/feeds.jsx';
import {
  About,
  EventPage,
  Following,
  Landing,
  LeaguePage,
  NotFound,
  PushCheck,
  Settings,
  SignIn,
  SportPage,
  SportsIndex,
  TeamPage,
  WatchPage,
} from './views/pages.jsx';

export const app = new Hono();

/* ----------------------------------------------------------------- helpers -- */

/**
 * Answer the caller in its own language.
 *
 * Every control on the site is a plain form, so the browser gets a 303 back to
 * where it came from and the page works with JavaScript off. A caller that asked
 * for JSON gets JSON. One helper, so the two can never drift apart.
 */
function respond(c, { json, redirectTo, status }) {
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json') || c.req.header('x-requested-with') === 'fetch') {
    // A status only makes sense on the JSON branch: the form path carries failure
    // in the query string it redirects to, because a 400 there would replace the
    // settings page with a bare error instead of showing it in context.
    return c.json(json ?? { ok: true }, status ?? 200);
  }
  return c.redirect(redirectTo ?? c.req.header('referer') ?? '/', 303);
}

/**
 * Render a page.
 *
 * Every HTML response goes through here for one reason: hono/jsx does not emit a
 * doctype, and a page served without one puts the browser in quirks mode, where
 * the box model and several of this stylesheet's assumptions quietly change.
 * Centralising it is the only way it cannot be forgotten on the one route nobody
 * checks.
 */
export const render = async (node) => `<!doctype html>${await node.toString()}`;

app.use('*', async (c, next) => {
  const sid = getCookie(c, config.session.cookie);
  c.set('user', sid ? await auth.userFromRequest(sid) : null);
  await next();
});

/** Signed-out actions send you to sign in and come back, rather than erroring. */
function requireUser(c) {
  const user = c.get('user');
  if (!user) {
    const next = encodeURIComponent(c.req.path);
    throw Object.assign(new Error('auth required'), { redirect: `/login?next=${next}` });
  }
  return user;
}

app.onError((err, c) => {
  if (err.redirect) return c.redirect(err.redirect, 303);
  console.error('[web]', err);
  return c.json({ error: 'internal' }, 500);
});

/* --------------------------------------------------------------- read path -- */

/**
 * Schedule pages are byte-identical for every visitor, so they are rendered once
 * and served from Redis. This is the difference between a viral spike hitting one
 * cache and hitting Postgres once per reader.
 */
async function cached(c, key, ttl, produce) {
  // Only ever cache what is identical for everyone. A signed-in page carries follow
  // stars and the visitor's own timezone, so it is rendered fresh -- caching it would
  // serve one person's calendar to the next visitor.
  if (!config.cache.enabled || c.get('user')) return c.html(await produce());

  try {
    const hit = await connection.get(key);
    if (hit) {
      c.header('x-cache', 'hit');
      return c.html(hit);
    }
  } catch {
    // A Redis blip must not take the site down; fall through to the database.
  }

  const body = await produce();
  connection.set(key, body, 'EX', ttl).catch(() => {});
  c.header('x-cache', 'miss');
  return c.html(body);
}

app.get('/healthz', (c) => c.text('ok'));

app.get('/', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const viewer = c.get('user');
  return cached(c, `page:home:${today}`, config.cache.scheduleTtlSeconds, async () => {
    const events = await q.scheduleForDay({ day: today, limit: 40, viewerId: viewer?.id ?? null });
    return render(<Landing user={c.get('user')} today={events} vapidKey={config.push.publicKey} />);
  });
});

app.get('/sports', async (c) =>
  cached(c, 'page:sports', 300, async () => {
    const sports = await q.listSports();
    return render(<SportsIndex user={c.get('user')} sports={sports} />);
  }),
);

app.get('/sports/:sport', async (c) => {
  const user = c.get('user');
  const sport = c.req.param('sport');
  const leagues = await q.leaguesForSport(sport, user?.id ?? null);
  if (leagues.length === 0) return c.html(await render(<NotFound user={user} />), 404);
  return c.html(await render(<SportPage user={user} sport={sport} leagues={leagues} />));
});

app.get('/leagues/:slug', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const league = await q.getLeagueBySlug(slug);
  if (!league) return c.html(await render(<NotFound user={user} />), 404);

  return cached(c, `page:league:${slug}`, config.cache.scheduleTtlSeconds, async () => {
    const [teams, events, following] = await Promise.all([
      q.teamsForLeague(league.id, user?.id ?? null),
      q.upcomingForLeague(league.id, { viewerId: user?.id ?? null }),
      q.isFollowing({ userId: user?.id, subjectType: 'league', subjectId: league.id }),
    ]);
    return render(
      <LeaguePage
        user={user}
        league={league}
        teams={teams}
        events={events}
        following={following}
      />,
    );
  });
});

app.get('/teams/:slug', async (c) => {
  const user = c.get('user');
  const team = await q.getTeamBySlug(c.req.param('slug'));
  if (!team) return c.html(await render(<NotFound user={user} />), 404);
  const [events, following] = await Promise.all([
    q.upcomingForTeam(team.id, { viewerId: user?.id ?? null }),
    q.isFollowing({ userId: user?.id, subjectType: 'team', subjectId: team.id }),
  ]);
  return c.html(
    await render(<TeamPage user={user} team={team} events={events} following={following} />),
  );
});

app.get('/following', async (c) => {
  const user = requireUser(c);
  const [events, follows] = await Promise.all([q.upcomingForUser(user.id), q.listFollows(user.id)]);
  return c.html(
    await render(
      <Following
        user={user}
        events={events}
        follows={follows}
        vapidKey={config.push.publicKey}
        calendarUrl={`${config.siteUrl}/calendar/me/${user.calendar_token}.ics`}
      />,
    ),
  );
});

app.get('/events/:id', async (c) => {
  const user = c.get('user');
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.html(await render(<NotFound user={user} />), 404);
  const [offers, entitlement, plays, comments, followingHome, followingAway, followingLeague] =
    await Promise.all([
      pay.offersForEvent(event.id),
      user ? pay.activeEntitlement({ userId: user.id, eventId: event.id }) : null,
      q.playsForEvent(event.id, { limit: 60 }),
      q.commentsForEvent(event.id),
      q.isFollowing({ userId: user?.id, subjectType: 'team', subjectId: event.home_team_id }),
      q.isFollowing({ userId: user?.id, subjectType: 'team', subjectId: event.away_team_id }),
      // A race, a tournament or a fight card has no sides to follow, so the
      // competition is the only subject there is. Without it those pages offered
      // nothing at all.
      q.isFollowing({ userId: user?.id, subjectType: 'league', subjectId: event.league_id }),
    ]);

  // Per-viewer, and safe only because this page is NOT one of the cached() ones.
  // If it is ever put behind Redis, this has to move out or one reader's channel
  // list -- credentials and all -- is served to the next visitor.
  const ownChannels = await ownChannelsForEvent({ userId: user?.id, event });
  return c.html(
    await render(
      <EventPage
        user={user}
        event={event}
        offers={offers}
        entitlement={entitlement}
        plays={plays}
        comments={comments}
        followingHome={followingHome}
        followingAway={followingAway}
        followingLeague={followingLeague}
        ownChannels={ownChannels}
      />,
    ),
  );
});

/**
 * The only gated part of a fixture: watching it.
 *
 * Everything else about a game -- when it starts, who is playing, where, on what
 * channel, the play log, the comments, the feeds and the whole public API -- is
 * readable without an account and stays that way. This one route is the exception,
 * because access to a stream is bought per event and belongs to one person.
 *
 * Two gates, in order, and both are required. requireUser bounces a signed-out
 * visitor to the login page carrying `next`, so they land back here afterwards
 * rather than on the home page. A signed-in visitor without an entitlement is sent
 * to the event page, which is where the offers are -- a 403 would be technically
 * right and useless, since "buy access" is the thing they actually need.
 *
 * NB: provider_ref is deliberately not rendered. The schema calls it an opaque
 * handle that a buyer never sees, and that is the whole security model for the
 * upstream slot -- putting it in the HTML would hand every viewer the credentials
 * to the provider slot the seller is reselling.
 */
app.get('/events/:id/watch', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.html(await render(<NotFound user={user} />), 404);

  const entitlement = await pay.activeEntitlement({ userId: user.id, eventId: event.id });
  if (!entitlement) return c.redirect(`/events/${event.id}`, 303);

  return c.html(await render(<WatchPage user={user} event={event} entitlement={entitlement} />));
});

/* --------------------------------------------------------- own playlists -- */

/**
 * A reader's own channel list.
 *
 * Every route here is behind requireUser and scoped to that user's rows. The list
 * is theirs: it is never pooled, never shown to another account, and never joined
 * to stream_offers -- this is a personal player feature, not a distribution one.
 */
app.post('/api/playlist', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  try {
    const result = await importPlaylist({
      userId: user.id,
      url: String(body.url ?? '').trim(),
      label: String(body.label ?? '').trim(),
    });
    return respond(c, {
      json: result,
      redirectTo: `/settings?playlist=${result.channels}`,
    });
  } catch (err) {
    return respond(c, {
      json: { error: err.message },
      status: 400,
      redirectTo: `/settings?playlist_error=${encodeURIComponent(err.message)}`,
    });
  }
});

app.post('/api/playlist/refresh', async (c) => {
  const user = requireUser(c);
  try {
    const result = await refreshPlaylist(user.id);
    return respond(c, { json: result, redirectTo: `/settings?playlist=${result.channels}` });
  } catch (err) {
    return respond(c, {
      json: { error: err.message },
      status: 400,
      redirectTo: `/settings?playlist_error=${encodeURIComponent(err.message)}`,
    });
  }
});

app.post('/api/playlist/delete', async (c) => {
  const user = requireUser(c);
  await q.deletePlaylist(user.id);
  return respond(c, { json: { deleted: true }, redirectTo: '/settings' });
});

/**
 * Hand one channel back to the person who supplied it.
 *
 * This is the entire playback story, and its smallness is the point: the reader's
 * own URL, returned to the reader's own browser, as a file their own player opens.
 * Nothing is proxied, so genrewatch is never in the path of the stream itself --
 * which also sidesteps the two walls a browser puts up, since an http:// source is
 * blocked as mixed content and a self-signed upstream certificate is rejected
 * outright. A desktop player has neither restriction.
 *
 * `no-store`, because the response body is a credential.
 */
app.get('/events/:id/playlist.m3u', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.notFound();

  const own = await ownChannelsForEvent({ userId: user.id, event });
  if (own.length === 0) return c.redirect(`/events/${event.id}`, 303);

  // The first match, which channelsForFixture has already ranked most-specific
  // first, unless the reader asked for a particular one by index.
  const wanted = Number(c.req.query('n') ?? 0);
  const pick = own[Number.isInteger(wanted) && own[wanted] ? wanted : 0];

  c.header('content-type', 'audio/x-mpegurl; charset=utf-8');
  c.header('content-disposition', `attachment; filename="${event.short_name ?? 'game'}.m3u"`);
  c.header('cache-control', 'no-store, private');
  return c.body(oneChannelM3u(pick));
});

/* -------------------------------------------------------------------- auth -- */

app.get('/login', async (c) =>
  c.html(await render(<SignIn mode="login" next={c.req.query('next')} />)),
);
app.get('/signup', async (c) =>
  c.html(await render(<SignIn mode="signup" next={c.req.query('next')} />)),
);

/**
 * Request a sign-in link.
 *
 * The answer is identical whether or not the address has an account, and a send
 * failure is reported as success too. Any difference here turns this endpoint into
 * a way to ask "is this person a user?".
 */
app.post('/api/auth/magic', async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? '')
    .trim()
    .toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    try {
      const url = await auth.createLoginLink(email);
      await sendLoginLink({ email, url });
    } catch (err) {
      console.error('[auth] link send failed:', err.message);
    }
  }
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json')) return c.json({ ok: true });
  return c.html(await render(<SignIn mode="login" sent />));
});

app.get('/auth/magic', async (c) => {
  const token = c.req.query('t');
  if (!token) return c.redirect('/login', 303);
  const result = await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') });
  if (!result) return c.html(await render(<SignIn mode="login" next="/following" />), 400);
  c.header('set-cookie', auth.sessionCookie(result.sessionId));
  return c.redirect(c.req.query('next') ?? '/following', 303);
});

app.post('/api/auth/logout', async (c) => {
  const sid = getCookie(c, config.session.cookie);
  if (sid) await q.endSession(sid);
  c.header('set-cookie', auth.sessionCookie('', { clear: true }));
  return respond(c, { redirectTo: '/' });
});

/* Passkey challenges live in Redis keyed by a short-lived cookie: a challenge is
   single-use state that must not be replayable and must not sit in a JWT. */
const challengeKey = (id) => `pk:challenge:${id}`;

async function stashChallenge(c, challenge) {
  const id = crypto.randomUUID();
  await connection.set(challengeKey(id), challenge, 'EX', 300);
  setCookie(c, 'tw_pk', id, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 300,
    secure: config.isProd,
  });
}

async function takeChallenge(c) {
  const id = getCookie(c, 'tw_pk');
  if (!id) return null;
  const val = await connection.get(challengeKey(id));
  await connection.del(challengeKey(id));
  return val;
}

app.post('/api/auth/passkey/register/options', async (c) => {
  const user = requireUser(c);
  const options = await auth.passkeyRegistrationOptions(user);
  await stashChallenge(c, options.challenge);
  return c.json(options);
});

app.post('/api/auth/passkey/register/verify', async (c) => {
  const user = requireUser(c);
  const expectedChallenge = await takeChallenge(c);
  if (!expectedChallenge) return c.json({ error: 'challenge expired' }, 400);
  const ok = await auth.verifyPasskeyRegistration({
    user,
    response: await c.req.json(),
    expectedChallenge,
  });
  return c.json({ ok }, ok ? 200 : 400);
});

app.post('/api/auth/passkey/authenticate/options', async (c) => {
  const options = await auth.passkeyAuthenticationOptions();
  await stashChallenge(c, options.challenge);
  return c.json(options);
});

app.post('/api/auth/passkey/authenticate/verify', async (c) => {
  const expectedChallenge = await takeChallenge(c);
  if (!expectedChallenge) return c.json({ error: 'challenge expired' }, 400);
  const result = await auth.verifyPasskeyAuthentication({
    response: await c.req.json(),
    expectedChallenge,
    userAgent: c.req.header('user-agent'),
  });
  if (!result) return c.json({ error: 'rejected' }, 400);
  c.header('set-cookie', auth.sessionCookie(result.sessionId));
  return c.json({ ok: true });
});

/* ----------------------------------------------------------------- follows -- */

for (const [path, fn] of [
  ['/api/follow', q.addFollow],
  ['/api/unfollow', q.removeFollow],
]) {
  app.post(path, async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    const subjectType = String(body.subject_type ?? '');
    const subjectId = Number(body.subject_id);
    if (!['team', 'league'].includes(subjectType) || !Number.isFinite(subjectId)) {
      return c.json({ error: 'bad subject' }, 400);
    }
    await fn({ userId: user.id, subjectType, subjectId });
    return respond(c, { redirectTo: String(body.next ?? '/following') });
  });
}

app.get('/api/teams/search', async (c) => {
  const term = (c.req.query('q') ?? '').trim();
  if (term.length < 2) return c.json({ results: [] });
  return c.json({ results: await q.searchTeams(term) });
});

/* ------------------------------------------------------------------- prefs -- */

app.post('/api/prefs', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody({ all: true });
  const arr = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  await q.savePrefs({
    userId: user.id,
    offsetsMinutes: arr(body.offsets)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
    channels: arr(body.channels)
      .map(String)
      .filter((s) => ['webpush', 'email'].includes(s)),
  });
  return respond(c, { redirectTo: '/settings' });
});

/**
 * Store the viewer's time zone.
 *
 * Only used for email, which is rendered server-side with no browser to ask. Pages
 * localise in the browser, so this is not what makes the site show the right times.
 * Accepts both the form post from settings and the automatic report from app.js.
 */
app.post('/api/timezone', async (c) => {
  const user = requireUser(c);
  const contentType = c.req.header('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody();
  const timezone = String(body.timezone ?? '').trim();

  // Validate against the platform's own zone database rather than a regex: an
  // invalid zone stored here would throw inside every reminder email later.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return c.json({ error: 'unknown time zone' }, 400);
  }

  await q.setUserTimezone(user.id, timezone);
  return respond(c, { redirectTo: '/settings' });
});

app.get('/settings', async (c) => {
  const user = requireUser(c);
  const [prefs, passkeys, playlist] = await Promise.all([
    q.getPrefs(user.id),
    q.listPasskeys(user.id),
    q.getPlaylist(user.id),
  ]);
  const added = c.req.query('playlist');
  const playlistNotice = added
    ? `Imported ${Number(added).toLocaleString('en-US')} channels.`
    : null;
  return c.html(
    await render(
      <Settings
        user={user}
        prefs={
          prefs ?? {
            offsets_minutes: config.reminders.defaultOffsets,
            channels: ['webpush', 'email'],
          }
        }
        passkeys={passkeys}
        playlist={playlist}
        playlistNotice={playlistNotice}
        playlistError={c.req.query('playlist_error') ?? null}
      />,
    ),
  );
});

/**
 * Notification self-check.
 *
 * Deliberately open to signed-out visitors: the failure it diagnoses happens in the
 * browser, before anything is saved, so requiring an account only adds a step
 * between someone and the answer.
 */
app.get('/push-check', (c) =>
  c.html(render(<PushCheck user={c.get('user')} vapidKey={config.push.publicKey} />)),
);

/**
 * Where the self-check reports to.
 *
 * Logged, never stored: the point is that a support conversation can start from what
 * the browser actually did rather than from a screenshot. Bounded because anything
 * a browser can post unauthenticated can be posted a million times.
 */
app.post('/api/push/diag', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const trimmed = JSON.stringify(body).slice(0, 600);
  console.log('[push-diag]', trimmed);
  return c.json({ ok: true });
});

app.post('/api/push/subscribe', async (c) => {
  const user = requireUser(c);
  const sub = await c.req.json();
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return c.json({ error: 'malformed subscription' }, 400);
  }
  await q.savePushSubscription({
    userId: user.id,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
  });
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (c) => {
  const user = requireUser(c);
  const body = await c.req.json().catch(() => ({}));
  if (!body?.endpoint) return c.json({ error: 'endpoint required' }, 400);
  await q.deletePushSubscription({ userId: user.id, endpoint: body.endpoint });
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- payments -- */

app.post('/api/events/:id/buy', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.json({ error: 'no such event' }, 404);

  const body = await c.req.parseBody();
  const [offer] = (await pay.offersForEvent(event.id)).filter(
    (o) => o.id === Number(body.offer_id),
  );
  if (!offer) return c.json({ error: 'offer unavailable' }, 409);

  const checkoutUrl = await pay.createCheckout({ user, event, offer });
  return respond(c, { json: { checkoutUrl }, redirectTo: checkoutUrl });
});

/**
 * CoinPay webhook. Signature is over the RAW bytes, so the body is read as text
 * before anything parses it -- re-serialising the JSON changes the bytes and the
 * signature stops matching.
 */
app.post('/api/webhooks/coinpay', async (c) => {
  const raw = await c.req.text();
  const ok = pay.verifyWebhook({
    rawBody: raw,
    signatureHeader: c.req.header('coinpay-signature') ?? c.req.header('x-coinpay-signature'),
  });
  if (!ok) return c.json({ error: 'bad signature' }, 401);

  const result = await pay.grantFromWebhook(JSON.parse(raw));
  return c.json(result);
});

/* -------------------------------------------------------------- public API -- */

/**
 * Free, unauthenticated, documented at its own root.
 *
 * The calendar is public data we already hold; making it readable by a script costs
 * nothing and is the cheapest distribution this app has. Every response is bounded
 * and cacheable.
 */
app.get('/api/v1', async (c) => {
  const stats = await q.catalogueStats();
  return c.json({
    name: 'GenreWatch API',
    version: 1,
    documentation: `${config.siteUrl}/api/v1`,
    license: 'Free to use, no key required. Be reasonable.',
    catalogue: stats,
    endpoints: {
      'GET /api/v1/sports': 'Every sport, with league counts.',
      'GET /api/v1/leagues?sport=soccer': 'Leagues, optionally filtered by sport.',
      'GET /api/v1/events?league=soccer-eng-1&sport=soccer&limit=100':
        'Upcoming fixtures. Both filters optional; limit caps at 200.',
    },
  });
});

app.get('/api/v1/sports', async (c) => {
  c.header('cache-control', 'public, max-age=300');
  return c.json({ sports: await q.listSports() });
});

app.get('/api/v1/leagues', async (c) => {
  const leagues = await q.listLeagues({ sport: c.req.query('sport') ?? null, limit: 1000 });
  c.header('cache-control', 'public, max-age=300');
  return c.json({
    leagues: leagues.map((l) => ({
      slug: l.slug,
      name: l.name,
      sport: l.sport,
      abbreviation: l.abbreviation,
      logo: l.logo_url,
    })),
  });
});

app.get('/api/v1/events', async (c) => {
  const events = await q.publicEvents({
    leagueSlug: c.req.query('league') ?? null,
    sport: c.req.query('sport') ?? null,
    limit: c.req.query('limit') ?? 100,
  });
  c.header('cache-control', 'public, max-age=60');
  return c.json({ count: events.length, events });
});

app.get('/about', async (c) => {
  const stats = await q.catalogueStats();
  return c.html(await render(<About user={c.get('user')} stats={stats} />));
});

/* --------------------------------------------------------------- comments -- */

/** Enough to say something, not enough to paste an essay. */
const COMMENT_MAX = 2000;
/** Per minute. Generous for a conversation, hostile to a script. */
const COMMENT_RATE = 6;

app.post('/api/events/:id/comments', async (c) => {
  const user = requireUser(c);
  const eventId = Number(c.req.param('id'));
  if (!Number.isFinite(eventId)) return c.json({ error: 'bad event' }, 400);

  const body = await c.req.parseBody();
  const text = String(body.body ?? '').trim();
  if (!text) return c.json({ error: 'Say something first.' }, 400);
  if (text.length > COMMENT_MAX) {
    return c.json({ error: `Keep it under ${COMMENT_MAX} characters.` }, 400);
  }

  // Checked against the database rather than memory: the limit has to survive a
  // redeploy and apply across every instance, not per-process.
  if ((await q.recentCommentCount(user.id)) >= COMMENT_RATE) {
    return c.json({ error: 'Slow down a moment.' }, 429);
  }

  await q.insertComment({ eventId, userId: user.id, body: text });
  return respond(c, { redirectTo: `/events/${eventId}#comments` });
});

app.post('/api/comments/:id/delete', async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param('id'));
  // Scoped to the author in the query, so a guessed id deletes nothing.
  await q.deleteComment({ commentId: id, userId: user.id });
  return respond(c, { redirectTo: c.req.header('referer') ?? '/' });
});

/* ------------------------------------------------------------ calendar --- */

/**
 * Calendar subscriptions.
 *
 * Calendar clients poll a URL on a schedule with no cookies, so the URL itself
 * carries the authority: a per-user token, separate from the session so it can be
 * rotated without signing anyone out.
 *
 * The path uses a plain param validated in the handler rather than an inline
 * pattern -- Hono's brace syntax swallows a {n} quantifier and the route then
 * silently never matches.
 */
app.get('/calendar/me/:file', async (c) => {
  const m = /^([0-9a-f-]{36})\.ics$/i.exec(c.req.param('file'));
  if (!m) return c.notFound();

  const user = await q.userByCalendarToken(m[1]);
  // Deliberately identical to a bad token: a 401 here would confirm which tokens
  // exist to anyone enumerating them.
  if (!user) return c.notFound();

  const events = await q.upcomingForUser(user.id, { limit: 200 });
  c.header('content-type', 'text/calendar; charset=utf-8');
  c.header('cache-control', 'private, max-age=300');
  c.header('content-disposition', 'inline; filename="genrewatch.ics"');
  return c.body(buildCalendar(events, { name: 'GenreWatch — my games', siteUrl: config.siteUrl }));
});

/** A whole league's fixtures, public and shareable. */
app.get('/calendar/league/:file', async (c) => {
  const m = /^([a-z0-9._-]+)\.ics$/i.exec(c.req.param('file'));
  if (!m) return c.notFound();
  const league = await q.getLeagueBySlug(m[1]);
  if (!league) return c.notFound();

  const events = await q.upcomingForLeague(league.id, { limit: 200 });
  c.header('content-type', 'text/calendar; charset=utf-8');
  c.header('cache-control', 'public, max-age=900');
  return c.body(
    buildCalendar(events, { name: `GenreWatch — ${league.name}`, siteUrl: config.siteUrl }),
  );
});

/** Rotating invalidates every calendar URL already handed out. */
app.post('/api/calendar/rotate', async (c) => {
  const user = requireUser(c);
  await q.rotateCalendarToken(user.id);
  return respond(c, { redirectTo: '/following' });
});

/* ---------------------------------------------------------------- feeds -- */

const feedHeaders = (c, seconds) => {
  c.header('content-type', 'application/rss+xml; charset=utf-8');
  c.header('cache-control', `public, max-age=${seconds}`);
};

app.get('/feeds/all.xml', async (c) => {
  const events = await q.feedEvents({ limit: 150 });
  feedHeaders(c, 300);
  return c.body(
    buildFeed(events, {
      title: 'GenreWatch — every sport',
      description: 'Upcoming fixtures across 354 leagues and 17 sports.',
      feedUrl: `${config.siteUrl}/feeds/all.xml`,
      siteUrl: config.siteUrl,
    }),
  );
});

/**
 * One route for sport, league and team feeds.
 *
 * Separate routes would be three near-identical handlers; the scope is validated
 * against a fixed set so the path cannot select an arbitrary column.
 */
app.get('/feeds/:scope/:file', async (c) => {
  const scope = c.req.param('scope');
  const m = /^([a-z0-9._-]+)\.xml$/i.exec(c.req.param('file'));
  if (!m || !['sport', 'league', 'team'].includes(scope)) return c.notFound();
  const key = m[1];

  const events = await q.feedEvents({
    sport: scope === 'sport' ? key : null,
    leagueSlug: scope === 'league' ? key : null,
    teamSlug: scope === 'team' ? key : null,
    limit: 150,
  });
  // An empty feed for a name nobody publishes is a 404, not a valid empty channel.
  if (events.length === 0) return c.notFound();

  const label =
    scope === 'league'
      ? (events[0].league_name ?? key)
      : scope === 'team'
        ? key.replace(/-/g, ' ')
        : key.replace(/-/g, ' ');

  feedHeaders(c, 300);
  return c.body(
    buildFeed(events, {
      title: `GenreWatch — ${label}`,
      description: `Upcoming fixtures for ${label}.`,
      feedUrl: `${config.siteUrl}/feeds/${scope}/${key}.xml`,
      siteUrl: config.siteUrl,
      link: scope === 'league' ? `${config.siteUrl}/leagues/${key}` : config.siteUrl,
    }),
  );
});

app.get('/feeds', async (c) =>
  cached(c, 'page:feeds', 900, async () => {
    const [sports, leagues] = await Promise.all([q.listSports(), q.leaguesWithUpcoming(120)]);
    return render(<Feeds user={c.get('user')} sports={sports} leagues={leagues} />);
  }),
);

/* ---------------------------------------------------------------- sitemaps -- */

/**
 * A sitemap index, not one file.
 *
 * The house pattern: chunks are keyed by month because a past month is immutable,
 * so a crawler can skip it on <lastmod> alone. Chunking by position instead would
 * shift every URL into a different file the moment one fixture is added, and every
 * chunk would look changed on every crawl.
 */
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
const iso = (d) => new Date(d).toISOString();

app.get('/sitemap.xml', async (c) => {
  const months = await q.eventMonths();
  const urls = [
    `<sitemap><loc>${config.siteUrl}/sitemaps/static.xml</loc></sitemap>`,
    `<sitemap><loc>${config.siteUrl}/sitemaps/leagues.xml</loc></sitemap>`,
    `<sitemap><loc>${config.siteUrl}/sitemaps/feeds.xml</loc></sitemap>`,
    ...months.map(
      (m) =>
        `<sitemap><loc>${config.siteUrl}/sitemaps/events-${m.month}.xml</loc>` +
        (m.lastmod ? `<lastmod>${iso(m.lastmod)}</lastmod>` : '') +
        '</sitemap>',
    ),
  ];
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</sitemapindex>`,
  );
});

app.get('/sitemaps/static.xml', (c) => {
  const paths = ['/', '/sports', '/about', '/login', '/signup'];
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
      .map(
        (p) =>
          `<url><loc>${config.siteUrl}${p}</loc><changefreq>${p === '/' ? 'hourly' : 'weekly'}</changefreq><priority>${p === '/' ? '1.0' : '0.6'}</priority></url>`,
      )
      .join('')}</urlset>`,
  );
});

/**
 * Feeds are the distribution surface, so a crawler should find them as pages
 * rather than stumble on them.
 */
app.get('/sitemaps/feeds.xml', async (c) => {
  const [sports, leagues] = await Promise.all([q.listSports(), q.leaguesWithUpcoming(400)]);
  const urls = [
    '/feeds',
    '/feeds/all.xml',
    ...sports.map((s) => `/feeds/sport/${s.sport}.xml`),
    ...leagues.map((l) => `/feeds/league/${l.slug}.xml`),
  ];
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map((u) => `<url><loc>${config.siteUrl}${u}</loc><changefreq>hourly</changefreq></url>`)
      .join('')}</urlset>`,
  );
});

app.get('/sitemaps/leagues.xml', async (c) => {
  const leagues = await q.listLeagues({ limit: 1000 });
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${leagues
      .map(
        (l) =>
          `<url><loc>${config.siteUrl}/leagues/${l.slug}</loc><changefreq>daily</changefreq></url>`,
      )
      .join('')}</urlset>`,
  );
});

// One plain param rather than a regex route: Hono's inline pattern syntax uses braces
// for the constraint, so a {4} quantifier inside it terminates the pattern early and
// the route silently never matches. Validating in the handler is unambiguous.
app.get('/sitemaps/:file', async (c) => {
  const file = c.req.param('file');
  const m = /^events-(\d{4}-\d{2})\.xml$/.exec(file);
  if (!m) return c.notFound();

  const events = await q.eventsForMonth(m[1]);
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${events
      .map(
        (e) =>
          `<url><loc>${config.siteUrl}/events/${e.id}</loc><lastmod>${iso(e.updated_at)}</lastmod></url>`,
      )
      .join('')}</urlset>`,
  );
});

/* ------------------------------------------------------------------ static -- */

/**
 * Colours track the stylesheet's ground, not the generator's white default -- an
 * installed PWA whose splash is white flashes bright before a dark app paints.
 */
app.get('/manifest.webmanifest', (c) =>
  c.json({
    name: 'GenreWatch',
    short_name: 'Tipoff',
    description: 'Follow any team in the world and get told before they play.',
    start_url: '/following',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#12161f',
    theme_color: '#12161f',
    icons: [
      { src: '/icons/icon-48x48.png', sizes: '48x48', type: 'image/png' },
      { src: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
      {
        src: '/icons/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      { src: '/icons/icon-256x256.png', sizes: '256x256', type: 'image/png' },
      { src: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
      {
        src: '/icons/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }),
);

app.get('/robots.txt', (c) =>
  c.text(`User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}/sitemap.xml\n`),
);

const STATIC_FILES = [
  ['/styles.css', 'styles.css', 'text/css'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/push-check.js', 'push-check.js', 'text/javascript'],
  ['/vendor-webauthn.js', 'vendor-webauthn.js', 'text/javascript'],
  ['/sw.js', 'sw.js', 'text/javascript'],
  ['/logo.png', 'logo.png', 'image/png'],
];

// Hashed once at boot so pages can link /styles.css?v=<hash>. See lib/asset-version.js.
await loadAssetVersions(STATIC_FILES.map(([, file]) => file));

for (const [route, file, type] of STATIC_FILES) {
  app.get(route, async (c) => {
    const f = Bun.file(new URL(`../public/${file}`, import.meta.url).pathname);
    c.header('content-type', type);
    if (file === 'sw.js') {
      // The service worker must never be served stale or a bad version pins itself.
      c.header('cache-control', 'no-cache');
    } else if (isCurrentVersion(file, c.req.query('v'))) {
      // The URL carries the content hash, so these bytes can never change under
      // it — a new build is a new URL. Safe to cache hard.
      c.header('cache-control', 'public, max-age=31536000, immutable');
    } else {
      // An unversioned (or stale-versioned) request: someone's cached HTML, or a
      // direct hit. Keep it short so they pick up the next deploy quickly.
      c.header('cache-control', 'public, max-age=60, must-revalidate');
    }
    return c.body(await f.arrayBuffer());
  });
}

/**
 * The generated icon set.
 *
 * A directory route rather than seventeen literal ones. The filename is matched
 * against a strict pattern instead of being joined onto a path: `/icons/..%2f..`
 * would otherwise walk out of public/ and serve anything the process can read.
 */
const ICON_TYPES = { png: 'image/png', ico: 'image/x-icon', xml: 'application/xml' };

app.get('/icons/:file', async (c) => {
  const file = c.req.param('file');
  if (!/^[a-z0-9][a-z0-9._-]*\.(png|ico|xml)$/i.test(file) || file.includes('..')) {
    return c.notFound();
  }
  const f = Bun.file(new URL(`../public/icons/${file}`, import.meta.url).pathname);
  if (!(await f.exists())) return c.notFound();
  c.header(
    'content-type',
    ICON_TYPES[file.split('.').pop().toLowerCase()] ?? 'application/octet-stream',
  );
  // Icons are content-addressed by size and effectively immutable.
  c.header('cache-control', 'public, max-age=604800');
  return c.body(await f.arrayBuffer());
});

/** Browsers request this at the root regardless of what the markup declares. */
app.get('/favicon.ico', async (c) => {
  const f = Bun.file(new URL('../public/icons/favicon.ico', import.meta.url).pathname);
  c.header('content-type', 'image/x-icon');
  c.header('cache-control', 'public, max-age=604800');
  return c.body(await f.arrayBuffer());
});

app.notFound(async (c) => c.html(await render(<NotFound user={c.get('user')} />), 404));
