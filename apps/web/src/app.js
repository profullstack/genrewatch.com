import * as auth from '@genre/auth';
import {
  CATEGORIES,
  channelsForTitle,
  EXTERNAL_CATEGORIES,
  oneChannelM3u,
  searchEverything,
  searchWithFallthrough,
} from '@genre/catalog';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { sendInviteEmail, sendLoginLink } from '@genre/notify';
import * as pay from '@genre/payments';
import * as member from '@genre/payments/membership';
import {
  claimStreamSlot,
  firstLiveChannel,
  importPlaylist,
  maskPlaylistUrl,
  openStream,
  ownChannelsForEvent,
  ownChannelsForSubject,
  playlistSource,
  probeStream,
  refreshPlaylist,
  sharedChannelsForEvent,
  sharedChannelsForSubject,
  streamSlotsOpen,
  verdictToStore,
} from '@genre/playlists';
import { connection } from '@genre/queue';
import { createGateway } from '@profullstack/x402-gateway';
import { x402Gateway } from '@profullstack/x402-gateway/hono';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { assetUrl, isCurrentVersion, loadAssetVersions } from './lib/asset-version.js';
import { attempt, callerAddress, forgive, MISS, VIEW } from './lib/auth-throttle.js';
import { buildCalendar } from './lib/ics.js';
import { robotsTxt } from './lib/robots.js';
import { buildFeed } from './lib/rss.js';
import { Feeds } from './views/feeds.jsx';
import {
  About,
  CategoryPage,
  Channels,
  EventPage,
  Following,
  GenrePage,
  GenresIndex,
  Invite,
  Landing,
  NotFound,
  ProfilePage,
  PushCheck,
  SearchPage,
  Settings,
  SharedLists,
  SignIn,
  SubjectPage,
} from './views/pages.jsx';
import { Inbox, Thread } from './views/people.jsx';
import { PremiumPage } from './views/premium.jsx';

export const app = new Hono();

/* ----------------------------------------------------------------- helpers -- */

/**
 * Which of these titles are already in the reader's own channel list.
 *
 * Matched by name against their own entries, and only ever for the account that
 * supplied them. Returns a Set of subject ids so a template can ask cheaply.
 */
async function ownedTitles({ userId, results }) {
  const none = new Set();
  if (!userId || !results?.length || !config.playlists.enabled) return none;

  const rows = await q.playlistChannels(userId);
  if (rows.length === 0) return none;

  const channels = rows.map((r) => ({ title: r.title, url: r.stream_url, kind: r.kind }));
  const owned = new Set();
  for (const r of results) {
    const hit = channelsForTitle(channels, { title: r.display_name });
    if (hit.length > 0) owned.add(r.id);
  }
  return owned;
}

/**
 * Answer the caller in its own language.
 *
 * Every control on the site is a plain form, so the browser gets a 303 back to
 * where it came from and the page works with JavaScript off. A caller that asked
 * for JSON gets JSON. One helper, so the two can never drift apart.
 */
/**
 * Is this account a member right now?
 *
 * One function, called by every gate, so the features premium sells cannot drift
 * apart in what they consider a member. It reads the terms table rather than a
 * flag on the account: there is no `users.is_premium` to fall out of step with
 * what was actually paid for.
 */
async function isMember(user) {
  if (!user?.id) return false;
  return Boolean(await q.activeMembership(user.id));
}

/**
 * How far back this reader may read their own messages, in days.
 *
 * Null means "all of it". The window is a product decision and it is made HERE,
 * once, rather than inside the query -- which stays a query with a parameter
 * instead of one that knows about money.
 */
function historyWindowDays(member) {
  if (member) return null;
  const days = config.membership.freeMessageHistoryDays;
  return days > 0 ? days : null;
}

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

/**
 * Crawlers that are not welcome here at all.
 *
 * AwarioBot was 47% of all requests to tipoffwatch, fetching /login about once a
 * second from a single address. It was told to stop in robots.txt, re-read that
 * file, and carried on -- so being polite about it is finished. It is a
 * brand-monitoring crawler: it sends nobody here and there is nothing on this
 * site it needs.
 *
 * Matched on the user agent, which a determined caller can lie about. That is
 * fine, and worth being clear about: this is here to stop a self-identifying bot
 * that is merely rude, not to stop somebody hostile. Anything that lies its way
 * past this still meets the backoff below.
 *
 * 403 rather than 429, because there is no wait that would make this allowed.
 */
const BLOCKED_AGENTS = ['awariobot'];

app.use('*', async (c, next) => {
  const ua = (c.req.header('user-agent') ?? '').toLowerCase();
  if (BLOCKED_AGENTS.some((bot) => ua.includes(bot))) {
    return c.text('Not available to this crawler.', 403);
  }
  return next();
});

/*
 * Crawlers that may come in, for a price.
 *
 * Search and retrieval crawlers read the site free, the same as people: they
 * send readers back. A TRAINING crawler copies pages into a corpus and sends
 * nobody back, and here Meta's alone was 30,000 to 49,000 hits a day, more
 * than 95% of all traffic. robots.txt (lib/robots.js) asks those to stay out;
 * this is what happens when they come in anyway: every page answers 402 with
 * an x402 offer, or the sales page at /crawl, and paying it buys a signed pass
 * for a day.
 *
 * After the outright block above -- a crawler refused everywhere is not sold
 * anything -- and before the session lookup, which a 402 does not need. With
 * no COINPAY_X402_KEY or CRAWL_PAY_TO the gateway still answers 402, with an
 * empty offer: nothing is sold, but nothing is given away either.
 */
const crawlGateway = createGateway({
  siteUrl: config.siteUrl,
  siteName: 'GenreWatch',
  coinpay: { apiKey: config.coinpay.x402Key, baseUrl: config.coinpay.baseUrl },
  payTo: config.crawl.payTo,
  priceCents: config.crawl.priceCents,
  currency: config.crawl.currency,
  passMinutes: config.crawl.passMinutes,
  contact: `${config.siteUrl}/contact`,
});
app.use('*', x402Gateway(crawlGateway));

app.use('*', async (c, next) => {
  const sid = getCookie(c, config.session.cookie);
  const user = sid ? await auth.userFromRequest(sid) : null;
  /*
   * The unread count rides on the user, set once here.
   *
   * The header shows it on every page, so the alternative is every render call
   * remembering to pass it -- and the one route that forgets shows a reader zero
   * unread messages while they have some, which is indistinguishable from the
   * feature not working.
   */
  if (user) user.unread = await q.unreadMessageCount(user.id);
  c.set('user', user);
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

/**
 * Sports is a link, not a section.
 *
 * tipoffwatch.com already does fixtures, live scores and per-market broadcast
 * listings properly, and a thin second copy here would be worse than a signpost.
 * The redirect is 302 rather than 301 on purpose: a permanent redirect is cached
 * by browsers more or less forever, so choosing to serve sports here later would
 * mean every existing reader still bouncing away.
 */
for (const [name, target] of Object.entries(EXTERNAL_CATEGORIES)) {
  app.get(`/${name}`, (c) => c.redirect(target, 302));
  app.get(`/categories/${name}`, (c) => c.redirect(target, 302));
}

/** Every genre we carry, grouped by the medium it belongs to. */
app.get('/genres', async (c) => {
  const user = c.get('user');
  // Signed out this is byte-identical and cached; signed in it carries their own
  // follow counts, and cached() already declines to store a signed-in render.
  const [counts, upcoming] = user
    ? await Promise.all([q.genreFollowCounts(user.id), q.upcomingEventCount()])
    : [null, null];

  /*
   * Sixty seconds, down from five minutes, and the soon list is the reason.
   *
   * Genres change about never, so five minutes was free. A four-hour window is
   * not: it moves by a minute in a minute, and the tail of it is the part anybody
   * is reading. Sixty seconds is what the sibling brand settled on for the same
   * list for the same reason.
   */
  return cached(c, 'page:genres', 60, async () => {
    const [categories, genres, soon, soonTotal] = await Promise.all([
      q.listCategories(),
      q.listGenres({}),
      q.outSoon({ hours: config.catalog.soonWindowHours, viewerId: user?.id ?? null }),
      q.outSoonCount({ hours: config.catalog.soonWindowHours }),
    ]);
    return render(
      <GenresIndex
        user={user}
        categories={categories}
        genres={genres}
        genreCounts={counts}
        upcoming={upcoming}
        soon={soon}
        soonTotal={soonTotal}
        soonHours={config.catalog.soonWindowHours}
      />,
    );
  });
});

/**
 * Follow every genre at once, and the undo beside it.
 *
 * Deliberately genres only. Following a name was a decision made one at a time and
 * this must not sweep it away -- the undo for "follow everything" is "stop
 * following everything", not "forget what I picked".
 */
app.post('/api/follow-all', async (c) => {
  const user = requireUser(c);
  const added = await q.followAllGenres(user.id);
  return respond(c, { json: { added }, redirectTo: `/genres?followed=${added}` });
});

app.post('/api/unfollow-all', async (c) => {
  const user = requireUser(c);
  const removed = await q.unfollowAllGenres(user.id);
  return respond(c, { json: { removed }, redirectTo: `/genres?unfollowed=${removed}` });
});

app.get('/categories/:name', async (c) => {
  const user = c.get('user');
  const name = c.req.param('name');
  if (!CATEGORIES.includes(name)) return c.html(await render(<NotFound user={user} />), 404);

  return cached(c, `page:category:${name}`, 300, async () => {
    const [genres, events] = await Promise.all([
      q.listGenres({ category: name }),
      q.scheduleForDay({
        day: new Date().toISOString().slice(0, 10),
        category: name,
        limit: 40,
      }),
    ]);
    return render(<CategoryPage user={user} category={name} genres={genres} events={events} />);
  });
});

app.get('/genres/:slug', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const genre = await q.getGenreBySlug(slug);
  if (!genre) return c.html(await render(<NotFound user={user} />), 404);

  return cached(c, `page:genre:${slug}`, config.cache.scheduleTtlSeconds, async () => {
    const [subjects, events, following] = await Promise.all([
      q.subjectsForGenre(genre.id, { viewerId: user?.id ?? null }),
      q.upcomingForGenre(genre.id, { viewerId: user?.id ?? null }),
      q.isFollowing({ userId: user?.id, subjectType: 'genre', subjectId: genre.id }),
    ]);
    return render(
      <GenrePage
        user={user}
        genre={genre}
        subjects={subjects}
        events={events}
        following={following}
      />,
    );
  });
});

app.get('/subjects/:slug', async (c) => {
  const user = c.get('user');
  const subject = await q.getSubjectBySlug(c.req.param('slug'));
  if (!subject) return c.html(await render(<NotFound user={user} />), 404);

  const [events, past, genres, following] = await Promise.all([
    q.upcomingForSubject(subject.id, { viewerId: user?.id ?? null }),
    // Without this a back-catalogue title is a dead end: a 2022 film has no
    // upcoming event, so the page a reader reached by searching for something to
    // watch said "Nothing scheduled" and offered nowhere to go.
    q.pastForSubject(subject.id, { viewerId: user?.id ?? null }),
    q.genresForSubject(subject.id),
    q.isFollowing({ userId: user?.id, subjectType: 'subject', subjectId: subject.id }),
  ]);

  /*
   * The reader's own list, matched against THIS title.
   *
   * The whole reason this page exists for somebody who searched for a film is to
   * answer "can I watch it", and it never asked. Matching only ever ran on event
   * pages -- so a title with no upcoming event could never be checked against a
   * list at all, which reads exactly like a provider that does not carry it.
   *
   * Per-viewer, and safe only because this page is not one of the cached() ones.
   */
  const [ownChannels, sharedChannels] = await Promise.all([
    ownChannelsForSubject({ userId: user?.id, subject, genreName: genres[0]?.name ?? null }),
    sharedChannelsForSubject({
      viewerId: user?.id ?? null,
      subject,
      genreName: genres[0]?.name ?? null,
    }),
  ]);

  return c.html(
    await render(
      <SubjectPage
        user={user}
        subject={subject}
        events={events}
        past={past}
        genres={genres}
        following={following}
        ownChannels={ownChannels}
        sharedChannels={sharedChannels}
      />,
    ),
  );
});

/**
 * Search, across everything -- including what already came out.
 *
 * Every other read here filters to the future, which is right for a calendar and
 * useless for someone with a subscription asking "do you have this". So this one
 * has no date filter at all, and falls through to the provider for the roughly
 * one million films the local catalogue does not hold.
 *
 * Not cached: it is per-query, and for a signed-in reader it also carries whether
 * each result is in their own channel list, which must never be served to anyone
 * else.
 */
app.get('/search', async (c) => {
  const user = c.get('user');
  const term = (c.req.query('q') ?? '').trim();
  const category = CATEGORIES.includes(c.req.query('category')) ? c.req.query('category') : null;

  const results = await searchEverything(term, { userId: user?.id, category });
  // Whether the reader already has each of these, which is the whole point of
  // searching a back catalogue.
  const owned = await ownedTitles({ userId: user?.id, results: results.subjects });

  return c.html(
    await render(
      <SearchPage user={user} term={term} category={category} results={results} owned={owned} />,
    ),
  );
});

app.get('/api/v1/search', async (c) => {
  const term = (c.req.query('q') ?? '').trim();
  if (term.length < 2) return c.json({ error: 'q must be at least 2 characters' }, 400);
  const category = CATEGORIES.includes(c.req.query('category')) ? c.req.query('category') : null;
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 50);

  const results = (await searchWithFallthrough(term, { category, limit })).slice(0, limit);
  /*
   * Subjects only, deliberately.
   *
   * The header box searches five sources including the caller's OWN channel list,
   * and this endpoint is public, cached and unauthenticated. Widening it to match
   * the page would either serve one reader's private list from a shared cache or
   * quietly return nothing for the sources that need a session -- both worse than
   * an endpoint that says what it covers.
   */
  const genres = await q.searchGenres(term, { category });
  c.header('cache-control', 'public, max-age=60');
  return c.json({
    query: term,
    count: results.length,
    results: results.map((r) => ({
      slug: r.slug,
      name: r.display_name,
      category: r.category,
      kind: r.kind,
      image: r.image_url,
      released: r.starts_at ?? null,
      upcoming: r.upcoming > 0,
      url: `${config.siteUrl}/subjects/${r.slug}`,
    })),
    genres: genres.map((g) => ({
      slug: g.slug,
      name: g.name,
      category: g.category,
      upcoming: g.upcoming,
      url: `${config.siteUrl}/genres/${g.slug}`,
    })),
  });
});

app.get('/following', async (c) => {
  const user = requireUser(c);
  const [events, follows] = await Promise.all([q.upcomingForUser(user.id), q.listFollows(user.id)]);
  // What the last clear removed, if that is how we got here. Read back off the query
  // string rather than held in a session: the redirect is the only thing carrying it,
  // and a stale flash on a reload is worse than none.
  const cleared = c.req.query('cleared')
    ? {
        removed: Number(c.req.query('cleared')) || 0,
        subjects: Number(c.req.query('subjects')) || 0,
        genres: Number(c.req.query('genres')) || 0,
      }
    : null;
  return c.html(
    await render(
      <Following
        user={user}
        events={events}
        follows={follows}
        cleared={cleared}
        vapidKey={config.push.publicKey}
        calendarUrl={`${config.siteUrl}/calendar/me/${user.calendar_token}.ics`}
      />,
    ),
  );
});

/**
 * Clear the whole follow list, from the calendar page.
 *
 * Sibling of /api/unfollow-all, and not a duplicate of it: that one is the undo for
 * the follow-everything button and spares hand-picked names on purpose. This one is
 * pressed while looking at the list it empties, so it takes the names too --
 * clearing half of what is on screen is the behaviour that would surprise. The
 * counts come back so the page can say what went, rather than leaving someone to
 * work out from an empty list whether their names were included.
 */
app.post('/api/unfollow-everything', async (c) => {
  const user = requireUser(c);
  const result = await q.unfollowAll(user.id);
  return respond(c, {
    json: result,
    redirectTo: `/following?cleared=${result.removed}&subjects=${result.subjects}&genres=${result.genres}`,
  });
});

app.get('/events/:id', async (c) => {
  const user = c.get('user');
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.html(await render(<NotFound user={user} />), 404);

  const [genres, comments, following] = await Promise.all([
    q.genresForEvent(event.id),
    q.commentsForEvent(event.id),
    q.isFollowing({ userId: user?.id, subjectType: 'subject', subjectId: event.subject_id }),
  ]);

  /*
   * Per-viewer, and safe only because this page is NOT one of the cached() ones.
   *
   * If it is ever put behind Redis, this has to move out or one reader's channel
   * list -- credentials and all -- is served to the next visitor.
   */
  const [ownChannels, sharedChannels] = await Promise.all([
    ownChannelsForEvent({ userId: user?.id, event }),
    // Other people's open lists. Signed-in only, and it returns no URLs at all --
    // a shared entry is playable through the proxy and nowhere else, because
    // every other route hands over the address and the address is the owner's
    // provider password.
    sharedChannelsForEvent({ viewerId: user?.id ?? null, event }),
  ]);

  return c.html(
    await render(
      <EventPage
        user={user}
        event={event}
        genres={genres}
        comments={comments}
        following={following}
        ownChannels={ownChannels}
        sharedChannels={sharedChannels}
        streamDead={c.req.query('stream_dead') ?? null}
      />,
    ),
  );
});

/**
 * A reader's own channel list, browsed by the provider's own groups.
 *
 * This is the m3u's genre index, and it is per-account by construction: every
 * query is scoped to the signed-in user's rows, nothing is pooled across accounts
 * and nothing is relayed. What a provider calls "Movies | Horror" stays exactly
 * that rather than being mapped onto our genres -- a confident wrong mapping is
 * worse than the raw string the reader already sees in their own player.
 */
app.get('/my/channels', async (c) => {
  const user = requireUser(c);
  const [playlist, groups, kinds] = await Promise.all([
    q.getPlaylist(user.id),
    q.playlistGroups(user.id),
    // "Does my provider actually carry films" had no answer anywhere on the site,
    // so a reader whose list is all live channels concluded the matching was
    // broken. It is one group-by.
    q.playlistKindCounts(user.id),
  ]);
  return c.html(
    await render(<Channels user={user} playlist={playlist} groups={groups} kinds={kinds} />),
  );
});

/* --------------------------------------------------------- own playlists -- */

/**
 * A reader's own channel list.
 *
 * Every route here is behind requireUser and scoped to that user's rows. The list
 * is theirs: it is never pooled, never shown to another account, and never joined
 * to stream_offers -- this is a personal player feature, not a distribution one.
 */
/**
 * Where an import lands.
 *
 * `channels` is null when the provider's file hashed the same as last time, which
 * is the common case for a save that only changed the name. Passing that straight
 * into the notice produced "Imported NaN channels", so the two outcomes are named
 * separately here rather than counted.
 */
function playlistNoticeFor(result) {
  if (result?.renamed) return '/settings?playlist=renamed';
  if (result?.unchanged || result?.channels == null) return '/settings?playlist=unchanged';
  return `/settings?playlist=${result.channels}`;
}

/**
 * Add a list, or edit the one already stored.
 *
 * One route for both, because from the reader's side it is one form. Leaving the
 * address blank when a list exists means "keep it" -- that is what makes renaming
 * possible without re-typing a URL that has a password in it, which was the only
 * way to change anything here before.
 *
 * Re-submitting the SAME address is a save, not a re-import: the stored content
 * hash goes with it, so an unchanged provider file leaves every channel row (and
 * their probe verdicts) alone instead of deleting and reinserting them.
 */
app.post('/api/playlist', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const url = String(body.url ?? '').trim();
  const label = String(body.label ?? '').trim();

  try {
    const existing = await q.getPlaylist(user.id);

    if (!url) {
      if (!existing) throw new Error('Add the address of your playlist.');
      const row = await q.renamePlaylist({ userId: user.id, label: label || existing.label });
      return respond(c, {
        json: { renamed: true, label: row?.label ?? null },
        redirectTo: playlistNoticeFor({ renamed: true }),
      });
    }

    const same = existing ? auth.open(existing.source_url) === url : false;
    const result = await importPlaylist({
      userId: user.id,
      url,
      label,
      knownHash: same ? (existing.content_hash ?? null) : null,
    });
    return respond(c, { json: result, redirectTo: playlistNoticeFor(result) });
  } catch (err) {
    return respond(c, {
      json: { error: err.message },
      status: 400,
      redirectTo: `/settings?playlist_error=${encodeURIComponent(err.message)}`,
    });
  }
});

/**
 * Hand the stored address back to the account that stored it.
 *
 * `no-store` and JSON-only, because the body is a credential: it must not be
 * written into the cached settings page, and it must not sit in a back-forward
 * cache. Reaching it takes a session, and it answers with that session's own row
 * -- there is no id in the request to point somewhere else.
 */
app.get('/api/playlist/source', async (c) => {
  const user = requireUser(c);
  const source = await playlistSource(user.id);
  if (!source) return c.json({ error: 'You have not added a list.' }, 404);
  c.header('cache-control', 'no-store');
  if (!source.url) {
    return c.json({ error: 'That stored address could not be read. Please add it again.' }, 409);
  }
  return c.json(source);
});

app.post('/api/playlist/refresh', async (c) => {
  const user = requireUser(c);
  try {
    const result = await refreshPlaylist(user.id);
    return respond(c, { json: result, redirectTo: playlistNoticeFor(result) });
  } catch (err) {
    return respond(c, {
      json: { error: err.message },
      status: 400,
      redirectTo: `/settings?playlist_error=${encodeURIComponent(err.message)}`,
    });
  }
});

/**
 * Open this account's list to everybody signed in, or close it again.
 *
 * Owner-only, and the query is keyed on the session's own user id rather than on
 * anything the request supplies, so there is no id to tamper with.
 *
 * What the owner is agreeing to is stated on the form rather than here, because a
 * consent nobody reads is not one: their provider line permits a small number of
 * simultaneous connections, and other people watching it use them.
 */
app.post('/api/playlist/share', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const label = String(body.label ?? '').trim();

  /*
   * Still accepts the old `shared=1`, which is what an unreloaded page sends.
   *
   * That form is in browsers right now and its meaning has not changed -- it was
   * always "open to everybody signed in". Reading it as anything narrower would
   * quietly close lists their owners believe are open; reading a missing audience
   * as anything WIDER would be the far worse mistake, so the fallback for an
   * unrecognised value is 'none' and the query enforces that too.
   */
  const audience = body.audience
    ? String(body.audience)
    : String(body.shared ?? '') === '1'
      ? 'everyone'
      : 'none';

  /*
   * Sharing with named friends is what the membership sells; sharing with the
   * whole site is not, and never was. A lapsed member keeps 'everyone' and is
   * refused only the narrower option -- the gate must never be able to widen who
   * can reach somebody's provider credentials.
   */
  if (audience === 'friends' && !(await isMember(user))) {
    return respond(c, {
      json: { error: 'premium only' },
      status: 402,
      redirectTo: '/premium?want=friends',
    });
  }

  const row = await q.setPlaylistSharing({ userId: user.id, audience, label: label || null });
  if (!row) {
    return respond(c, {
      json: { error: 'no list to share' },
      status: 400,
      redirectTo: '/settings?playlist_error=There%20is%20no%20list%20on%20this%20account%20yet.',
    });
  }
  return respond(c, { json: row, redirectTo: `/settings?shared=${row.share_audience}` });
});

/**
 * Name one person who may see this list, or take them off it again.
 *
 * Removal is deliberately NOT gated on membership. A lapsed member must always be
 * able to close their line down -- gating the revoke would leave somebody unable to
 * withdraw a credential they had shared, which is the one direction this must
 * never fail in.
 */
app.post('/api/playlist/share/grant', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const audienceUserId = String(body.user_id ?? '');
  const allowed = String(body.allowed ?? '') === '1';

  if (allowed && !(await isMember(user))) {
    return respond(c, {
      json: { error: 'premium only' },
      status: 402,
      redirectTo: '/premium?want=friends',
    });
  }

  const ok = await q.setPlaylistShareGrant({ userId: user.id, audienceUserId, allowed });
  return respond(c, { json: { ok }, redirectTo: '/settings#sharing' });
});

/**
 * Whose lists are open, and how big they are.
 *
 * Signed-in only. Not because the fact is sensitive -- the owners chose to
 * publish it -- but because there is nothing here for somebody who cannot play
 * any of it, and a page listing other people's subscriptions to the open web is
 * an invitation to scrape.
 *
 * Never a URL, never a channel title. This says who is sharing and how much;
 * what is in a list is answered on an event page, against an event, one entry at
 * a time.
 */
app.get('/shared', async (c) => {
  const user = requireUser(c);
  const owners = await q.sharedPlaylistOwners({ viewerId: user.id });
  return c.html(await render(<SharedLists user={user} owners={owners} />));
});

/**
 * Is this entry a file rather than a channel?
 *
 * The stored kind is the only thing that knows. `data-play` is our own proxy route
 * for both, the provider URL is sealed, and what comes back down the pipe is
 * either a transport stream or an MP4 -- so a route that does not ask this
 * question serves a film with live-channel headers and the page hands it to a
 * transport-stream demuxer. That is exactly what it did.
 *
 * `series` counts as a file: a provider's series entry is an episode sitting on
 * disk, not a stream.
 */
const isVodKind = (kind) => kind === 'vod' || kind === 'series';

/**
 * What to call a file the provider would not name.
 *
 * A fair number of these panels answer `application/octet-stream` for everything.
 * On the live path that is harmless -- the demuxer reads the bytes and ignores the
 * header -- but native playback is the opposite: `<video>` decides from the
 * content type alone, and an MP4 announced as `video/mp2t` is refused before a
 * byte is decoded. The URL is the only other thing that knows, and for these
 * panels it is reliable, because the extension is what the kind was derived from.
 */
const VOD_TYPE = [
  [/\.(mp4|m4v)(\?|$)/i, 'video/mp4'],
  [/\.mkv(\?|$)/i, 'video/x-matroska'],
  [/\.webm(\?|$)/i, 'video/webm'],
  [/\.avi(\?|$)/i, 'video/x-msvideo'],
];

/**
 * The response for a stream this route is proxying.
 *
 * Live and on-demand differ in one respect, and it is not cosmetic. A live channel
 * has no end and cannot be seeked, so it says `accept-ranges: none` and any Range
 * a client sends is ignored -- which is right, and was applied to files too. For a
 * file that is fatal rather than merely limiting: `<video>` seeks to read the index
 * of an MP4 whose moov atom sits at the end, and a route that refuses ranges turns
 * such a film into a spinner that never resolves.
 *
 * So a file mirrors what the provider said about ranges rather than asserting it,
 * and keeps a 206 a 206. Nothing else changes: same one connection, same session,
 * still never cached and still not a restream.
 */
function streamResponse(result, body, { vod = false, url = '' } = {}) {
  const named = /^video\/|^audio\//i.test(result.contentType);
  const guessed = vod ? (VOD_TYPE.find(([re]) => re.test(url))?.[1] ?? 'video/mp4') : 'video/mp2t';

  const headers = {
    // What the provider called it, unless it declined to say. mpegts.js reads the
    // bytes rather than the header, but a bare octet-stream tells an intermediary
    // nothing about whether it may buffer -- and tells <video> nothing it can act
    // on at all.
    'content-type': named ? result.contentType : guessed,
    // The body is somebody's own subscription. Nothing may hold a copy.
    'cache-control': 'no-store, private',
    // Ask intermediaries to pass it through rather than accumulate it; a proxy
    // that buffers a stream adds its buffer to the latency, permanently.
    'x-accel-buffering': 'no',
  };

  if (!vod) {
    // No length, no ranges: a live channel has no end and cannot be seeked. Saying
    // so stops a client asking for byte ranges the provider will not honour.
    headers['accept-ranges'] = 'none';
    return new Response(body, { headers });
  }

  headers['accept-ranges'] = result.acceptRanges || 'bytes';
  if (result.contentRange) headers['content-range'] = result.contentRange;
  if (result.contentLength) headers['content-length'] = result.contentLength;
  return new Response(body, { status: result.status === 206 ? 206 : 200, headers });
}

/**
 * Play an entry from somebody else's shared list.
 *
 * Separate from /events/:id/stream.ts rather than a flag on it, and the split is
 * the point: that route resolves a channel by INDEX within the reader's own
 * ranked lists, which only makes sense for a list the reader owns. This one
 * resolves by channel id, and `sharedChannelById` is what authorises it -- the
 * row comes back only while its owner's list is shared.
 *
 * Three things differ from the private path, all of them because the line belongs
 * to somebody else:
 *
 *   1. The slot is claimed against the OWNER. Twenty readers on one subscription
 *      is how that subscription gets terminated, so the ceiling has to be a
 *      property of the line rather than of the audience.
 *   2. A busy line REFUSES rather than evicting. On the owner's own stream,
 *      eviction is right -- pressing Play elsewhere says which channel they want
 *      now. Taking a stranger's film off them because you clicked something is
 *      not the same act, and the honest answer is that the line is in use.
 *   3. There is no .m3u and no VLC link anywhere near this. Those hand over the
 *      URL, and the URL is the owner's provider password.
 */
app.get('/shared/:channelId/stream.ts', async (c) => {
  const user = requireUser(c);
  if (!config.playlists.proxy.enabled) return c.json({ error: 'player is off' }, 404);

  const row = await q.sharedChannelById(Number(c.req.param('channelId')), {
    viewerId: user.id,
  });
  if (!row) return c.json({ error: 'not shared' }, 404);

  /*
   * The owner's own session is not subject to the refusal below.
   *
   * They can always take their own line back -- it is theirs, and a reader who
   * has opened their list to others must not be locked out of it by them.
   */
  const isOwner = row.owner_id === user.id;
  if (!isOwner && streamSlotsOpen(row.owner_id) >= config.playlists.proxy.maxPerUser) {
    return c.json({ error: 'that line is in use right now' }, 409);
  }

  const stop = new AbortController();
  const signal = stop.signal;
  if (c.req.raw.signal?.aborted) stop.abort();
  else c.req.raw.signal?.addEventListener('abort', () => stop.abort(), { once: true });

  // Against the owner, not the viewer. See point 1 above.
  const release = claimStreamSlot(row.owner_id, {
    max: config.playlists.proxy.maxPerUser,
    evict: () => stop.abort(),
  });
  if (!release) return c.json({ error: 'player is off' }, 404);

  const streamUrl = auth.open(row.stream_url);
  const vod = isVodKind(row.kind);

  let result;
  try {
    result = await openStream(streamUrl, {
      signal,
      // Only a file gets the reader's Range. See streamResponse.
      range: vod ? (c.req.header('range') ?? null) : null,
    });
  } catch (err) {
    release();
    throw err;
  }

  if (!result.ok) {
    release();
    // Written back against the owner's row, because it is a fact about the slot
    // rather than about who asked. Not for a reader who simply closed the tab.
    if (!result.silent) {
      await q
        .markSharedChannelChecked({
          channelId: row.id,
          live: verdictToStore(result),
          note: result.note,
        })
        .catch(() => {});
    }
    return c.json({ error: result.note }, result.status === 499 ? 499 : result.status);
  }

  await q
    .markSharedChannelChecked({ channelId: row.id, live: true, note: result.note })
    .catch(() => {});

  signal.addEventListener('abort', release, { once: true });
  const body = result.body.pipeThrough(new TransformStream({ flush: release, cancel: release }));

  return streamResponse(result, body, { vod, url: streamUrl });
});

/** Is one shared entry actually there? Same shape as the private check. */
app.get('/shared/:channelId/check', async (c) => {
  const _user = requireUser(c);
  const row = await q.sharedChannelById(Number(c.req.param('channelId')), {
    viewerId: user.id,
  });
  if (!row) return c.json({ error: 'not shared' }, 404);

  // A probe is a connection like any other, and it is the owner's line it would
  // be opened on. Never while that line is carrying something.
  if (streamSlotsOpen(row.owner_id) > 0) return c.json({ skipped: 'watching' });

  const result = await probeStream(auth.open(row.stream_url), { signal: c.req.raw.signal });
  await q
    .markSharedChannelChecked({
      channelId: row.id,
      live: verdictToStore(result),
      note: result.note,
    })
    .catch(() => {});
  return c.json(result);
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
/**
 * Which tier the reader clicked, and which entry within it.
 *
 * The three lists are different claims -- "you already have this file", "this
 * carries your show", "this carries the genre" -- and they are indexed separately
 * on the page, so the link has to say which one it means or ?n=0 hands back the
 * wrong channel.
 *
 * Shared by the download and the check, because they must agree: verifying one
 * channel and then handing over another is worse than not checking at all.
 */
function pickOwnChannel(c, own) {
  const tier = c.req.query('tier');
  const list =
    tier === 'genre'
      ? (own.genre ?? [])
      : tier === 'vod'
        ? (own.onDemand ?? [])
        : (own.matches ?? []);

  // The first entry, which rankChannelsForTitle has already ordered most-specific
  // first, unless the reader asked for a particular one by index.
  const wanted = Number(c.req.query('n') ?? 0);
  const asked = Number.isInteger(wanted) && list[wanted] ? wanted : 0;
  return { list, asked };
}

/**
 * Is this one entry actually there, right now?
 *
 * The page used to list every channel whose title matched and let the reader find
 * out by opening it. A provider list is mostly aspirational -- the slot exists,
 * the title is right, and a large share answer with an HTML error page rather than
 * video -- so being handed a dead one was a routine outcome of using the feature
 * as intended. The .m3u route has probed since it was written; the page had no way
 * to.
 *
 * One entry per request, and the client walks the list in order. Not one endpoint
 * that checks them all: these are one subscriber's own connections on a line that
 * caps them, and a row that has been cleared should become usable then rather than
 * when the slowest of five has timed out.
 *
 * The verdict is written back, so the next reader of this page, the .m3u route and
 * the 30-minute filter in playlistChannels all inherit what this one learned.
 */
app.get('/events/:id/channel-check', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.notFound();

  /*
   * Never while something is playing.
   *
   * A probe is a second connection, and on a line that permits one it is the
   * connection that gets the subscription suspended -- or, since a new claim
   * evicts the old, it would be the reader's own film being taken off them by a
   * background check. The page skips the sweep while it is playing; this is the
   * half that does not depend on the page behaving.
   */
  if (streamSlotsOpen(user.id) > 0) return c.json({ skipped: 'watching' });

  const own = await ownChannelsForEvent({ userId: user.id, event });
  const { list, asked } = pickOwnChannel(c, own);
  const pick = list[asked];
  if (!pick) return c.json({ error: 'no channel' }, 404);

  const result = await probeStream(pick.url, { signal: c.req.raw.signal });

  if (pick.id) {
    await q
      .markChannelChecked({
        userId: user.id,
        channelId: pick.id,
        live: verdictToStore(result),
        note: result.note,
      })
      .catch(() => {});
  }

  return c.json(result);
});

/**
 * The same entry, for a device with no player to hand it to.
 *
 * A television is the case this exists for. A Fire TV, an Android TV box or a
 * games console has a browser and nothing else: no VLC to deep-link into, no
 * Infuse, no filesystem to drop an .m3u onto. "Open it in another app" is not an
 * answer there, and a film is watched on exactly that screen.
 *
 * So the bytes come through this server -- the only route on the site that does
 * that, and see packages/playlists/src/proxy.js for why a browser leaves no other
 * option. What it is NOT is a restream: the response is one reader's own
 * subscription played back to that reader's own session, never cached, never
 * shared, and never reachable without the cookie of the account that supplied the
 * list.
 *
 * `.ts` in the path rather than a query flag, because what comes back really is a
 * transport stream and some clients decide how to treat a URL by looking at it.
 *
 * Ported from tipoffwatch, where every line of it was paid for once already.
 */
app.get('/events/:id/stream.ts', async (c) => {
  const user = requireUser(c);
  if (!config.playlists.proxy.enabled) return c.json({ error: 'player is off' }, 404);

  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.notFound();

  const own = await ownChannelsForEvent({ userId: user.id, event });
  const { list, asked } = pickOwnChannel(c, own);
  const pick = list[asked];
  if (!pick) return c.json({ error: 'no channel' }, 404);

  /*
   * Two ways this stream can be told to stop, and it has to obey both.
   *
   * The reader leaving is `c.req.raw.signal`. The other is this account starting
   * a different entry -- pressing Play elsewhere means they want that one now, so
   * the older stream is evicted rather than the new one being refused. Both end up
   * on one controller, because everything downstream takes a single signal and
   * neither reason to stop is more real than the other.
   */
  const stop = new AbortController();
  const signal = stop.signal;
  const abortOnLeave = () => stop.abort();
  if (c.req.raw.signal?.aborted) stop.abort();
  else c.req.raw.signal?.addEventListener('abort', abortOnLeave, { once: true });

  /*
   * Claimed before the upstream is touched, not after.
   *
   * A reader with two connections open on a line that allows one is how a
   * subscription gets suspended, so the slot is taken first and the previous
   * stream is aborted here -- before the replacement connects, not alongside it.
   */
  const release = claimStreamSlot(user.id, {
    max: config.playlists.proxy.maxPerUser,
    evict: () => stop.abort(),
  });
  if (!release) return c.json({ error: 'player is off' }, 404);

  const vod = isVodKind(pick.kind);

  let result;
  try {
    result = await openStream(pick.url, {
      signal,
      // Only a file gets the reader's Range. See streamResponse.
      range: vod ? (c.req.header('range') ?? null) : null,
    });
  } catch (err) {
    // openStream answers rather than throws for everything it anticipates, so
    // this is the unanticipated one -- and a slot that leaks here is the reader's
    // only connection, held by nothing, until the container restarts.
    release();
    throw err;
  }

  if (!result.ok) {
    release();
    // Remembered, so the page stops offering a slot that is not there -- the same
    // verdict the probe writes, from the same headers. Not for a reader who simply
    // closed the tab: that says nothing about the entry.
    if (!result.silent && pick.id) {
      await q
        .markChannelChecked({
          userId: user.id,
          channelId: pick.id,
          live: verdictToStore(result),
          note: result.note,
        })
        .catch(() => {});
    }
    return c.json({ error: result.note }, result.status === 499 ? 499 : result.status);
  }

  if (pick.id) {
    await q
      .markChannelChecked({ userId: user.id, channelId: pick.id, live: true, note: result.note })
      .catch(() => {});
  }

  /*
   * Give the slot back when the stream ends, however it ends.
   *
   * Two ways out and both are wired, because missing either leaks the reader's
   * only connection until the process restarts: `flush` is the upstream reaching
   * its end, and the abort is the reader closing the tab -- which is by far the
   * commoner one and never touches the transform at all. Releasing twice is
   * harmless by construction; releasing never is a feature that works once per
   * deploy.
   */
  signal.addEventListener('abort', release, { once: true });
  const body = result.body.pipeThrough(
    new TransformStream({
      flush: release,
      cancel: release,
    }),
  );

  return streamResponse(result, body, { vod, url: pick.url });
});

app.get('/events/:id/playlist.m3u', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.notFound();

  const own = await ownChannelsForEvent({ userId: user.id, event });

  const { list, asked } = pickOwnChannel(c, own);
  if (list.length === 0) return c.redirect(`/events/${event.id}`, 303);

  /*
   * Ask the stream whether it is there, before handing anybody a file.
   *
   * A provider list is mostly aspirational: the slot exists, the title is right,
   * and a large share of them answer with an HTML error page rather than video.
   * Handing one of those over is worse than handing over nothing, because the
   * reader finds out by tapping it -- the file downloads perfectly and then plays
   * nothing, which reads as our bug rather than an empty slot.
   *
   * The one they asked for is tried first, then the rest in rank order. Probing is
   * sequential inside firstLiveChannel because these are one subscriber's own
   * connections and the line caps how many can be open at once.
   */
  const ordered = [list[asked], ...list.filter((_, i) => i !== asked)].filter(Boolean);
  const { pick, tried } = await firstLiveChannel(ordered, {
    onResult: async (ch, result) => {
      if (!ch.id) return;
      // Remembered so the page can stop offering a dead slot to the next reader,
      // and so the next tap does not re-probe what we just learned.
      await q
        .markChannelChecked({
          userId: user.id,
          channelId: ch.id,
          live: verdictToStore(result),
          note: result.note,
        })
        .catch(() => {});
    },
  });

  // Which way it failed, not just that it did. "returned a web page, not a stream"
  // means the slot is empty; "timed out" means it is not. "Something went wrong"
  // would send somebody off to check their own wifi.
  if (!pick) {
    const why = tried[0]?.note ?? 'no answer';
    return c.redirect(`/events/${event.id}?stream_dead=${encodeURIComponent(why)}`, 303);
  }

  c.header('content-type', 'audio/x-mpegurl; charset=utf-8');
  c.header('content-disposition', `attachment; filename="${event.short_name ?? 'channel'}.m3u"`);
  c.header('cache-control', 'no-store, private');
  return c.body(oneChannelM3u(pick));
});

/* ------------------------------------------------- one entry, by its id -- */

/**
 * The reader's own entry, addressed by row id rather than by list position.
 *
 * The event routes resolve an entry by (tier, index) into a ranked list, which is
 * the right handle when the page IS that ranked list. A subject page ranks the
 * same entries against the same title with no event to hang an index off -- and
 * that page is where somebody who searched for a film actually lands. So these
 * take an id.
 *
 * Ownership is enforced by the query rather than by these handlers remembering
 * to: ownChannelById joins through user_playlists on the session's user id, so an
 * id from anywhere else comes back empty.
 */
async function ownEntryOr404(c, user) {
  const row = await q.ownChannelById(user.id, Number(c.req.param('channelId')));
  if (!row) return null;
  const url = auth.open(row.stream_url);
  return url ? { ...row, url } : null;
}

app.get('/my/channels/:channelId/check', async (c) => {
  const user = requireUser(c);
  // A probe is a connection, and the line permits one. Never while it is carrying
  // something -- see the note on /events/:id/channel-check.
  if (streamSlotsOpen(user.id) > 0) return c.json({ skipped: 'watching' });

  const ch = await ownEntryOr404(c, user);
  if (!ch) return c.json({ error: 'no channel' }, 404);

  const result = await probeStream(ch.url, { signal: c.req.raw.signal });
  await q
    .markChannelChecked({
      userId: user.id,
      channelId: ch.id,
      live: verdictToStore(result),
      note: result.note,
    })
    .catch(() => {});
  return c.json(result);
});

app.get('/my/channels/:channelId/playlist.m3u', async (c) => {
  const user = requireUser(c);
  const ch = await ownEntryOr404(c, user);
  if (!ch) return c.notFound();

  c.header('content-type', 'audio/x-mpegurl; charset=utf-8');
  const name = (ch.title || 'channel').slice(0, 60);
  c.header('content-disposition', `attachment; filename="${name}.m3u"`);
  // The body is a credential.
  c.header('cache-control', 'no-store, private');
  return c.body(oneChannelM3u(ch));
});

app.get('/my/channels/:channelId/stream.ts', async (c) => {
  const user = requireUser(c);
  if (!config.playlists.proxy.enabled) return c.json({ error: 'player is off' }, 404);

  const ch = await ownEntryOr404(c, user);
  if (!ch) return c.json({ error: 'no channel' }, 404);

  const stop = new AbortController();
  const signal = stop.signal;
  if (c.req.raw.signal?.aborted) stop.abort();
  else c.req.raw.signal?.addEventListener('abort', () => stop.abort(), { once: true });

  const release = claimStreamSlot(user.id, {
    max: config.playlists.proxy.maxPerUser,
    evict: () => stop.abort(),
  });
  if (!release) return c.json({ error: 'player is off' }, 404);

  const vod = isVodKind(ch.kind);

  let result;
  try {
    result = await openStream(ch.url, {
      signal,
      // Only a file gets the reader's Range. See streamResponse.
      range: vod ? (c.req.header('range') ?? null) : null,
    });
  } catch (err) {
    release();
    throw err;
  }

  if (!result.ok) {
    release();
    if (!result.silent) {
      await q
        .markChannelChecked({
          userId: user.id,
          channelId: ch.id,
          live: verdictToStore(result),
          note: result.note,
        })
        .catch(() => {});
    }
    return c.json({ error: result.note }, result.status === 499 ? 499 : result.status);
  }

  await q
    .markChannelChecked({ userId: user.id, channelId: ch.id, live: true, note: result.note })
    .catch(() => {});

  signal.addEventListener('abort', release, { once: true });
  const body = result.body.pipeThrough(new TransformStream({ flush: release, cancel: release }));

  return streamResponse(result, body, { vod, url: ch.url });
});

/* ---------------------------------------------------------------- payments -- */

/**
 * CoinPay's webhook.
 *
 * Ported from the sibling brand along with the package behind it. Unauthenticated
 * by necessity -- CoinPay holds no session with us -- so the SIGNATURE is the only
 * thing standing between this route and anybody who can POST. It is verified over
 * the RAW bytes: re-serialising the parsed JSON changes key order and whitespace
 * and the signature stops matching, which reads as a forgery rather than the bug
 * it is.
 *
 * There IS something for sale now -- a membership -- so the grant this used to
 * leave empty is supplied below, inside settleWebhook's transaction.
 */
app.post('/api/webhooks/coinpay', async (c) => {
  const raw = await c.req.text();
  const ok = pay.verifyWebhook({
    rawBody: raw,
    signatureHeader: c.req.header('coinpay-signature') ?? c.req.header('x-coinpay-signature'),
  });
  if (!ok) return c.json({ error: 'bad signature' }, 401);

  const result = await pay.settleWebhook(JSON.parse(raw), {
    grant: async (tx, { meta, payment }) => {
      /*
       * A settled payload is an amount and a status; nothing in it says what was
       * bought. `kind` is the whole attribution, so a payment arriving without it
       * is recorded and grants nothing rather than being guessed at.
       */
      if (meta.kind !== member.MEMBERSHIP_KIND) return null;

      const granted = await member.grantMembership(tx, {
        userId: meta.user_id,
        paymentId: payment?.id ?? null,
        // What we CHARGED, from our own row, rather than what the payload says was
        // paid. A term is a term whatever the wire claims.
        priceCents: payment?.amount_cents ?? config.membership.priceCents,
        currency: payment?.currency ?? config.membership.currency,
        termDays: config.membership.termDays,
      });
      if (!granted) return null;

      /*
       * The introduction is paid AFTER something was delivered, in the same
       * transaction as the delivery. Crediting in a second transaction would leave
       * a window where the sale exists and the commission owed on it does not.
       * Returns null when nobody invited this buyer, which is the common case and
       * must never fail a webhook.
       */
      const commission = await member.creditReferral(tx, {
        buyerId: meta.user_id,
        paymentId: payment?.id ?? null,
        amountCents: payment?.amount_cents ?? 0,
        currency: payment?.currency ?? config.membership.currency,
        rateBps: config.membership.commissionBps,
      });

      return { ...granted, commissionCents: commission?.amount_cents ?? 0 };
    },
  });
  return c.json(result);
});

/* --------------------------------------------------------------- messages -- */

/*
 * Direct messages, ported from the sibling brand.
 *
 * 0003 carried the naming columns and said the rest would land on the same shapes;
 * 0015 brought the tables and these are the routes. Kept close to the original so
 * a fix crosses as a diff -- including the two rules that are quiet when broken: a
 * block is checked in BOTH directions, so neither party can reopen a conversation
 * the other closed, and the rate limit is per sender rather than per thread.
 */

app.get('/messages', async (c) => {
  const user = requireUser(c);
  const threads = await q.conversations({ userId: user.id });
  return c.html(await render(<Inbox user={user} threads={threads} />));
});

app.get('/messages/:handle', async (c) => {
  const user = requireUser(c);
  const other = await q.getUserByHandle(c.req.param('handle'));
  if (!other) return c.html(await render(<NotFound user={user} />), 404);
  if (other.id === user.id) return c.redirect('/messages', 303);

  const blocked = await q.blockExists({ a: user.id, b: other.id });

  /*
   * Full history is what the membership sells, so a non-member gets a window.
   *
   * Nothing is deleted to make that true and the withheld count is fetched
   * separately, because "there is nothing older" and "there are 340 older messages
   * you cannot open" must not render as the same empty space. A page that cannot
   * tell them apart reads as data loss, which is a worse thing to sell against.
   */
  const member = await isMember(user);
  const sinceDays = historyWindowDays(member);
  const [messages, olderCount] = blocked
    ? [[], 0]
    : await Promise.all([
        q.thread({ userId: user.id, otherId: other.id, sinceDays }),
        q.olderMessageCount({ userId: user.id, otherId: other.id, sinceDays }),
      ]);

  return c.html(
    await render(
      <Thread
        user={user}
        other={other}
        messages={messages}
        blocked={blocked}
        historyDays={sinceDays}
        olderCount={olderCount}
      />,
    ),
  );
});

/** Generous for a person, useless for anything sending in bulk. */
const MESSAGE_RATE_PER_HOUR = 60;

app.post('/api/messages', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const other = await q.getUserByHandle(String(body.handle ?? ''));
  const text = String(body.body ?? '').trim();

  if (!other || other.id === user.id) return c.json({ error: 'no such person' }, 404);
  if (!text) return c.redirect(`/messages/${other.handle}`, 303);
  if (text.length > 4000) return c.json({ error: 'too long' }, 400);

  // Checked in both directions, so neither party can reopen a conversation the
  // other closed.
  if (await q.blockExists({ a: user.id, b: other.id })) {
    return c.json({ error: 'unavailable' }, 403);
  }

  const sent = await q.messagesSentSince({ senderId: user.id, minutes: 60 });
  if (sent >= MESSAGE_RATE_PER_HOUR) {
    return respond(c, {
      json: { error: 'rate limited' },
      status: 429,
      redirectTo: `/messages/${other.handle}?slow=1`,
    });
  }

  await q.sendMessage({ senderId: user.id, recipientId: other.id, body: text });
  return respond(c, { json: { ok: true }, redirectTo: `/messages/${other.handle}` });
});

/**
 * Following a person, and blocking one.
 *
 * Following somebody is not following a genre: that is the polymorphic `follows`
 * table and it cannot carry a uuid. These write user_follows, which the database
 * can actually constrain to real accounts.
 */
app.post('/api/users/follow', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const other = await q.getUserByHandle(String(body.handle ?? ''));
  if (!other || other.id === user.id) return c.json({ error: 'no such person' }, 404);

  if (String(body.follow ?? '1') === '1') {
    await q.followUser({ followerId: user.id, followeeId: other.id });
  } else {
    await q.unfollowUser({ followerId: user.id, followeeId: other.id });
  }
  return respond(c, { json: { ok: true }, redirectTo: `/u/${other.handle}` });
});

app.post('/api/users/block', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const other = await q.getUserByHandle(String(body.handle ?? ''));
  if (!other || other.id === user.id) return c.json({ error: 'no such person' }, 404);

  if (String(body.block ?? '1') === '1') {
    await q.blockUser({ blockerId: user.id, blockedId: other.id });
  } else {
    await q.unblockUser({ blockerId: user.id, blockedId: other.id });
  }
  return respond(c, { json: { ok: true }, redirectTo: '/messages' });
});

/* ------------------------------------------------------------- membership -- */

/**
 * The page that sells the tier, and the page that reports on it.
 *
 * One page rather than two, because "what do I get" and "what have I earned" are
 * the same question asked before and after joining, and splitting them means a
 * member lands on a sales pitch every time they want to check their balance.
 *
 * Readable signed out: somebody has to be able to find out what this costs before
 * making an account.
 */
app.get('/premium', async (c) => {
  const user = c.get('user');

  const [membership, earnings, invited, ledger, code] = user
    ? await Promise.all([
        q.activeMembership(user.id),
        q.commissionSummary(user.id),
        q.invitedAccounts(user.id),
        q.commissionLedger(user.id, { limit: 20 }),
        auth.inviteCodeFor(user.id),
      ])
    : [null, [], [], [], null];

  return c.html(
    await render(
      <PremiumPage
        user={user}
        membership={membership}
        priceCents={config.membership.priceCents}
        currency={config.membership.currency}
        termDays={config.membership.termDays}
        commissionBps={config.membership.commissionBps}
        freeHistoryDays={config.membership.freeMessageHistoryDays}
        paymentsEnabled={pay.paymentsEnabled()}
        inviteUrl={code ? auth.inviteUrl(code) : null}
        invited={invited}
        earnings={earnings}
        ledger={ledger}
        payout={user}
        want={c.req.query('want') ?? null}
        notice={
          c.req.query('paid') === '1'
            ? 'Payment started. Membership begins the moment it settles on chain, which is usually a few minutes.'
            : c.req.query('payout') === 'saved'
              ? 'Payout details saved.'
              : null
        }
        error={c.req.query('error') ?? null}
      />,
    ),
  );
});

/**
 * Buy a term.
 *
 * Renewing is the same call as joining and needs no special case: the grant stacks
 * the new term onto the end of whatever is already held, so pressing this twice
 * costs twice and grants twice as long rather than overwriting anything.
 */
app.post('/api/membership/buy', async (c) => {
  const user = requireUser(c);

  if (!pay.paymentsEnabled()) {
    return respond(c, {
      json: { error: 'payments are off' },
      status: 503,
      redirectTo: '/premium?error=Payments%20are%20not%20switched%20on%20here.',
    });
  }

  /*
   * `kind` is what the webhook branches on, and it is the only thing that makes
   * this payment a membership. A checkout that omitted it would settle, be
   * recorded, and grant nothing at all.
   */
  const { checkoutUrl } = await pay.createCheckout({
    user,
    amountCents: config.membership.priceCents,
    currency: config.membership.currency,
    description: `GenreWatch premium, ${config.membership.termDays} days`,
    metadata: { kind: member.MEMBERSHIP_KIND },
    blockchain: config.payments.blockchain,
    payTo: config.payments.payoutAddress || undefined,
    successUrl: `${config.siteUrl}/premium?paid=1`,
    cancelUrl: `${config.siteUrl}/premium`,
  });

  return respond(c, { json: { checkoutUrl }, redirectTo: checkoutUrl });
});

/**
 * Where to send this account's commission.
 *
 * Not validated against the chain beyond being present: this site does not know
 * how to check an address on every chain CoinPay settles, and a validator that is
 * wrong about one of them would refuse a correct address with no way past it.
 * Payouts are settled by a human who can look.
 */
app.post('/api/membership/payout', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  await q.setPayoutInstruction({ userId: user.id, address: body.address, chain: body.chain });
  return respond(c, { json: { ok: true }, redirectTo: '/premium?payout=saved' });
});

/* -------------------------------------------------------------------- auth -- */

/**
 * How long to wait, in words somebody can act on.
 *
 * "Retry in 3600 seconds" is a number a person has to do arithmetic on while
 * already annoyed.
 */
function waitFor(seconds) {
  if (seconds < 90) return `${Math.max(seconds, 1)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/**
 * Escalating backoff in front of one auth route. See `lib/auth-throttle.js`.
 *
 * Each route gets its OWN bucket, which is the whole reason `bucket` is a
 * parameter rather than derived from the path once. The throttled password form
 * tells people to use a sign-in link instead, so the sign-in link must still be
 * reachable when it does — sharing one counter across both would make that
 * advice a lie, and lock somebody out of the account they were trying to reach.
 *
 * A caller with no forwarded address is let through untracked rather than
 * bucketed under a placeholder: behind Railway there is always one, so this only
 * fires for something reaching the app directly, and lumping those together
 * would let the first eight of them lock out the rest.
 */
function authBackoff(bucket, refuse, limits = undefined) {
  return async (c, next) => {
    const caller = callerAddress(c);
    if (!caller) return next();

    const verdict = attempt(`${bucket}:${caller}`, Date.now(), limits);
    if (verdict.ok) return next();

    console.warn(
      `[auth] ${bucket} backoff: ${caller} strike ${verdict.strikes}, ${verdict.retryAfter}s`,
    );
    c.header('retry-after', String(verdict.retryAfter));
    // Nothing here is worth a cache entry, and a 429 that got cached would
    // outlive the lock it was reporting.
    c.header('cache-control', 'no-store');
    return refuse(c, verdict.retryAfter);
  };
}

/*
 * The sign-in PAGE, not the forms on it.
 *
 * A crawler that ignores robots.txt and is not caught by the user-agent block
 * above still gets metered here. It is the same doubling curve as the forms, on
 * the far gentler VIEW allowance -- thirty views before any penalty and an hour
 * at worst -- because unlike the forms this is a page a real person looks at,
 * and the cost of being wrong is somebody who cannot reach sign-in at all.
 */
const viewBackoff = authBackoff(
  'view',
  (c, retryAfter) => c.text(`Too many requests. Try again in ${waitFor(retryAfter)}.`, 429),
  VIEW,
);

app.get('/login', viewBackoff);
app.get('/login', async (c) =>
  c.html(await render(<SignIn mode="login" next={c.req.query('next')} />)),
);
app.get('/signup', viewBackoff);
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
app.post(
  '/api/auth/magic',
  authBackoff('magic', async (c, retryAfter) =>
    c.req.header('accept')?.includes('application/json')
      ? c.json({ error: `Too many requests. Try again in ${waitFor(retryAfter)}.` }, 429)
      : c.html(
          await render(
            <SignIn
              mode="login"
              magicError={`Too many sign-in links requested from here. Try again in ${waitFor(retryAfter)}.`}
            />,
          ),
          429,
        ),
  ),
);
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

/*
 * Presenting a token is metered too. Guessing one is 2^256 work so this is not
 * about the token, but it is the closest thing here to a failed login and it is
 * a database round trip a stranger can ask for as often as it likes.
 */
app.get(
  '/auth/magic',
  authBackoff('token', (c, retryAfter) =>
    c.text(`Too many attempts. Try again in ${waitFor(retryAfter)}.`, 429),
  ),
);
app.get('/auth/magic', async (c) => {
  const token = c.req.query('t');
  if (!token) return c.redirect('/login', 303);
  const result = await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') });
  if (!result) return c.html(await render(<SignIn mode="login" next="/following" />), 400);

  /*
   * Credit whoever invited them, if this link just created the account.
   *
   * Only for a genuinely new account -- somebody who already had one and happened to
   * open a friend's link was not invited by them, and counting them would make the
   * number on the inviter's page untrue. `created` comes back from the upsert
   * itself; see findOrCreateUser.
   *
   * The cookie is cleared either way, so a stale code cannot follow somebody around
   * for a month attaching itself to accounts.
   */
  const inviteCode = getCookie(c, INVITE_COOKIE);
  if (inviteCode) {
    await auth.claimInvite({ code: inviteCode, user: result.user, created: result.user?.created });
  }

  // The session header goes on first and the invite is cleared after, because
  // c.header REPLACES set-cookie while the setCookie helper appends. The other order
  // silently drops one of the two, and the one it drops is the clear.
  // A link that worked is proof of a mailbox, which is the whole security model
  // here — so the fumbled ones before it were not an attack.
  const caller = callerAddress(c);
  if (caller) forgive(`token:${caller}`);

  c.header('set-cookie', auth.sessionCookie(result.sessionId));
  if (inviteCode) setCookie(c, INVITE_COOKIE, '', { path: '/', maxAge: 0 });

  return c.redirect(c.req.query('next') ?? '/following', 303);
});

/**
 * Sign in with a password, for the device that cannot do the other two.
 *
 * A plain form post with no script, because the device this exists for is a
 * television: the whole point is that it works with a remote control and a browser
 * that may do very little else.
 *
 * Every failure comes back identically worded, and verifyPassword spends the same
 * time on an address with no account as on a wrong password, so this form cannot be
 * used to find out who has an account here. When it throttles, the message points at
 * the emailed link -- which is unaffected by the counter, so guessing at somebody's
 * address can never lock them out of their own account.
 */
/*
 * The backoff goes in FRONT of the handler, which is the entire point: refusing
 * here costs a map lookup, where letting it through costs an argon2id verify
 * that was sized to be expensive. A limiter that runs after the hash meters the
 * attack without stopping it paying for itself.
 */
app.post(
  '/api/auth/password',
  authBackoff('password', async (c, retryAfter) => {
    const message = `Too many sign-in attempts from here. Try again in ${waitFor(retryAfter)}, or use a sign-in link — that still works.`;
    return c.req.header('accept')?.includes('application/json')
      ? c.json({ error: message }, 429)
      : c.html(await render(<SignIn mode="login" passwordError={message} />), 429);
  }),
);
app.post('/api/auth/password', async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? '');
  const next = String(body.next ?? '/following');

  const result = await auth.verifyPassword({
    email,
    password: String(body.password ?? ''),
    userAgent: c.req.header('user-agent'),
    // Behind Railway's proxy the socket address is the proxy; the forwarded header
    // is the only thing that carries the caller. Recorded for the log, never used
    // as the rate-limit key -- a shared address would then throttle strangers.
    ip: (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || null,
  });

  if (!result.ok) {
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('application/json')) return c.json({ error: result.error }, 401);
    return c.html(
      await render(<SignIn mode="login" next={next} passwordError={result.error} />),
      401,
    );
  }

  // Whoever just proved they hold the password is not who the backoff is for.
  const caller = callerAddress(c);
  if (caller) forgive(`password:${caller}`);

  c.header('set-cookie', auth.sessionCookie(result.sessionId));
  return respond(c, { redirectTo: next });
});

/**
 * Set, change or remove a password, from inside a session.
 *
 * Deliberately only reachable while already signed in by a link or a passkey. That
 * is what keeps this from being a way to take an account over: whoever can set a
 * password here already had the session needed to do anything else anyway.
 */
app.post('/api/auth/password/set', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();

  if (body.remove === 'on' || body.remove === 'true') {
    await auth.removePassword(user.id);
    // Never a lockout: the link and any passkey still work.
    return respond(c, { json: { ok: true }, redirectTo: '/settings?password=removed' });
  }

  const password = String(body.password ?? '');
  if (password !== String(body.confirm ?? '')) {
    return respond(c, {
      json: { error: 'those did not match' },
      status: 400,
      redirectTo: `/settings?password_error=${encodeURIComponent('Those two did not match.')}`,
    });
  }

  const result = await auth.setPassword({ userId: user.id, email: user.email, password });
  if (!result.ok) {
    return respond(c, {
      json: { error: result.error },
      status: 400,
      redirectTo: `/settings?password_error=${encodeURIComponent(result.error)}`,
    });
  }
  return respond(c, { json: { ok: true }, redirectTo: '/settings?password=set' });
});

/**
 * Somebody's profile: what they follow, and what is coming up because of it.
 *
 * Two gates, and the first one is why this can be added without exposing anybody.
 * A profile exists only for an account that CHOSE a handle, and handle is null until
 * somebody types one -- so no existing reader wakes up with a public page. The second
 * is profile_public, which 404s the page to everyone but its owner.
 *
 * 404 rather than 403 on a private profile, because "you are not allowed to see this"
 * confirms the handle is taken, and a private profile that announces itself is only
 * half private.
 *
 * Not Redis-cached: it differs for the owner, and one reader's private profile served
 * to the next visitor is exactly the failure the cache helper warns about.
 */
app.get('/u/:handle', async (c) => {
  const viewer = c.get('user');
  const profile = await q.getUserByHandle(c.req.param('handle'));
  if (!profile) return c.html(await render(<NotFound user={viewer} />), 404);

  const isOwner = viewer?.id === profile.id;
  if (!profile.profile_public && !isOwner) {
    return c.html(await render(<NotFound user={viewer} />), 404);
  }

  // Capped, with the true total beside it. Following everything is one button on
  // /genres, so an uncapped list printed a chip for all 134 active genres onto a
  // public page for anyone who had pressed it. Ported from tipoffwatch, which had
  // the same button and the same page.
  const [follows, followTotal, upcoming] = await Promise.all([
    q.publicFollows(profile.id, { limit: 60 }),
    q.followTotal(profile.id),
    q.upcomingForUser(profile.id, { limit: 20 }),
  ]);

  return c.html(
    await render(
      <ProfilePage
        user={viewer}
        profile={profile}
        follows={follows}
        followTotal={followTotal}
        upcoming={upcoming}
        isOwner={isOwner}
      />,
    ),
  );
});

/* --------------------------------------------------------------- invites -- */

/** How long an opened invite link is remembered while somebody signs up. */
const INVITE_COOKIE = 'gw_invite';
const INVITE_COOKIE_DAYS = 30;

/**
 * Opening somebody's invite link.
 *
 * The code goes into a cookie rather than through the sign-up form, because the way
 * in is an emailed link: the person leaves the site, opens their mail, and comes
 * back through a URL that carries nothing of where they started. The cookie is the
 * only thing that survives that round trip.
 *
 * An unknown code still lands on the sign-up page. Whether a code is real is not
 * worth telling a stranger, and turning somebody away over a typo in a link they
 * were sent would be a strange way to greet them.
 */
app.get('/i/:code', (c) => {
  const code = c.req.param('code');
  if (/^[A-Za-z0-9_-]{6,64}$/.test(code)) {
    setCookie(c, INVITE_COOKIE, code, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.isProd,
      maxAge: INVITE_COOKIE_DAYS * 86400,
    });
  }
  return c.redirect('/signup', 302);
});

/** Your link, who has accepted it, and the form that mails it for you. */
app.get('/invite', async (c) => {
  const user = requireUser(c);
  const [code, accepted, sentToday] = await Promise.all([
    auth.inviteCodeFor(user.id),
    q.invitesAccepted(user.id),
    q.invitesSentSince(user.id, { hours: 24 }),
  ]);

  return c.html(
    await render(
      <Invite
        user={user}
        url={auth.inviteUrl(code)}
        accepted={accepted}
        remaining={Math.max(0, auth.INVITE_DAILY_LIMIT - sentToday)}
        dailyLimit={auth.INVITE_DAILY_LIMIT}
        maxPerSubmission={auth.INVITE_MAX_PER_SUBMISSION}
        notice={c.req.query('sent') ? `Sent ${c.req.query('sent')}.` : null}
        error={c.req.query('invite_error') ?? null}
      />,
    ),
  );
});

/**
 * Mail the link to a few addresses.
 *
 * The reply counts rather than naming per-address outcomes. "Skipped, they already
 * have an account" would make this the address checker that the sign-in page is
 * careful not to be, so an address that was skipped and one that was mailed are
 * reported the same way.
 */
app.post('/api/invite/email', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();

  const result = await auth.sendInvites({
    user,
    raw: body.emails,
    send: sendInviteEmail,
  });

  if (!result.ok) {
    return respond(c, {
      json: { error: result.error },
      status: 400,
      redirectTo: `/invite?invite_error=${encodeURIComponent(result.error)}`,
    });
  }

  const summary =
    result.skipped > 0
      ? `${result.sent}, and skipped ${result.skipped}`
      : `${result.sent === 1 ? '1 invite' : `${result.sent} invites`}`;
  return respond(c, {
    json: { sent: result.sent, skipped: result.skipped },
    redirectTo: `/invite?sent=${encodeURIComponent(summary)}`,
  });
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

/*
 * Both halves of the passkey exchange, on one counter. Asking for options is
 * unauthenticated and writes a challenge to Redis, so it is a free write anybody
 * can ask for in a loop; the verify next to it is the failed-login equivalent.
 * One bucket, because the pair is one flow and metering only half of it just
 * moves the load to the other.
 */
const passkeyBackoff = authBackoff('passkey', (c, retryAfter) =>
  c.json({ error: `Too many attempts. Try again in ${waitFor(retryAfter)}.` }, 429),
);

app.post('/api/auth/passkey/authenticate/options', passkeyBackoff);
app.post('/api/auth/passkey/authenticate/options', async (c) => {
  const options = await auth.passkeyAuthenticationOptions();
  await stashChallenge(c, options.challenge);
  return c.json(options);
});

app.post('/api/auth/passkey/authenticate/verify', passkeyBackoff);
app.post('/api/auth/passkey/authenticate/verify', async (c) => {
  const expectedChallenge = await takeChallenge(c);
  if (!expectedChallenge) return c.json({ error: 'challenge expired' }, 400);
  const result = await auth.verifyPasskeyAuthentication({
    response: await c.req.json(),
    expectedChallenge,
    userAgent: c.req.header('user-agent'),
  });
  if (!result) return c.json({ error: 'rejected' }, 400);

  const caller = callerAddress(c);
  if (caller) forgive(`passkey:${caller}`);

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
    // Validated against a fixed set: subject_type reaches a SQL predicate, and the
    // follows table's own check constraint is the second line of defence, not the
    // first.
    if (!['genre', 'subject'].includes(subjectType) || !Number.isFinite(subjectId)) {
      return c.json({ error: 'bad subject' }, 400);
    }
    await fn({ userId: user.id, subjectType, subjectId });
    return respond(c, { redirectTo: String(body.next ?? '/following') });
  });
}

app.get('/api/subjects/search', async (c) => {
  const term = (c.req.query('q') ?? '').trim();
  if (term.length < 2) return c.json({ results: [] });
  return c.json({ results: await q.searchSubjects(term) });
});

/* ---------------------------------------------------------------- profile -- */

/**
 * The name a person is known by.
 *
 * Ported from upstream alongside the columns. Only the naming half exists here so
 * far, so there is no /u/:handle page yet -- a handle is stored and used to sign
 * comments, and the profile page arrives with the rest of the social layer.
 */
app.post('/api/profile', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const handle = String(body.handle ?? '').trim();

  if (handle && !q.handleAvailableShape(handle)) {
    return respond(c, {
      json: { error: 'bad handle' },
      status: 400,
      redirectTo: `/settings?profile_error=${encodeURIComponent(
        'A handle is 3-30 letters, numbers or underscores, and cannot be a reserved word.',
      )}`,
    });
  }

  const result = await q.updateProfile({
    userId: user.id,
    handle: handle || null,
    displayName: String(body.display_name ?? '').trim() || null,
    bio:
      String(body.bio ?? '')
        .trim()
        .slice(0, 500) || null,
    profilePublic: body.profile_public === 'on' || body.profile_public === 'true',
  });

  if (!result.ok) {
    return respond(c, {
      json: { error: result.error },
      status: 409,
      redirectTo: `/settings?profile_error=${encodeURIComponent(result.error)}`,
    });
  }
  return respond(c, { json: result.user, redirectTo: '/settings?profile=saved' });
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
    // Zero is valid here and not above: "the moment it is out" is a real choice
    // for a dated release, and meaningless for something that already carries a
    // one-minute offset.
    dateOffsetsMinutes: arr(body.date_offsets)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 0),
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
  const [prefs, passkeys, playlist, member, shareCandidates] = await Promise.all([
    q.getPrefs(user.id),
    q.listPasskeys(user.id),
    q.getPlaylist(user.id),
    isMember(user),
    // Fetched unconditionally rather than only for a member: the picker has to be
    // populated the instant somebody joins, and a second round trip after the
    // upgrade is how it renders empty on the one page view that matters.
    q.shareCandidates(user.id),
  ]);
  const added = c.req.query('playlist');
  /*
   * Three outcomes, not one count.
   *
   * A save that only renamed the list, and a save whose provider file had not
   * changed, both come back without a channel count -- and both used to render as
   * "Imported NaN channels", which reads as a failure of the thing that just
   * worked.
   */
  const playlistNotice =
    added === 'renamed'
      ? 'Saved.'
      : added === 'unchanged'
        ? 'Saved. Your provider is serving the same list as last time, so your channels are unchanged.'
        : added
          ? `Imported ${Number(added).toLocaleString('en-US')} channels.`
          : null;

  // Masked here rather than in the view, so the unsealed URL exists for one
  // expression and never becomes a prop that something else could render whole.
  const playlistUrl = playlist ? auth.open(playlist.source_url) : null;
  return c.html(
    await render(
      <Settings
        user={user}
        prefs={
          prefs ?? {
            offsets_minutes: config.reminders.defaultOffsets,
            date_offsets_minutes: config.reminders.dateOffsets,
            channels: ['webpush', 'email'],
          }
        }
        passkeys={passkeys}
        playlist={playlist}
        playlistMasked={playlistUrl ? maskPlaylistUrl(playlistUrl) : null}
        playlistUnreadable={Boolean(playlist) && !playlistUrl}
        playlistNotice={playlistNotice}
        playlistError={c.req.query('playlist_error') ?? null}
        profileNotice={c.req.query('profile') ? 'Saved.' : null}
        profileError={c.req.query('profile_error') ?? null}
        passwordNotice={
          c.req.query('password') === 'set'
            ? 'Password saved. You can sign in with it on a device that cannot do the others.'
            : c.req.query('password') === 'removed'
              ? 'Password removed. Links and passkeys still work.'
              : null
        }
        passwordError={c.req.query('password_error') ?? null}
        member={member}
        shareCandidates={shareCandidates}
        passwordMinLength={auth.PASSWORD_MIN_LENGTH}
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
      'GET /api/v1/categories': 'Every category, with genre and upcoming counts.',
      'GET /api/v1/genres?category=tv': 'Genres, optionally filtered by category.',
      'GET /api/v1/events?genre=drama-tv&category=tv&limit=100':
        'Upcoming events. Both filters optional; limit caps at 200.',
    },
    note:
      'Every event carries time_known and precision. A false time_known means the ' +
      'date is real and the clock time is not -- do not render it as a time.',
  });
});

app.get('/api/v1/categories', async (c) => {
  c.header('cache-control', 'public, max-age=300');
  return c.json({ categories: await q.listCategories() });
});

app.get('/api/v1/genres', async (c) => {
  const genres = await q.listGenres({ category: c.req.query('category') ?? null, limit: 1000 });
  c.header('cache-control', 'public, max-age=300');
  return c.json({
    genres: genres.map((g) => ({
      slug: g.slug,
      name: g.name,
      category: g.category,
      upcoming: g.upcoming,
    })),
  });
});

app.get('/api/v1/events', async (c) => {
  const events = await q.publicEvents({
    genreSlug: c.req.query('genre') ?? null,
    category: c.req.query('category') ?? null,
    limit: Math.min(Number(c.req.query('limit') ?? 100) || 100, 200),
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
  return c.body(
    buildCalendar(events, { name: 'GenreWatch - my calendar', siteUrl: config.siteUrl }),
  );
});

/** A whole genre's calendar, public and shareable. */
app.get('/calendar/genre/:file', async (c) => {
  const m = /^([a-z0-9._-]+)\.ics$/i.exec(c.req.param('file'));
  if (!m) return c.notFound();
  const genre = await q.getGenreBySlug(m[1]);
  if (!genre) return c.notFound();

  const events = await q.upcomingForGenre(genre.id, { limit: 200 });
  c.header('content-type', 'text/calendar; charset=utf-8');
  c.header('cache-control', 'public, max-age=900');
  return c.body(
    buildCalendar(events, { name: `GenreWatch - ${genre.name}`, siteUrl: config.siteUrl }),
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
      title: 'GenreWatch - everything',
      description: 'Every release, premiere, airing and launch we track, soonest first.',
      feedUrl: `${config.siteUrl}/feeds/all.xml`,
      siteUrl: config.siteUrl,
    }),
  );
});

/**
 * One route for category, genre and subject feeds.
 *
 * Separate routes would be three near-identical handlers; the scope is validated
 * against a fixed set so the path cannot select an arbitrary column, and each
 * scope is resolved to an id before it reaches a query.
 */
app.get('/feeds/:scope/:file', async (c) => {
  const scope = c.req.param('scope');
  const m = /^([a-z0-9._-]+)\.xml$/i.exec(c.req.param('file'));
  if (!m || !['category', 'genre', 'subject'].includes(scope)) return c.notFound();
  const key = m[1];

  let label = key.replace(/-/g, ' ');
  let link = config.siteUrl;
  const filter = { limit: 150 };

  if (scope === 'genre') {
    const genre = await q.getGenreBySlug(key);
    if (!genre) return c.notFound();
    filter.genreId = genre.id;
    label = genre.name;
    link = `${config.siteUrl}/genres/${key}`;
  } else if (scope === 'subject') {
    const subject = await q.getSubjectBySlug(key);
    if (!subject) return c.notFound();
    filter.subjectId = subject.id;
    label = subject.display_name;
    link = `${config.siteUrl}/subjects/${key}`;
  } else {
    if (!CATEGORIES.includes(key)) return c.notFound();
    filter.category = key;
    link = `${config.siteUrl}/categories/${key}`;
  }

  const events = await q.feedEvents(filter);
  // An empty feed for a name nobody publishes is a 404, not a valid empty channel.
  if (events.length === 0) return c.notFound();

  feedHeaders(c, 300);
  return c.body(
    buildFeed(events, {
      title: `GenreWatch - ${label}`,
      description: `What is coming up in ${label}.`,
      feedUrl: `${config.siteUrl}/feeds/${scope}/${key}.xml`,
      siteUrl: config.siteUrl,
      link,
    }),
  );
});

app.get('/feeds', async (c) =>
  cached(c, 'page:feeds', 900, async () => {
    const [categories, genres] = await Promise.all([q.listCategories(), q.genresWithUpcoming(120)]);
    return render(<Feeds user={c.get('user')} categories={categories} genres={genres} />);
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
    `<sitemap><loc>${config.siteUrl}/sitemaps/genres.xml</loc></sitemap>`,
    `<sitemap><loc>${config.siteUrl}/sitemaps/subjects.xml</loc></sitemap>`,
    `<sitemap><loc>${config.siteUrl}/sitemaps/feeds.xml</loc></sitemap>`,
    `<sitemap><loc>${config.siteUrl}/sitemaps/profiles.xml</loc></sitemap>`,
    ...months.map(
      (m) =>
        `<sitemap><loc>${config.siteUrl}/sitemaps/events-${m.month}.xml</loc>` +
        (m.updated_at ? `<lastmod>${iso(m.updated_at)}</lastmod>` : '') +
        '</sitemap>',
    ),
  ];
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</sitemapindex>`,
  );
});

app.get('/sitemaps/static.xml', (c) => {
  const paths = [
    '/',
    '/genres',
    '/feeds',
    '/about',
    '/login',
    '/signup',
    ...CATEGORIES.map((name) => `/categories/${name}`),
  ];
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
  const genres = await q.genresWithUpcoming(400);
  const urls = [
    '/feeds',
    '/feeds/all.xml',
    ...CATEGORIES.map((name) => `/feeds/category/${name}.xml`),
    ...genres.map((g) => `/feeds/genre/${g.slug}.xml`),
  ];
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map((u) => `<url><loc>${config.siteUrl}${u}</loc><changefreq>hourly</changefreq></url>`)
      .join('')}</urlset>`,
  );
});

app.get('/sitemaps/genres.xml', async (c) => {
  const genres = await q.listGenres({ limit: 1000 });
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${genres
      .map(
        (g) =>
          `<url><loc>${config.siteUrl}/genres/${g.slug}</loc><changefreq>daily</changefreq></url>`,
      )
      .join('')}</urlset>`,
  );
});

app.get('/sitemaps/subjects.xml', async (c) => {
  const subjects = await q.subjectsWithUpcoming(5000);
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${subjects
      .map(
        (x) =>
          `<url><loc>${config.siteUrl}/subjects/${x.slug}</loc>` +
          (x.updated_at ? `<lastmod>${iso(x.updated_at)}</lastmod>` : '') +
          '</url>',
      )
      .join('')}</urlset>`,
  );
});

/**
 * Public profiles.
 *
 * Priority is left off deliberately: a profile is not more or less important than a
 * release, and every search engine that ever used the field ignores it now. lastmod
 * is the account's creation, which is the only timestamp a profile row actually has
 * -- claiming a fresher one on every crawl would be a lie that teaches the crawler to
 * stop trusting the field.
 *
 * The query filters out thin profiles; see publicProfiles. Removal needs no cleanup,
 * because this is generated per request rather than stored.
 */
app.get('/sitemaps/profiles.xml', async (c) => {
  const people = await q.publicProfiles();
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${people
      .map(
        (p) =>
          `<url><loc>${config.siteUrl}/u/${encodeURIComponent(p.handle)}</loc>` +
          (p.created_at ? `<lastmod>${iso(p.created_at)}</lastmod>` : '') +
          '</url>',
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
 *
 * `maskable` is its own entry rather than a second purpose on the full-bleed
 * art. A launcher crops a maskable icon to a safe-zone circle of 80% diameter,
 * so declaring the edge-to-edge mark maskable cost it the antenna, both side
 * tiles and the bottom camera. The -maskable files carry that inset already,
 * on an opaque ground -- a transparent maskable gets whatever the launcher
 * paints behind it.
 */
app.get('/manifest.webmanifest', (c) =>
  c.json({
    name: 'GenreWatch',
    short_name: 'GenreWatch',
    description: 'Follow a genre or a name and get told before it drops.',
    start_url: '/following',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#12161f',
    theme_color: '#12161f',
    icons: [
      ...[48, 128, 192, 256, 384, 512].map((s) => ({
        src: assetUrl(`icons/icon-${s}x${s}.png`),
        sizes: `${s}x${s}`,
        type: 'image/png',
        purpose: 'any',
      })),
      ...[192, 512].map((s) => ({
        src: assetUrl(`icons/icon-${s}x${s}-maskable.png`),
        sizes: `${s}x${s}`,
        type: 'image/png',
        purpose: 'maskable',
      })),
    ],
  }),
);

/*
 * `Allow: /` with nothing excluded, which is what this said, is an invitation to
 * crawl the sign-in page -- and one SEO bot took it, fetching /login about once a
 * second, forty-seven percent of all traffic to the site. It was not doing
 * anything wrong; nobody had told it not to.
 *
 * None of these paths should ever be crawled or indexed. They are the same page
 * for every signed-out visitor, they carry nothing a search result should point
 * at, and /api/ answers callers rather than readers.
 */
app.get('/robots.txt', (c) => c.text(robotsTxt()));

const STATIC_FILES = [
  ['/styles.css', 'styles.css', 'text/css'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/push-check.js', 'push-check.js', 'text/javascript'],
  ['/vendor-webauthn.js', 'vendor-webauthn.js', 'text/javascript'],
  // The transport-stream demuxer. Served like the others but never linked from
  // the layout: it is a few hundred kilobytes and app.js injects the tag only
  // when somebody actually presses Play.
  ['/vendor-mpegts.js', 'vendor-mpegts.js', 'text/javascript'],
  ['/sw.js', 'sw.js', 'text/javascript'],
  ['/logo.png', 'logo.png', 'image/png'],
  // Header logo, in two shapes. The originals are 436KB and 722KB -- fine as
  // source art, absurd in a header -- so these are the web-sized derivatives.
  ['/logo-wide.png', 'logo-wide.png', 'image/png'],
  ['/logo-mark.png', 'logo-mark.png', 'image/png'],
];

/**
 * The icons the markup and the manifest link, hashed alongside the other assets.
 *
 * They are cached for a week, so redrawing one under its own name -- which is
 * what fixing an icon means -- reaches nobody who has visited recently. The
 * install prompt in particular reads the manifest and keeps whatever it got.
 */
const VERSIONED_ICONS = [
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  ...[76, 120, 144, 152, 180].map((s) => `icons/apple-touch-icon-${s}x${s}.png`),
  ...[48, 128, 192, 256, 384, 512].map((s) => `icons/icon-${s}x${s}.png`),
  ...[192, 512].map((s) => `icons/icon-${s}x${s}-maskable.png`),
];

// Hashed once at boot so pages can link /styles.css?v=<hash>. See lib/asset-version.js.
await loadAssetVersions([...STATIC_FILES.map(([, file]) => file), ...VERSIONED_ICONS]);

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
  if (isCurrentVersion(`icons/${file}`, c.req.query('v'))) {
    // The URL carries the content hash, so these bytes cannot change under it.
    c.header('cache-control', 'public, max-age=31536000, immutable');
  } else {
    // Unversioned: a bare /icons/... hit, or cached markup pointing at an older
    // hash. Kept short so a redrawn icon is not pinned for a week.
    c.header('cache-control', 'public, max-age=3600, must-revalidate');
  }
  return c.body(await f.arrayBuffer());
});

/** Browsers request this at the root regardless of what the markup declares. */
app.get('/favicon.ico', async (c) => {
  const f = Bun.file(new URL('../public/icons/favicon.ico', import.meta.url).pathname);
  c.header('content-type', 'image/x-icon');
  c.header('cache-control', 'public, max-age=604800');
  return c.body(await f.arrayBuffer());
});

/*
 * The last stop for a path this app does not have, and the only place a scanner
 * can be counted.
 *
 * Mostly what lands here asked for a path this app has never had, which readers
 * do rarely and scanners do hundreds of times in a row. The pages that answer a
 * reader's dead link -- a title that is no longer listed, a profile that is
 * private -- render `<NotFound>` inside their own route and never reach this
 * handler, so a person following a stale link out of somebody's timeline is not
 * metered at all.
 *
 * The exception is the machine-facing routes that answer with a bare
 * `c.notFound()`: a calendar or RSS subscription to something that no longer
 * exists, or an icon hash from a cached page. Those DO land here and are
 * counted, and that is acceptable precisely because of the next paragraph -- a
 * calendar client polling a dead feed hourly would need a day to reach the
 * allowance, and all it would get for it is a 429 where it was already getting
 * a 404.
 *
 * The refusal is deliberately confined to the miss itself. A locked caller is
 * still served normally by every route that exists, because the counter only
 * ever runs on this handler -- so the worst a false positive can do is answer
 * 429 instead of 404 to somebody who was going to get nothing either way. That
 * is the whole reason this can be turned on at all: unlike the auth curves,
 * this one cannot lock anybody out of anything real.
 */
app.notFound(async (c) => {
  const caller = callerAddress(c);
  if (caller) {
    const verdict = attempt(`miss:${caller}`, Date.now(), MISS);
    if (!verdict.ok) {
      console.warn(
        `[auth] miss backoff: ${caller} strike ${verdict.strikes}, ${verdict.retryAfter}s`,
      );
      c.header('retry-after', String(verdict.retryAfter));
      // A 429 that got cached would outlive the lock it was reporting.
      c.header('cache-control', 'no-store');
      // Text, not the rendered page: refusing has to be cheaper than answering,
      // or a limiter on a flood is just a slower way to serve the flood.
      return c.text(`Too many requests. Try again in ${waitFor(verdict.retryAfter)}.`, 429);
    }
  }
  return c.html(await render(<NotFound user={c.get('user')} />), 404);
});
