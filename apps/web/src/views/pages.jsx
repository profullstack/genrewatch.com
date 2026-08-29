import { assetUrl } from '../lib/asset-version.js';
import {
  Ad,
  EventList,
  FollowButton,
  GenreChips,
  LocalTime,
  StartTime,
  SubjectRow,
  whenLabel,
} from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * What to sign a comment with.
 *
 * Order matters and is the whole point: a chosen display name, then the handle,
 * and only then the local part of an email address. That last one used to be the
 * ONLY option, so every public comment was signed with a fragment of the author's
 * address -- something they never chose to publish, on a page anyone can read
 * without an account. It survives as a fallback for accounts that have not picked
 * a name, and nothing beyond the local part is ever rendered.
 */
function commenterName(c) {
  return c.display_name || (c.handle ? `@${c.handle}` : String(c.email ?? '?').split('@')[0]);
}

/**
 * What each category is called, and what it actually covers.
 *
 * In one place because the words appear on the nav, the category page, the feeds
 * page and the about page, and the last time a label like this lived in four
 * templates they disagreed with each other within a month.
 */
export const CATEGORY_LABEL = {
  tv: { name: 'Television', blurb: 'Episodes and premieres, with real air times.' },
  film: { name: 'Film', blurb: 'Cinema release dates, soonest first.' },
  anime: { name: 'Anime', blurb: 'Every simulcast airing, to the minute.' },
  music: { name: 'Music', blurb: 'Album and single release dates.' },
  space: { name: 'Spaceflight', blurb: 'Rocket launches and their windows.' },
};

const labelFor = (c) => CATEGORY_LABEL[c]?.name ?? c;

/**
 * Deep links into a player that can actually handle these streams.
 *
 * The .m3u hand-off is right on a desktop and useless on a phone: iOS Safari either
 * saves the playlist or follows it and offers to save a .ts, and neither plays,
 * because these providers serve MPEG-2 Transport Stream and Safari has no demuxer
 * for it. That is a missing codec, not a missing header. Both players worth naming
 * register a URL scheme instead, so a tap opens the app already on the stream.
 *
 * The stream URL is in the href and has to be: an external player holds no session
 * with us and cannot fetch an authenticated endpoint. It is the reader's own
 * credential on the reader's own signed-in page, which is the same exposure the
 * .m3u download already carried.
 */
const playerLinks = (url) => {
  const target = encodeURIComponent(url);
  return {
    // The documented VLC-iOS form; VLC on Android registers the same handler.
    vlc: `vlc-x-callback://x-callback-url/stream?url=${target}`,
    infuse: `infuse://x-callback-url/play?url=${target}`,
  };
};

/** The category strip that heads most pages. */
const CategoryNav = ({ current }) => (
  <nav class="cats" aria-label="Categories">
    {Object.entries(CATEGORY_LABEL).map(([slug, meta]) => (
      <a class={slug === current ? 'cat current' : 'cat'} href={`/categories/${slug}`}>
        {meta.name}
      </a>
    ))}
    {/*
      Sports is a real thing readers look for and a thing this site deliberately
      does not carry, so it is a signpost rather than a missing item. Marked
      external so nobody clicks it expecting to stay here.
    */}
    <a class="cat external" href="/sports" rel="external">
      Sports ↗
    </a>
  </nav>
);

export const Landing = ({ user, today, vapidKey }) => (
  <Layout title="Know before it drops" user={user} vapidKey={vapidKey}>
    <section class="hero">
      <h1>Know before it drops.</h1>
      <p class="lede">
        Follow a genre or a name — a show, a film, an artist, a rocket — and we will tell you before
        it is out. Free, no ads, and it works as a calendar feed if you would rather not be notified
        at all.
      </p>
      {user ? (
        <a class="cta" href="/following">
          Your calendar
        </a>
      ) : (
        <a class="cta" href="/signup">
          Create a free account
        </a>
      )}
    </section>

    <CategoryNav />

    <section>
      <h2>Today</h2>
      <EventList events={today} emptyText="Nothing lands today. Try a genre." />
      <p class="more">
        <a href="/genres">Browse every genre →</a>
      </p>
    </section>
  </Layout>
);

/** Every genre we carry, grouped by category. */
export const GenresIndex = ({
  user,
  categories,
  genres,
  genreCounts,
  upcoming,
  soon = [],
  soonTotal = 0,
  soonHours = 4,
}) => {
  const byCategory = new Map();
  for (const g of genres) {
    if (!byCategory.has(g.category)) byCategory.set(g.category, []);
    byCategory.get(g.category).push(g);
  }

  return (
    <Layout title="Every genre" user={user}>
      <h1>Every genre</h1>
      <p class="muted">
        {genres.length.toLocaleString('en-US')} genres across {categories.length} categories.
        Following a genre means you hear about everything filed under it.
      </p>

      {/* Follow everything, with the size of "everything" stated before it is
          pressed rather than discovered afterwards. Following every genre means a
          reminder for every release in the catalogue at every offset turned on,
          which is thousands of notifications -- a button that enrols someone in
          that quietly is not a feature, it is a trap. */}
      {user && genreCounts ? (
        <section class="follow-all card">
          <div class="card-head">
            <h2 class="card-title">
              {genreCounts.following >= genreCounts.total
                ? 'You follow every genre'
                : 'Follow everything'}
            </h2>
            <p class="card-desc">
              {genreCounts.following >= genreCounts.total
                ? `All ${genreCounts.total.toLocaleString('en-US')} genres. You will be told about every release in the catalogue.`
                : `All ${genreCounts.total.toLocaleString('en-US')} genres in one go — about ${(upcoming ?? 0).toLocaleString('en-US')} releases in the next fortnight, and a reminder for each one at every offset you have turned on.`}
              {genreCounts.following > 0 && genreCounts.following < genreCounts.total
                ? ` You follow ${genreCounts.following.toLocaleString('en-US')} so far.`
                : ''}
            </p>
          </div>
          <div class="card-actions">
            {genreCounts.following < genreCounts.total ? (
              <form method="post" action="/api/follow-all" class="inline">
                <button class="cta" type="submit">
                  Follow everything!
                </button>
              </form>
            ) : null}
            {genreCounts.following > 0 ? (
              <form method="post" action="/api/unfollow-all" class="inline">
                <button class="ghost" type="submit">
                  Unfollow all genres
                </button>
              </form>
            ) : null}
          </div>
        </section>
      ) : null}

      <CategoryNav />

      {[...byCategory.entries()].map(([category, list]) => (
        <section>
          <h2>
            <a href={`/categories/${category}`}>{labelFor(category)}</a>
          </h2>
          <ul class="genre-grid">
            {list.map((g) => (
              <li class={g.upcoming > 0 ? 'genre' : 'genre quiet'}>
                <a href={`/genres/${g.slug}`}>{g.name}</a>
                <span class="meta">
                  {g.upcoming > 0 ? `${g.upcoming.toLocaleString('en-US')} coming` : 'quiet'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/*
        What is out in the next few hours.

        Ported from the sibling brand, where it sits under the categories for the
        same reason: this page's job is to get somebody to a genre, and this is the
        shortcut for the reader who does not want to pick one.

        Only rows with a real clock time can appear, which on this site is a
        minority -- most releases carry a date and nothing finer. That is stated
        rather than hidden, because a short list here is a fact about what is
        announced, not about the site.
      */}
      <section class="live-now">
        <div class="live-head">
          <h2>Out in the next few hours</h2>
          {soonTotal > 0 ? (
            <span class="live-count num" title={`${soonTotal} in the next ${soonHours} hours`}>
              {soonTotal.toLocaleString('en-US')}
            </span>
          ) : null}
        </div>
        {soon.length > 0 ? (
          <p class="muted small">
            Anything with a real start time landing in the next {soonHours} hours, soonest first.
            Releases carrying only a date are not here — they have no hour to count down to.
            {soonTotal > soon.length ? ` Showing the first ${soon.length}.` : ''}
          </p>
        ) : null}
        <EventList
          events={soon}
          emptyText="Nothing with a start time lands in the next few hours."
        />
      </section>
    </Layout>
  );
};

export const CategoryPage = ({ user, category, genres, events }) => {
  const meta = CATEGORY_LABEL[category] ?? { name: category, blurb: '' };
  return (
    <Layout title={meta.name} user={user}>
      <h1>{meta.name}</h1>
      <p class="muted">{meta.blurb}</p>
      <CategoryNav current={category} />

      <section>
        <h2>Genres</h2>
        <ul class="genre-grid">
          {genres.map((g) => (
            <li class={g.upcoming > 0 ? 'genre' : 'genre quiet'}>
              <a href={`/genres/${g.slug}`}>{g.name}</a>
              <span class="meta">
                {g.upcoming > 0 ? `${g.upcoming.toLocaleString('en-US')} coming` : 'quiet'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Today</h2>
        <EventList events={events} emptyText="Nothing in this category today." />
        <p class="more">
          <a href={`/feeds/category/${category}.xml`}>RSS</a>
        </p>
      </section>

      <Ad />
    </Layout>
  );
};

export const GenrePage = ({ user, genre, subjects, events, following }) => (
  <Layout title={genre.name} user={user}>
    <header class="page-head">
      <div>
        <h1>{genre.name}</h1>
        <p class="muted">
          <a href={`/categories/${genre.category}`}>{labelFor(genre.category)}</a>
          {` · ${events.length.toLocaleString('en-US')} coming up`}
        </p>
      </div>
      <FollowButton
        user={user}
        subjectType="genre"
        subjectId={genre.id}
        following={following}
        next={`/genres/${genre.slug}`}
        label={genre.name}
      />
    </header>

    <section>
      <h2>Coming up</h2>
      <EventList events={events} emptyText="Nothing scheduled in this genre yet." />
    </section>

    {/* Between the two lists: a real seam in the page, where a reader has
        finished one thing and not started the next. Not floated beside the
        content, and not at the very bottom where it would be billed without
        ever being looked at. */}
    <Ad />

    <section>
      <h2>Names in {genre.name}</h2>
      <p class="muted small">
        Follow one of these instead if you only want that, rather than the whole genre.
      </p>
      {subjects.length === 0 ? (
        <p class="empty">Nothing filed here yet.</p>
      ) : (
        <ul class="subjects">
          {subjects.map((s) => (
            <SubjectRow subject={s} user={user} next={`/genres/${genre.slug}`} />
          ))}
        </ul>
      )}
    </section>

    <p class="more">
      <a href={`/feeds/genre/${genre.slug}.xml`}>RSS</a>
      {' · '}
      <a href={`/calendar/genre/${genre.slug}.ics`}>Calendar feed</a>
    </p>
  </Layout>
);

export const SubjectPage = ({
  user,
  subject,
  events,
  past = [],
  genres,
  following,
  ownChannels = null,
  sharedChannels = null,
}) => (
  <Layout title={subject.display_name} user={user}>
    <header class="page-head">
      <div class="subject-head">
        {subject.image_url ? (
          <img src={subject.image_url} alt="" width="64" height="64" loading="lazy" />
        ) : null}
        <div>
          <h1>{subject.display_name}</h1>
          <p class="muted">
            {subject.kind}
            {' · '}
            <a href={`/categories/${subject.category}`}>{labelFor(subject.category)}</a>
          </p>
        </div>
      </div>
      <FollowButton
        user={user}
        subjectType="subject"
        subjectId={subject.id}
        following={following}
        next={`/subjects/${subject.slug}`}
        label={subject.display_name}
      />
    </header>

    {subject.description ? <p class="blurb">{subject.description}</p> : null}
    <GenreChips genres={genres} />

    {/*
      The question somebody who searched for a film actually has.

      This page used to be a title, a poster and "Nothing scheduled" -- it listed
      upcoming events and never once looked at the reader's own list, so a film
      from 2022 was a dead end that read exactly like a provider not carrying it.
      It goes above the schedule because for a back catalogue title it IS the
      answer, and the schedule is the empty part.
    */}
    <OwnLine own={ownChannels} shared={sharedChannels} title={subject.display_name} />

    <section>
      <h2>Coming up</h2>
      <EventList
        events={events}
        emptyText={past.length > 0 ? 'Nothing new scheduled.' : 'Nothing scheduled.'}
      />
    </section>

    {/* Already out. Bounded to a dozen: this is "what is this and can I watch it",
        not an archive of fourteen seasons. */}
    {past.length > 0 ? (
      <section>
        <h2>Already out</h2>
        <EventList events={past} emptyText="Nothing yet." />
      </section>
    ) : null}

    <p class="more">
      <a href={`/feeds/subject/${subject.slug}.xml`}>RSS</a>
      {subject.url ? (
        <>
          {' · '}
          <a href={subject.url} rel="noopener nofollow external">
            More about {subject.display_name} ↗
          </a>
        </>
      ) : null}
    </p>
  </Layout>
);

/**
 * One entry from the reader's own list, with room for a verdict.
 *
 * The three tiers rendered the same markup three times, and all three now need
 * the same two attributes and the same state slot.
 *
 * `data-check` is the route that asks the provider whether this entry is actually
 * there; app.js walks the rows in order and clears them one at a time. The URL is
 * the check, never the stream: the provider URL belongs in the VLC href, where an
 * app that holds no session with us needs it, and nowhere else.
 *
 * `data-verified` is set when the server already knows -- a yes from the last ten
 * minutes -- so reopening a page does not re-probe a line that caps connections.
 *
 * The state span ships empty. Everything it ever says is a fact the page did not
 * have when it was rendered.
 */
/**
 * The Play button, which is not an anchor and not always usable.
 *
 * Rendered as a disabled button and enabled by app.js once two things have been
 * established: that this browser has Media Source Extensions, and that the
 * provider is actually sending this entry. Both are facts the server does not
 * have -- the first is about the device and this page is served identically to
 * every device, the second needs a probe -- so the safe direction is upward. A
 * reader whose scripting is off, or whose browser cannot transmux, sees a control
 * that plainly cannot be pressed next to two that can, rather than a live-looking
 * button that does nothing.
 *
 * `data-play` carries the route rather than the stream. The provider URL is in
 * the VLC and Infuse hrefs because an external app cannot hold our session; the
 * page can, so nothing here needs the credential.
 */
const PlayButton = ({ channelId }) => (
  <button
    type="button"
    class="ghost small-btn play-btn"
    disabled
    data-play={`/my/channels/${channelId}/stream.ts`}
  >
    Play here
  </button>
);

export const ChannelRow = ({ ch }) => {
  /*
   * Every control that goes through this server needs the row id, and a row
   * without one would render "/my/channels/undefined/check" -- a link that looks
   * live and 404s. Rows come from the database and always have an id, so this is
   * a guard rather than a case: without one the entry is still offered to the
   * apps that take a URL, and nothing false is shown.
   */
  const mine = Number.isFinite(Number(ch.id)) ? Number(ch.id) : null;
  return (
    <li
      data-check={mine ? `/my/channels/${mine}/check` : null}
      data-verified={ch.verified ? '1' : null}
    >
      <span class="own-channel-name">
        {ch.title || 'Untitled entry'}
        {/* What the provider files this entry under, and whether it is a channel
            or a file. Both come straight from the playlist rather than from us: a
            reader looking at ten near-identical rows needs the same words their
            own player shows them, not our guess at what they mean. */}
        {ch.group ? <span class="genre-tag channel-tag">{ch.group}</span> : null}
        {ch.kind && ch.kind !== 'live' ? (
          <span class="genre-tag channel-tag kind" title="A file, not a live channel">
            {ch.kind === 'series' ? 'Series' : 'On demand'}
          </span>
        ) : null}
      </span>
      <span class="own-channel-state" />
      <span class="own-channel-actions">
        {mine ? <PlayButton channelId={mine} /> : null}
        <a class="cta small-btn" href={playerLinks(ch.url).vlc}>
          VLC
        </a>
        <a class="ghost small-btn" href={playerLinks(ch.url).infuse}>
          Infuse
        </a>
        {mine ? (
          <a class="ghost small-btn" href={`/my/channels/${mine}/playlist.m3u`}>
            .m3u
          </a>
        ) : null}
      </span>
    </li>
  );
};

/**
 * The reader's own list, matched against one title.
 *
 * One component rather than two, because this is the same question asked from two
 * pages -- and it only ever ran on one of them. A search result links to a
 * SUBJECT, and that page listed upcoming events and nothing else, so a film from
 * 2022 gave "Nothing scheduled" and never consulted the reader's list at all.
 * From the outside that is indistinguishable from a provider that does not carry
 * it, which is exactly how it was read.
 *
 * Rows are addressed by their row id rather than by a position in a ranked list,
 * so the same markup works wherever the ranking was done.
 */
export const OwnLine = ({ own, shared, streamDead, title }) => {
  const hasOwn = own?.hasList;
  /*
   * Anything shared at all, not just anything that matched. Rendering only on a
   * hit made "nobody has opened a list" and "somebody has, and none of it names
   * this title" identical from the outside -- and the second one reads as the
   * feature being broken, which is how it was reported.
   */
  const hasShared = shared?.channelCount > 0;
  if (!hasOwn && !hasShared) return null;

  return (
    <>
      {hasOwn ? (
        <section class="own-line" data-player-src={assetUrl('vendor-mpegts.js')}>
          <h2>In your list</h2>

          {/* Why the last attempt handed back nothing, in the words of the probe.
              "returned a web page, not a stream" means the slot is empty;
              "timed out" means it is not. */}
          {streamDead ? (
            <p class="feedback error" role="status">
              That one did not play — {streamDead}. The others are still listed; a provider slot
              often fills only once the thing is actually on.
            </p>
          ) : null}

          {/* On demand first: it is there whenever they want it, where a channel
              is a claim about right now. */}
          {own.onDemand?.length > 0 ? (
            <>
              <h3>Available on demand</h3>
              <ul class="channels">
                {own.onDemand.map((ch) => (
                  <ChannelRow ch={ch} />
                ))}
              </ul>
            </>
          ) : null}

          {own.matches.length > 0 ? (
            <>
              <p class="muted small">
                From the playlist you added. Each one is checked against your provider before it is
                offered — a slot can be listed and still be empty. VLC, Infuse and .m3u hand the
                entry straight to your own player and never touch our servers. “Play here” is the
                exception, for a television or a locked-down desktop with no app to hand it to: it
                passes through us, to your session only, and is never cached or shared.
              </p>
              <ul class="channels">
                {own.matches.map((ch) => (
                  <ChannelRow ch={ch} />
                ))}
              </ul>
            </>
          ) : own.onDemand?.length > 0 || own.unavailable?.length > 0 ? null : (
            <p class="empty">
              None of your {own.channelCount.toLocaleString('en-US')} entries look like they carry{' '}
              {title ? <strong>{title}</strong> : 'this'}. Provider names vary a lot, so it may be
              in there under a name we did not recognise —{' '}
              <a href="/my/channels">browse your list</a> to see what you actually have.
            </p>
          )}

          {/*
            On the list, and refused by the provider when we last asked.
            
            These used to be filtered out in the query, which made a title the
            provider consistently fails flicker on a thirty-minute cycle: shown,
            probed, 404, hidden for half an hour, shown again. So whether the page
            had your film depended on when you looked, and it never said why.
            Reported instead of offered -- there is no Play button here, because
            there is nothing behind it.
          */}
          {own.unavailable?.length > 0 ? (
            <>
              <h3>On your list, but your provider will not serve it</h3>
              <p class="muted small">
                {own.unavailable.length === 1 ? 'This entry names' : 'These entries name'}{' '}
                {title ? <strong>{title}</strong> : 'this'}, so your list does have it. Asking your
                line for {own.unavailable.length === 1 ? 'it' : 'them'} came back with an error, so
                there is nothing to play. That is your provider's side, not a naming problem — it is
                worth raising with them.
              </p>
              <ul class="channels">
                {own.unavailable.map((ch) => (
                  <li class="channel dead">
                    <span class="ch-name">{ch.title}</span>
                    <span class="meta">unavailable from your provider</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {/* A different claim, worded as one: a 24/7 genre channel carries
              whatever is on, which is not the same as having this. */}
          {own.genre?.length > 0 ? (
            <>
              <h3>Channels for this genre</h3>
              <p class="muted small">
                These carry the genre rather than this specific thing, so they may or may not be
                showing it.
              </p>
              <ul class="channels">
                {own.genre.map((ch) => (
                  <ChannelRow ch={ch} />
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {hasShared ? (
        <section class="own-line shared-line" data-player-src={assetUrl('vendor-mpegts.js')}>
          <h2>Shared with you</h2>
          {shared.channels.length > 0 ? (
            <>
              <p class="muted small">
                From {shared.owners === 1 ? 'a list' : `${shared.owners} lists`} other people have
                opened to everyone signed in. These play here and nowhere else — you never get the
                address — and one person at a time, because that is what a provider line allows. See{' '}
                <a href="/shared">whose lists are open</a>.
              </p>
              <ul class="channels">
                {shared.channels.map((ch) => (
                  <SharedChannelRow ch={ch} />
                ))}
              </ul>
            </>
          ) : (
            <p class="muted">
              None of the {shared.channelCount.toLocaleString('en-US')} channels shared with you
              name this. See <a href="/shared">whose lists are open</a>.
            </p>
          )}
        </section>
      ) : null}
    </>
  );
};

/**
 * A shared entry, playable and nothing else.
 *
 * Deliberately not ChannelRow. That component offers VLC, Infuse and a .m3u
 * download, and every one of those works by handing over the stream URL — which
 * on somebody else's line is their provider username and password. This row has
 * one control, and the absence of the other three is the security property rather
 * than an omission.
 *
 * `data-check` and `data-play` are keyed by channel id rather than by an index
 * into a ranked list: there is no per-viewer ranking to index into when the list
 * is not the viewer's own.
 */
export const SharedChannelRow = ({ ch }) => (
  <li data-check={`/shared/${ch.id}/check`}>
    <span class="own-channel-name">
      {ch.title || 'Untitled entry'}
      {ch.group ? <span class="genre-tag channel-tag">{ch.group}</span> : null}
      <span class="genre-tag channel-tag owner" title="Whose list this is on">
        {ch.ownerLabel}
      </span>
    </span>
    <span class="own-channel-state" />
    <span class="own-channel-actions">
      <button
        type="button"
        class="ghost small-btn play-btn"
        disabled
        data-play={`/shared/${ch.id}/stream.ts`}
      >
        Play here
      </button>
    </span>
  </li>
);

/**
 * Who has opened their list, and how big it is.
 *
 * What this page does not have is the point: no titles, no groups, no addresses,
 * nothing that could be scraped into a directory of somebody else's subscription.
 * It says who is sharing and roughly how much, and everything else is answered on
 * a page for a specific thing.
 */
export const SharedLists = ({ user, owners }) => (
  <Layout title="Shared lists" user={user}>
    <h1>Shared lists</h1>
    <p class="muted">
      Lists other people have opened to everyone signed in. You can play from them on the page for
      something they carry — you never get the address, and only one person can watch a given line
      at a time, because that is what a provider subscription allows.
    </p>

    {owners.length === 0 ? (
      <p class="empty">
        Nobody has shared a list yet. You can open yours in <a href="/settings">settings</a>.
      </p>
    ) : (
      <ul class="results">
        {owners.map((o) => (
          <li class="result">
            <span class="subject-blank" />
            <div class="result-main">
              {o.handle ? (
                <a href={`/u/${o.handle}`}>{o.label}</a>
              ) : (
                <span class="result-name">{o.label}</span>
              )}
              <span class="meta">
                {(o.channel_count ?? 0).toLocaleString('en-US')} entries
                {o.last_synced_at ? (
                  <>
                    {' · updated '}
                    <LocalTime at={o.last_synced_at} />
                  </>
                ) : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
    )}
  </Layout>
);

export const EventPage = ({
  user,
  event,
  genres,
  comments,
  following,
  ownChannels,
  sharedChannels,
  streamDead,
}) => {
  const when = whenLabel(event);
  /*
   * The driver hands jsonb back parsed or as a string depending on the column and
   * the query, so this is the one place that decides -- rather than every field
   * below guessing separately and one of them getting it wrong.
   */
  const detail = (() => {
    const raw = event.detail;
    if (!raw) return {};
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();
  return (
    <Layout title={event.name} user={user}>
      <header class="page-head">
        <div>
          <h1>{event.name}</h1>
          <p class="muted">
            <a href={`/subjects/${event.subject_slug}`}>{event.subject_name}</a>
            {' · '}
            <a href={`/categories/${event.category}`}>{labelFor(event.category)}</a>
          </p>
        </div>
        <FollowButton
          user={user}
          subjectType="subject"
          subjectId={event.subject_id}
          following={following}
          next={`/events/${event.id}`}
          label={event.subject_name}
        />
      </header>

      {/*
        A banner where there is one, the poster beside the facts where there is
        not. Two different shapes doing two different jobs: a 16:9 backdrop can
        run the width of the page, a 2:3 poster cannot without either cropping
        the faces off or being enormous.
      */}
      {event.backdrop_url || event.subject_backdrop ? (
        <div class="event-banner">
          <img
            src={event.backdrop_url ?? event.subject_backdrop}
            alt=""
            loading="lazy"
            decoding="async"
          />
        </div>
      ) : null}

      <div class="event-detail">
        {event.image_url || event.subject_image ? (
          <img
            class="event-poster"
            src={event.image_url ?? event.subject_image}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : null}

        <div class="event-facts">
          {event.tagline ? <p class="tagline">{event.tagline}</p> : null}
          {event.summary ? <p class="blurb">{event.summary}</p> : null}

          <ul class="factlist">
            <li>
              <span>{when.kind === 'time' ? 'Starts' : 'Out'}</span>
              <StartTime event={event} />
            </li>
            {event.venue ? (
              <li>
                <span>{event.category === 'space' ? 'Launch site' : 'Where'}</span>
                {event.venue}
                {event.venue_region ? `, ${event.venue_region}` : ''}
              </li>
            ) : null}
            {event.season ? (
              <li>
                <span>Episode</span>
                Season {event.season}, episode {event.number}
              </li>
            ) : null}
            {event.runtime_min ? (
              <li>
                <span>Runtime</span>
                {event.runtime_min} min
              </li>
            ) : null}
            {/* A score resting on a handful of votes is noise, so it is only
                shown once enough people have voted to mean anything. */}
            {event.rating && (event.rating_count ?? 0) >= 10 ? (
              <li>
                <span>Rating</span>
                {Number(event.rating).toFixed(1)} / 10
              </li>
            ) : null}
            {detail.director ? (
              <li>
                <span>Director</span>
                {detail.director}
              </li>
            ) : null}
            {detail.rocket ? (
              <li>
                <span>Rocket</span>
                {detail.rocket}
              </li>
            ) : null}
            {detail.orbit ? (
              <li>
                <span>Orbit</span>
                {detail.orbit}
              </li>
            ) : null}
            {detail.probability ? (
              <li>
                <span>Odds</span>
                {detail.probability}% go for launch
              </li>
            ) : null}
            {detail.network ? (
              <li>
                <span>Network</span>
                {detail.network}
              </li>
            ) : null}
            {detail.studios?.length ? (
              <li>
                <span>Studio</span>
                {detail.studios.join(', ')}
              </li>
            ) : null}
            {detail.language ? (
              <li>
                <span>Language</span>
                {detail.language}
              </li>
            ) : null}
          </ul>

          {detail.cast?.length ? (
            <p class="cast">
              <span class="stat-label">Cast</span>
              {detail.cast.join(' · ')}
            </p>
          ) : null}

          {/* Where it is included, not where it can be rented -- those are
              different questions and mixing them misleads. */}
          {detail.watch?.length ? (
            <p class="watch">
              <span class="stat-label">Streaming on</span>
              {detail.watch.join(' · ')}
            </p>
          ) : null}

          <p class="more">
            {event.trailer_url ? (
              <a class="cta" href={event.trailer_url} rel="noopener nofollow external">
                Watch the trailer ↗
              </a>
            ) : null}
            {event.url ? (
              <a class="link-quiet" href={event.url} rel="noopener nofollow external">
                Full details ↗
              </a>
            ) : null}
          </p>
        </div>
      </div>

      {/*
        Said out loud rather than implied by a missing clock.
        A reader who sees only a date needs to know that is all anyone knows, not
        wonder whether the site failed to load a time. It is also the honest
        explanation for why the reminder arrives the day before rather than an
        hour ahead.
      */}
      {when.kind !== 'time' ? (
        <p class="notice">
          Only the {when.kind === 'day' ? 'date' : when.kind} is announced so far, so there is no
          countdown for this one. We will remind you the day before and on the day.
        </p>
      ) : null}

      <GenreChips genres={genres} />

      {/*
        A reader's own list, and other people's open ones, matched against this
        title. One component, shared with the subject page -- see OwnLine.

        The page is deliberately not cached in Redis, and that is what makes this
        safe: the section carries one account's own entries.
      */}
      <OwnLine
        own={ownChannels}
        shared={sharedChannels}
        streamDead={streamDead}
        title={event.subject_name}
      />

      <Ad />

      <section id="comments">
        <h2>Comments</h2>
        {comments.length === 0 ? (
          <p class="empty">Nothing said yet.</p>
        ) : (
          <ul class="comments">
            {comments.map((c) => (
              <li>
                {/* A chosen name where there is one. Signing a public comment with
                    the local part of an address was publishing something nobody
                    chose to publish; a display name or handle replaces it the
                    moment one is set. */}
                {/* Linked only when there is a handle AND the profile is public.
                    A private profile 404s to everyone but its owner, so a link
                    there is a link to a dead page -- and the name still shows,
                    because being named on your own comment is not the same as
                    having a profile people can open. */}
                {c.handle && c.profile_public ? (
                  <a class="who comment-author" href={`/u/${c.handle}`}>
                    {commenterName(c)}
                  </a>
                ) : (
                  <span class="who">{commenterName(c)}</span>
                )}
                <LocalTime at={c.created_at} />
                <p>{c.body}</p>
              </li>
            ))}
          </ul>
        )}
        {user ? (
          <form method="post" action={`/api/events/${event.id}/comments`}>
            <label class="field">
              <span>Say something</span>
              <textarea name="body" rows="3" maxlength="2000" required />
            </label>
            <button class="cta" type="submit">
              Post
            </button>
          </form>
        ) : (
          <p class="muted small">
            <a href={`/login?next=/events/${event.id}`}>Sign in</a> to comment.
          </p>
        )}
      </section>
    </Layout>
  );
};

/**
 * One page for every kind of row the site holds.
 *
 * Grouped rather than interleaved. A show, a genre, an episode, a channel on your
 * own line and a person are five different KINDS of answer, and a single ranked
 * list has to pretend they are comparable -- there is no honest way to say whether
 * the Horror genre beats a horror film called what you typed. Sections say what
 * each thing is and let the reader pick the row they meant.
 *
 * Titles go first because they are what the box is mostly used for. Your own
 * channels go second when there are any, because somebody with a subscription
 * asking "do you have this" is asking about their line, not about our catalogue.
 */
export const SearchPage = ({ user, term, category, results, owned }) => (
  <Layout title={term ? `${term} — search` : 'Search'} user={user} q={term}>
    <h1>Search</h1>

    <form method="get" action="/search" class="searchbar">
      <label class="field">
        <span class="visually-hidden">Search</span>
        <input
          type="search"
          name="q"
          value={term ?? ''}
          placeholder="A show, a film, an artist, a rocket"
          autocomplete="off"
          autofocus
        />
      </label>
      <select name="category">
        <option value="">Everything</option>
        {Object.entries(CATEGORY_LABEL).map(([slug, meta]) => (
          <option value={slug} selected={slug === category}>
            {meta.name}
          </option>
        ))}
      </select>
      <button class="cta" type="submit">
        Search
      </button>
    </form>

    {!term ? (
      <p class="muted">
        Everything we know about, whether it is out yet or not — titles, genres, episodes and
        releases, and the people here. If you have added a channel list, your own line is searched
        too, and results say which ones you already have.
      </p>
    ) : results.total === 0 ? (
      <p class="empty">Nothing matched “{term}”.</p>
    ) : (
      <>
        {results.subjects.length > 0 ? (
          <section class="results-group">
            <h2>Titles</h2>
            <ul class="results">
              {results.subjects.map((r) => (
                <li class="result">
                  {r.image_url ? (
                    <img src={r.image_url} alt="" loading="lazy" width="60" height="90" />
                  ) : (
                    <span class="subject-blank" />
                  )}
                  <div class="result-main">
                    <a href={`/subjects/${r.slug}`}>{r.display_name}</a>
                    <span class="meta">
                      {CATEGORY_LABEL[r.category]?.name ?? r.category}
                      {r.starts_at ? ` · ${new Date(r.starts_at).getUTCFullYear()}` : ''}
                      {r.upcoming > 0 ? ' · coming up' : ''}
                    </span>
                    {r.description ? <p class="result-blurb">{r.description}</p> : null}
                  </div>
                  {/* The answer to the question that brought them here. */}
                  {owned?.has?.(r.id) ? (
                    <span class="badge owned" title="Found in your channel list">
                      In your list
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Only for the account that owns them, and only titles -- never a URL.
            The stream URL is a credential and it belongs to the download route. */}
        {results.channels.length > 0 ? (
          <section class="results-group">
            <h2>On your line</h2>
            <p class="muted">From the channel list on your account. Nobody else can see these.</p>
            <ul class="results">
              {results.channels.map((ch) => (
                <li class="result">
                  <span class="subject-blank" />
                  <div class="result-main">
                    <span class="result-name">{ch.title}</span>
                    <span class="meta">
                      {ch.group_title ? ch.group_title : 'Ungrouped'}
                      {ch.is_live === false ? ' · did not answer last time' : ''}
                    </span>
                  </div>
                  <a class="link-quiet" href="/my/channels">
                    Your channels
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {results.genres.length > 0 ? (
          <section class="results-group">
            <h2>Genres</h2>
            <ul class="chips">
              {results.genres.map((g) => (
                <li>
                  <a class="chip" href={`/genres/${g.slug}`}>
                    {g.name}
                    {g.upcoming > 0 ? <span class="chip-count">{g.upcoming}</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {results.events.length > 0 ? (
          <section class="results-group">
            <h2>Episodes &amp; releases</h2>
            <ul class="results">
              {results.events.map((e) => (
                <li class="result">
                  {e.image_url ? (
                    <img src={e.image_url} alt="" loading="lazy" width="60" height="90" />
                  ) : (
                    <span class="subject-blank" />
                  )}
                  <div class="result-main">
                    <a href={`/events/${e.id}`}>{e.name}</a>
                    <span class="meta">
                      <a href={`/subjects/${e.subject_slug}`}>{e.subject_name}</a>
                      {' · '}
                      {whenLabel(e)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {results.people.length > 0 ? (
          <section class="results-group">
            <h2>People</h2>
            <ul class="results">
              {results.people.map((p) => (
                <li class="result">
                  <span class="subject-blank" />
                  <div class="result-main">
                    <a href={`/u/${p.handle}`}>{p.display_name || `@${p.handle}`}</a>
                    {p.display_name ? <span class="meta">@{p.handle}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </>
    )}

    {/* Only once there is something to sit under. An ad above an empty result
        set is the only thing on the page, which is both worse to read and
        billed identically. */}
    {term && results.total > 0 ? <Ad format="text_link" /> : null}
  </Layout>
);

/**
 * "3 names and 12 genres", for the confirm text and for the receipt afterwards.
 *
 * Both halves need the breakdown rather than a total. The question anyone pressing
 * "Unfollow all" has is whether the names they picked one at a time are included --
 * the button on /genres deliberately spares them, so the answer is not obvious --
 * and the question afterwards is whether those names really went. A bare number
 * answers neither. Counts come from a follow list, or from the delete's own tally.
 */
const countPhrase = (follows, counts) => {
  const subjects = counts
    ? counts.subjects
    : follows.filter((f) => f.subject_type === 'subject').length;
  const genres = counts ? counts.genres : follows.filter((f) => f.subject_type === 'genre').length;
  const parts = [];
  if (subjects)
    parts.push(`${subjects.toLocaleString('en-US')} ${subjects === 1 ? 'name' : 'names'}`);
  if (genres) parts.push(`${genres.toLocaleString('en-US')} ${genres === 1 ? 'genre' : 'genres'}`);
  return parts.join(' and ') || 'nothing';
};

export const Following = ({ user, events, follows, cleared, vapidKey, calendarUrl }) => (
  <Layout title="Your calendar" user={user} vapidKey={vapidKey}>
    <h1>Your calendar</h1>

    {/* Rendered always and revealed by script once it knows the real state, so the
        control can report on / off / blocked rather than only offering to turn on. */}
    <section id="push-optin" hidden class="card">
      <div class="card-head">
        <h2 class="card-title">Notifications</h2>
        <p class="card-desc" id="push-state">
          Get told before something you follow is out. An hour ahead for anything with a start time,
          the day before for anything with only a date.
        </p>
      </div>
      <div class="card-actions">
        <button type="button" id="enable-push" class="cta">
          Turn on notifications
        </button>
        <a class="link-quiet" href="/push-check">
          Not working?
        </a>
      </div>
      <p id="push-msg" class="feedback" hidden />
    </section>

    {/* Calendar subscription. The URL carries a per-user token because calendar
        clients poll without cookies; rotating it invalidates every copy. */}
    {calendarUrl ? (
      <section class="card">
        <div class="card-head">
          <h2 class="card-title">Add to your calendar</h2>
          <p class="card-desc">
            Everything you follow, kept up to date automatically. Anything with only a release date
            arrives as an all-day entry rather than a made-up time.
          </p>
        </div>

        {/* The feed as a plain URL, first. The buttons below only reach the clients we
            can link into; everything else -- Outlook, Thunderbird, Fastmail, a phone's
            stock calendar -- subscribes by having a URL pasted into it. */}
        <div class="field">
          <label class="field-label" for="calendar-url">
            Feed URL
          </label>
          <div class="copy-row">
            <input
              id="calendar-url"
              class="input mono"
              type="text"
              readonly
              value={calendarUrl}
              spellcheck="false"
              aria-label="Calendar feed URL"
            />
            <button type="button" class="ghost" data-copy="#calendar-url">
              Copy
            </button>
          </div>
          <ul class="hints">
            <li>
              <span>Google Calendar</span> Other calendars → From URL
            </li>
            <li>
              <span>Apple Calendar</span> File → New Calendar Subscription
            </li>
            <li>
              <span>Outlook</span> Add calendar → Subscribe from web
            </li>
          </ul>
        </div>

        <div class="card-actions">
          <a
            class="ghost"
            href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarUrl.replace(/^https:/, 'webcal:'))}`}
            rel="noopener"
          >
            Open in Google Calendar
          </a>
          <a class="ghost" href={calendarUrl.replace(/^https:/, 'webcal:')}>
            Open in Apple / Outlook
          </a>
          <a class="link-quiet" href={calendarUrl}>
            Download .ics
          </a>
        </div>

        <div class="card-foot">
          <p class="muted small">Anyone with this link can see everything you follow.</p>
          <form method="post" action="/api/calendar/rotate" class="inline">
            <button type="submit" class="ghost small-btn">
              Reset the link
            </button>
          </form>
        </div>
      </section>
    ) : null}

    {cleared ? (
      <p class="feedback ok" role="status">
        {cleared.removed === 0
          ? 'There was nothing left to unfollow.'
          : `Unfollowed ${cleared.removed.toLocaleString('en-US')} — ${countPhrase(null, cleared)}.`}
      </p>
    ) : null}

    {follows.length === 0 ? (
      <p class="empty">
        You're not following anything yet. <a href="/genres">Browse by genre</a> to find something.
      </p>
    ) : (
      <>
        <div class="follows-head">
          <h2>Following ({follows.length})</h2>
          {/* The wipe. Unlike the one on /genres -- which is the undo for "follow
              everything" and spares the individual names on purpose -- this clears
              the list it sits above, names included, because that list is what is
              being looked at. data-confirm makes the browser ask first and names
              what goes; with script off the form still posts, the same trade the
              rest of the site makes, which is why the count is also on the receipt
              afterwards. */}
          <form method="post" action="/api/unfollow-everything" class="inline">
            <button
              type="submit"
              class="ghost small-btn"
              data-confirm={`Unfollow all ${follows.length}? That is ${countPhrase(follows)}. Your reminders and calendar stay empty until you follow something again.`}
            >
              Unfollow all
            </button>
          </form>
        </div>
        <ul class="chips">
          {follows.map((f) => (
            <li class="chip">
              <a href={f.subject_type === 'genre' ? `/genres/${f.slug}` : `/subjects/${f.slug}`}>
                {f.label}
              </a>
              <form method="post" action="/api/unfollow" class="inline">
                <input type="hidden" name="subject_type" value={f.subject_type} />
                <input type="hidden" name="subject_id" value={f.subject_id} />
                <input type="hidden" name="next" value="/following" />
                <button type="submit" aria-label={`Unfollow ${f.label}`}>
                  ×
                </button>
              </form>
            </li>
          ))}
        </ul>
      </>
    )}

    <h2>Coming up</h2>
    <EventList events={events} emptyText="Nothing coming up for what you follow." />
  </Layout>
);

/**
 * A reader's own playlist, indexed by the provider's own group titles.
 *
 * The groups are shown verbatim. Mapping "UK | Documentary" onto our Documentary
 * genre would be a guess that is wrong often enough to be misleading, and the
 * reader already recognises these strings from their own player.
 */
/**
 * What each entry kind is called on a page.
 *
 * `unknown` is a real state, not a gap: rows imported before the kind was stored
 * have none, and they repair themselves on the next refresh. Calling them "live"
 * would assert the thing that was wrong in the first place.
 */
const KIND_WORD = {
  live: 'live channels',
  vod: 'films on demand',
  series: 'episode files',
  unknown: 'not yet classified',
};

export const Channels = ({ user, playlist, groups, kinds = [] }) => (
  <Layout title="Your channels" user={user}>
    <h1>Your channels</h1>

    {!playlist ? (
      <p class="empty">
        You have not added a channel list. <a href="/settings">Add one in settings</a> and its
        genres appear here.
      </p>
    ) : (
      <>
        <p class="muted">
          {playlist.channel_count.toLocaleString('en-US')} channels in{' '}
          {groups.length.toLocaleString('en-US')} groups
          {playlist.last_synced_at ? (
            <>
              {' · updated '}
              <LocalTime at={playlist.last_synced_at} />
            </>
          ) : null}
        </p>
        {playlist.last_error ? <p class="feedback error">{playlist.last_error}</p> : null}

        {/*
          What KIND of thing is on this line.

          The question behind this is "does my provider actually carry films", and
          nothing on the site answered it -- so a reader whose list is seven
          thousand live channels and no VOD had no way to tell that from the
          matching being broken. They are very different problems and only one of
          them is ours.

          `unknown` is shown rather than hidden: it means those rows were imported
          before the kind was stored, and they repair themselves on the next
          refresh. Silently folding them into "live" is the exact mistake that
          produced this section.
        */}
        {kinds.length > 0 ? (
          <ul class="kind-counts">
            {kinds.map((k) => (
              <li class={`kind-count kind-${k.kind}`}>
                <strong>{k.count.toLocaleString('en-US')}</strong> {KIND_WORD[k.kind] ?? k.kind}
              </li>
            ))}
          </ul>
        ) : null}
        {kinds.length > 0 && !kinds.some((k) => k.kind === 'vod' || k.kind === 'series') ? (
          <p class="notice">
            Nothing on this line looks like a film or an episode file — it is all live channels. We
            can still tell you which channel is carrying something, but “Available on demand” will
            stay empty, because there is nothing on demand in it to find.
          </p>
        ) : null}

        <p class="muted small">
          These are your provider's own groupings, shown exactly as they appear in your list.
          Nothing here is shared with anyone else or streamed through GenreWatch.
        </p>
        <ul class="genre-grid">
          {groups.map((g) => (
            <li class="genre">
              <span>{g.name}</span>
              <span class="meta">{g.count.toLocaleString('en-US')} channels</span>
            </li>
          ))}
        </ul>
      </>
    )}
  </Layout>
);

/**
 * Somebody's profile.
 *
 * What is on it is exactly what a follow list already implies: the genres and names
 * they follow, and the schedule that falls out of following them. Nothing here is
 * derived from anything they did not choose to put on the account -- no email, no
 * activity, no counts of what they clicked.
 *
 * The owner sees the same page everyone else does, plus a line saying whether anyone
 * else can. That is deliberate: a privacy switch you cannot see the effect of is a
 * privacy switch nobody trusts.
 */
export const ProfilePage = ({ user, profile, follows, followTotal, upcoming, isOwner }) => {
  const name = profile.display_name || `@${profile.handle}`;
  const genres = follows.filter((f) => f.subject_type === 'genre');
  const subjects = follows.filter((f) => f.subject_type === 'subject');
  // The list is capped now, so its length is no longer the answer to "how many".
  // Defaulted rather than required, so a caller that has not been updated shows a
  // heading that matches its own list instead of "undefined".
  const total = followTotal ?? follows.length;
  const hidden = Math.max(total - follows.length, 0);

  return (
    <Layout
      title={name}
      user={user}
      canonical={profile.profile_public ? `/u/${profile.handle}` : undefined}
    >
      <div class="page-head">
        <h1>{name}</h1>
        {profile.display_name ? <p class="muted">@{profile.handle}</p> : null}
      </div>

      {isOwner ? (
        <p class="feedback info" role="status">
          {profile.profile_public
            ? 'This is your profile as everyone else sees it.'
            : 'Only you can see this. Turn on a public profile in Settings to share it.'}{' '}
          <a href="/settings">Settings</a>
        </p>
      ) : null}

      {profile.bio ? <p class="bio">{profile.bio}</p> : null}

      <h2>Coming up</h2>
      <EventList
        events={upcoming}
        emptyText={
          isOwner
            ? 'Nothing coming up for what you follow yet.'
            : `Nothing coming up for what ${name} follows.`
        }
      />

      <h2>Following ({total.toLocaleString('en-US')})</h2>
      {follows.length === 0 ? (
        <p class="empty">
          {isOwner ? (
            <>
              You're not following anything yet. <a href="/genres">Browse by genre</a>.
            </>
          ) : (
            'Nothing yet.'
          )}
        </p>
      ) : (
        <>
          {genres.length > 0 ? (
            <>
              <h3>Genres</h3>
              <ul class="chips">
                {genres.map((f) => (
                  <li class="chip">
                    <a href={`/genres/${f.slug}`}>{f.label}</a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {subjects.length > 0 ? (
            <>
              <h3>Names</h3>
              <ul class="chips">
                {subjects.map((f) => (
                  <li class="chip">
                    <a href={`/subjects/${f.slug}`}>{f.label}</a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {/* Say what the cap left out, with the real total, so the last chip is
              never mistaken for the end of the list. */}
          {hidden > 0 ? (
            <p class="muted small">
              Showing {follows.length.toLocaleString('en-US')} of {total.toLocaleString('en-US')}.
            </p>
          ) : null}
        </>
      )}
    </Layout>
  );
};

/**
 * What an invited person is called back to the inviter.
 *
 * A chosen name or handle, and otherwise nothing. Deliberately NOT the fallback
 * commenterName uses: signing up is not publishing, and somebody who accepted an
 * invite never agreed to have a fragment of their address reported to whoever sent
 * it. "Someone new" is the honest answer and costs nothing.
 */
const inviteeName = (row) => row.display_name || (row.handle ? `@${row.handle}` : 'Someone new');

export const Invite = ({
  user,
  url,
  accepted,
  remaining,
  dailyLimit,
  maxPerSubmission,
  notice,
  error,
}) => (
  <Layout title="Invite friends" user={user}>
    <h1>Invite friends</h1>
    <p class="muted">
      Anyone who follows something will get told before it drops. It is free, there are no ads, and
      there is nothing to unlock — so this is a recommendation rather than a referral scheme.
    </p>

    {notice ? (
      <p class="feedback ok" role="status">
        {notice}
      </p>
    ) : null}
    {error ? (
      <p class="feedback error" role="status">
        {error}
      </p>
    ) : null}

    {/* The link first, because it is the half with no limits and no risk: they
        send it themselves, through whatever they already use. */}
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Your link</h2>
        <p class="card-desc">
          Send this however you like. It does not expire and there is no limit on how many people
          use it.
        </p>
      </div>
      <div class="field">
        <div class="copy-row">
          <input
            id="invite-url"
            class="input mono"
            type="text"
            readonly
            value={url}
            spellcheck="false"
            aria-label="Your invite link"
          />
          <button type="button" class="ghost" data-copy="#invite-url">
            Copy
          </button>
        </div>
      </div>
    </section>

    {/* And the half that needs limits, with the limit stated rather than
        discovered by hitting it. */}
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Or we can email it</h2>
        <p class="card-desc">
          Up to {maxPerSubmission} addresses at a time, {dailyLimit} a day. They get one email, from
          us, saying you suggested it — your address is not in it, and we do not create an account
          for them or email them again.
        </p>
      </div>
      <form method="post" action="/api/invite/email" class="invite-form">
        <label>
          Email addresses
          <textarea
            name="emails"
            rows="3"
            required
            placeholder="one@example.com, two@example.com"
          />
        </label>
        <button class="cta" type="submit" disabled={remaining <= 0}>
          {remaining > 0 ? 'Send' : 'Back tomorrow'}
        </button>
      </form>
      <p class="muted small">
        {remaining > 0
          ? `${remaining} left today.`
          : 'That is today’s limit. Your link above still works.'}
      </p>
    </section>

    <h2>Who has joined</h2>
    {accepted.length === 0 ? (
      <p class="empty">Nobody yet. Nothing happens until somebody signs up through your link.</p>
    ) : (
      <ul class="invitees">
        {accepted.map((a) => (
          <li>
            <span>{inviteeName(a)}</span>
            <span class="muted small">joined {new Date(a.claimed_at).toLocaleDateString()}</span>
          </li>
        ))}
      </ul>
    )}
  </Layout>
);

export const SignIn = ({ mode, sent, next, passwordError, magicError }) => (
  <Layout title={mode === 'signup' ? 'Create your account' : 'Sign in'}>
    <section class="auth">
      <h1>{mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
      {sent ? (
        <p class="ok">
          If that address can receive mail, a sign-in link is on its way. It works once and expires
          in 20 minutes.
        </p>
      ) : (
        <>
          <p class="muted">
            {mode === 'signup'
              ? 'Enter your email and we will send you a link. No password to choose.'
              : 'We will email you a link. No password to remember.'}
          </p>
          {magicError ? (
            <p class="feedback error" role="status">
              {magicError}
            </p>
          ) : null}
          <form method="post" action="/api/auth/magic">
            <input type="hidden" name="next" value={next ?? '/following'} />
            <label>
              Email
              <input
                type="email"
                name="email"
                required
                autocomplete="email"
                placeholder="you@example.com"
              />
            </label>
            <button class="cta" type="submit">
              Email me a link
            </button>
          </form>

          <div class="or">or</div>
          <button type="button" id="passkey-signin" class="ghost">
            Use a passkey
          </button>
          <p id="passkey-signin-msg" class="feedback" hidden />

          {/* The third way in, and the one that exists for televisions.
              A plain form with no script: on the device this is for, a remote
              control is the keyboard and the browser may do very little else. It
              is last because it is the weakest of the three and should not be the
              obvious choice on a phone -- but it is on the page rather than behind
              a toggle, because a toggle is one more thing to hit with a D-pad. */}
          <details class="password-signin" open={Boolean(passwordError)}>
            <summary>Use a password</summary>
            {passwordError ? (
              <p class="feedback error" role="status">
                {passwordError}
              </p>
            ) : null}
            <form method="post" action="/api/auth/password">
              <input type="hidden" name="next" value={next ?? '/following'} />
              <label>
                Email
                <input
                  type="email"
                  name="email"
                  required
                  autocomplete="username"
                  placeholder="you@example.com"
                />
              </label>
              <label>
                Password
                <input type="password" name="password" required autocomplete="current-password" />
              </label>
              <button class="ghost" type="submit">
                Sign in
              </button>
            </form>
            <p class="muted small">
              Only if you have set one, in Settings, from a device you were already signed in on.
              There is no password reset — use the emailed link, which always works.
            </p>
          </details>

          <p class="muted small">
            {mode === 'signup' ? (
              <>
                Already have an account? <a href="/login">Sign in</a> — same link either way.
              </>
            ) : (
              <>
                No account yet? <a href="/signup">Create one</a> — the link makes it for you.
              </>
            )}
          </p>
        </>
      )}
    </section>
  </Layout>
);

const COMMON_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Lagos',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

export const Settings = ({
  user,
  prefs,
  passkeys,
  playlist,
  playlistMasked = null,
  playlistUnreadable = false,
  playlistNotice,
  playlistError,
  profileNotice,
  profileError,
  passwordNotice,
  passwordError,
  passwordMinLength,
  member = false,
  shareCandidates = [],
}) => (
  <Layout title="Settings" user={user}>
    <h1>Settings</h1>

    {/* A reader's own channel list. Private to this account: never shown to anyone
        else, never pooled, and never offered for sale. */}
    <section>
      <h2>Your channel list</h2>
      <p class="muted small">
        If you subscribe to a service that gives you an M3U playlist, add it here and we will tell
        you which of your own entries is carrying something you follow. It stays private to your
        account unless you choose otherwise below. VLC, Infuse and .m3u hand the entry straight to
        the player you already use and never touch our servers; “Play here” passes through us, to
        your session only. Browse it at <a href="/my/channels">your channels</a>.
      </p>

      {playlistError ? <p class="feedback error">{playlistError}</p> : null}
      {playlistNotice ? <p class="feedback ok">{playlistNotice}</p> : null}

      {playlist ? (
        <div class="card">
          <div class="card-head">
            <h3 class="card-title">{playlist.label ?? 'Your list'}</h3>
            <p class="card-desc">
              {playlist.channel_count.toLocaleString('en-US')} channels
              {playlist.last_synced_at ? (
                <>
                  {' · updated '}
                  <LocalTime at={playlist.last_synced_at} />
                </>
              ) : null}
            </p>
          </div>
          {playlist.last_error ? <p class="feedback error">{playlist.last_error}</p> : null}

          {/*
            The address, which used to be shown nowhere at all.

            Masked in the served HTML: this page is rendered per request but a
            credential in a page is a credential in a scrollback, a screenshot and
            a back-forward cache. The whole thing is one press away, from a route
            that answers `no-store` -- and it is the reader's own password, so
            showing it back to the session that supplied it discloses nothing.
          */}
          {playlistUnreadable ? (
            <p class="feedback error">
              This address can no longer be decrypted, so it cannot be refreshed or shown. Paste it
              again below to fix it.
            </p>
          ) : playlistMasked ? (
            <div class="field">
              <label class="field-label" for="playlist-url">
                Address
              </label>
              <div class="copy-row">
                <input
                  id="playlist-url"
                  class="input mono"
                  type="text"
                  readonly
                  value={playlistMasked}
                  data-playlist-url
                  spellcheck="false"
                  aria-label="Your playlist address"
                  autocomplete="off"
                />
                <button type="button" class="ghost" hidden data-playlist-reveal>
                  Show
                </button>
                <button type="button" class="ghost" data-copy="#playlist-url">
                  Copy
                </button>
              </div>
              <p class="muted small">
                Masked because it carries your provider username and password. Show reveals it, and
                Copy takes whatever is displayed.
              </p>
            </div>
          ) : null}

          <div class="card-actions">
            <form method="post" action="/api/playlist/refresh" class="inline">
              <button class="ghost small-btn" type="submit">
                Refresh
              </button>
            </form>
            <form method="post" action="/api/playlist/delete" class="inline">
              <button class="ghost small-btn danger" type="submit">
                Remove
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {/*
        Opening the list to everybody signed in.

        Rendered only when there IS a list, and worded so the two consequences are
        read before the button is pressed rather than discovered afterwards. Both
        are real and neither is obvious:

          - a provider line permits a small number of simultaneous connections and
            suspends the account for exceeding it, so other people watching it are
            using the owner's allowance;
          - the site therefore refuses a shared entry while that line is busy,
            rather than cutting off whoever is already watching.

        What it does NOT do is hand anybody the URL, and that is why this is
        offerable at all. Shared entries play through the proxy only; VLC, Infuse
        and .m3u stay owner-only, because each of those is the credential itself.
      */}
      {playlist ? (
        <div class="card" id="sharing">
          <div class="card-head">
            <h3 class="card-title">Who can see your list</h3>
            <p class="card-desc">
              Whoever you choose can play from it on a page for something it carries. They never get
              the address — it carries your provider username and password, so shared entries play
              through us and the VLC, Infuse and .m3u buttons stay yours alone. Your line still
              permits one connection at a time, so somebody else watching means you are not. See{' '}
              <a href="/shared">whose lists are open</a>.
            </p>
          </div>
          <form method="post" action="/api/playlist/share">
            <label class="field">
              <span>Audience</span>
              {/*
                One control with three values rather than a toggle plus a second
                toggle. The old form posted `shared=1`, which the route still
                accepts and still reads as 'everyone' -- an unreloaded page sitting
                in somebody's browser must not quietly change what it means.
              */}
              <select name="audience">
                <option value="none" selected={playlist.share_audience === 'none'}>
                  Nobody — keep it private
                </option>
                <option value="friends" selected={playlist.share_audience === 'friends'}>
                  Only the people I name{member ? '' : ' (premium)'}
                </option>
                <option value="everyone" selected={playlist.share_audience === 'everyone'}>
                  Everyone signed in
                </option>
              </select>
              {member ? null : (
                <span class="hint">
                  Naming individual people is part of <a href="/premium">premium</a>. Private and
                  everyone are free, as they have always been.
                </span>
              )}
            </label>

            <label class="field">
              <span>What to call it (optional)</span>
              <input
                type="text"
                name="label"
                maxlength="80"
                value={playlist.shared_label ?? ''}
                placeholder="Anthony's line"
                autocomplete="off"
              />
              {/* The private label defaults to the provider's hostname, which is
                  the one thing not to publish -- it names their provider to
                  everybody on the site. */}
              <span class="hint">
                Shown instead of the name above, which is usually your provider's address.
              </span>
            </label>

            <button class="cta" type="submit">
              Save
            </button>
          </form>

          {/*
            The people picker, shown only when that is the audience.

            Candidates are mutual follows, but a follow is NOT the rule -- a name
            has to be added here before it can see anything. Somebody who followed
            back out of politeness has not agreed to be handed a credential.
          */}
          {playlist.share_audience === 'friends' ? (
            <div class="share-grants">
              <h4>Named people</h4>
              {shareCandidates.length === 0 ? (
                <p class="empty">
                  Nobody to name yet. This lists people you follow who follow you back.
                </p>
              ) : (
                <ul class="grant-list">
                  {shareCandidates.map((p) => (
                    <li>
                      <span>{p.display_name ?? (p.handle ? `@${p.handle}` : 'Someone')}</span>
                      <form method="post" action="/api/playlist/share/grant" class="inline">
                        <input type="hidden" name="user_id" value={p.id} />
                        <input type="hidden" name="allowed" value={p.granted ? '0' : '1'} />
                        <button class={p.granted ? 'ghost small-btn' : 'small-btn'} type="submit">
                          {p.granted ? 'Remove' : 'Add'}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        /*
         * Shown when there is NO list, which is the only reason this branch
         * exists. Sharing used to render only for an account that already had
         * one, so the feature was invisible to everybody who had not got that
         * far -- and the paragraph above this promises the list "stays private
         * unless you choose otherwise below", pointing at nothing at all. It was
         * reported twice as sharing being missing from settings.
         *
         * No form, because there is nothing to submit yet. Saying what the
         * feature is and what it needs first is the whole job.
         */
        <div class="card">
          <div class="card-head">
            <h3 class="card-title">Share your list</h3>
            <p class="card-desc">
              Once you have added a list you can open it to everyone signed in, and this is where
              that switch appears. They never get the address — it carries your provider username
              and password, so shared entries play through us and the VLC, Infuse and .m3u buttons
              stay yours alone. Your line still permits one connection at a time, so somebody else
              watching means you are not. See <a href="/shared">whose lists are open</a>.
            </p>
          </div>
        </div>
      )}

      {/*
        Editing, rather than removing and starting again.

        The address field is optional once a list exists, and blank means "leave it
        alone" -- that is the whole point. Renaming a list used to require pasting
        a URL with a password in it, which meant keeping a copy of that URL
        somewhere outside here, which is the opposite of what sealing it was for.

        The name is prefilled; the address is not, because a browser that offers to
        remember a field it has seen is how a provider password ends up in a
        password manager under the wrong entry. Fill it with the Show button
        instead, which asks for it deliberately.
      */}
      <form method="post" action="/api/playlist" data-playlist-form>
        <h3 class="card-title">{playlist ? 'Edit your list' : 'Add a list'}</h3>
        <label class="field">
          <span>Playlist URL</span>
          <input
            type="url"
            name="url"
            required={!playlist}
            placeholder={
              playlist
                ? 'Leave blank to keep the current address'
                : 'http://your-provider.example/playlist/…'
            }
            autocomplete="off"
            data-playlist-input
          />
        </label>
        <label class="field">
          <span>Name (optional)</span>
          <input
            type="text"
            name="label"
            value={playlist?.label ?? ''}
            placeholder="My subscription"
            autocomplete="off"
          />
        </label>
        <button class="cta" type="submit">
          {playlist ? 'Save changes' : 'Add list'}
        </button>
      </form>
      <p class="muted small">
        The address is stored encrypted because it usually contains your username and password. Only
        you ever see it, and removing the list deletes it. Saving the same address again keeps your
        channels and their check results — nothing is re-imported unless your provider's file has
        actually changed.
      </p>
    </section>

    {/* The name a comment is signed with. Before this there was none, so a public
        comment carried the local part of the author's email address -- something
        they never chose to publish. */}
    <section>
      <h2>Your name</h2>
      <p class="muted small">
        What your comments are signed with. Without one they fall back to part of your email
        address, which is not something you chose to publish.
      </p>
      {profileError ? <p class="feedback error">{profileError}</p> : null}
      {profileNotice ? <p class="feedback ok">{profileNotice}</p> : null}
      <form method="post" action="/api/profile">
        <label class="field">
          <span>Display name</span>
          <input
            type="text"
            name="display_name"
            maxlength="60"
            value={user.display_name ?? ''}
            placeholder="How you want to be known"
            autocomplete="nickname"
          />
        </label>
        <label class="field">
          <span>Handle (optional)</span>
          <input
            type="text"
            name="handle"
            maxlength="30"
            value={user.handle ?? ''}
            placeholder="letters, numbers, underscores"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <label class="check">
          <input type="checkbox" name="profile_public" checked={user.profile_public !== false} />
          Let others see a profile page for me
        </label>
        <button class="cta" type="submit">
          Save name
        </button>
      </form>
      {/* The switch above is abstract until you can see what it produces, so the
          page it controls is one click away. Only once a handle exists, because
          without one there is no page. */}
      {user.handle ? (
        <p class="muted small">
          Your profile is at <a href={`/u/${user.handle}`}>/u/{user.handle}</a> — it shows what you
          follow and what is coming up{' '}
          {user.profile_public === false ? 'and only you can see it.' : 'to anyone who opens it.'}
        </p>
      ) : null}
    </section>

    <section>
      <h2>Reminders</h2>
      <form method="post" action="/api/prefs">
        {/*
          Two lists, because there are two kinds of event and one set of offsets
          cannot serve both. A show has an air time and "60 minutes before" means
          something. An album has a release DATE and nothing finer, so the same
          setting would fire at 11am on a noon anchor nobody chose. Splitting them
          is the whole reason the schema carries time_known.
        */}
        <fieldset>
          <legend>Things with a start time</legend>
          <p class="muted small">Episodes, anime airings, launches.</p>
          {[60, 30, 15, 5, 1].map((m) => (
            <label class="check">
              <input
                type="checkbox"
                name="offsets"
                value={m}
                checked={prefs.offsets_minutes.includes(m)}
              />
              {m >= 60 ? `${m / 60} hour before` : `${m} minute${m === 1 ? '' : 's'} before`}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Things with only a date</legend>
          <p class="muted small">Films and albums, where no time is announced.</p>
          {[
            [10080, 'A week before'],
            [2880, 'Two days before'],
            [1440, 'The day before'],
            [0, 'On the day'],
          ].map(([m, text]) => (
            <label class="check">
              <input
                type="checkbox"
                name="date_offsets"
                value={m}
                checked={(prefs.date_offsets_minutes ?? []).includes(m)}
              />
              {text}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>How</legend>
          {['webpush', 'email'].map((c) => (
            <label class="check">
              <input
                type="checkbox"
                name="channels"
                value={c}
                checked={prefs.channels.includes(c)}
              />
              {c === 'webpush' ? 'Web notification' : 'Email'}
            </label>
          ))}
        </fieldset>
        <button class="cta" type="submit">
          Save
        </button>
      </form>
    </section>

    <section>
      <h2>Time zone</h2>
      {/* This zone drives the whole site, not just email. It used to apply to email
          only, so someone who set PST here still saw their device's zone on every
          page and reasonably concluded the app was ignoring them. */}
      <p class="muted small">
        Every time on the site, and in emailed reminders, is shown in this zone. Leave it as
        detected and it follows your device (<span data-tz-label>your device</span>).
      </p>
      <form method="post" action="/api/timezone" class="form-row">
        <label class="field">
          {/* Not "Zone for emails" any more: this drives every time on the site,
              which is the whole point of the note above it. */}
          <span>Time zone</span>
          <select name="timezone">
            {[...new Set([user.timezone ?? 'UTC', ...COMMON_ZONES])].map((z) => (
              <option value={z} selected={z === (user.timezone ?? 'UTC')}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <button class="cta" type="submit">
          Save time zone
        </button>
      </form>
    </section>

    <section>
      <h2>Passkeys</h2>
      {passkeys.length === 0 ? (
        <p class="muted">No passkeys yet. Add one to sign in without waiting for email.</p>
      ) : (
        <ul class="passkeys">
          {passkeys.map((p) => (
            <li>
              <strong>{(p.transports ?? []).join(', ') || 'Passkey'}</strong>
              <span class="muted">
                added {new Date(p.created_at).toLocaleDateString()}
                {p.last_used_at
                  ? ` · last used ${new Date(p.last_used_at).toLocaleDateString()}`
                  : ' · never used'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" id="add-passkey" class="ghost">
        Add a passkey
      </button>
      <p id="add-passkey-msg" class="feedback" hidden />
    </section>

    {/* A password, for the television.
        Set from here and only from here: whoever can set one already has this
        session, so this can never be how an account is first taken over. It is
        described as what it is rather than sold as an upgrade -- it is the weakest
        of the three ways in, and worth having only where the other two cannot
        work. */}
    <section>
      <h2>Password</h2>
      <p class="muted small">
        For devices that cannot open an emailed link or hold a passkey — a television, mostly. The
        link and your passkeys keep working either way, so there is no password reset here: if you
        forget it, sign in with a link and set a new one.
      </p>

      {passwordNotice ? (
        <p class="feedback ok" role="status">
          {passwordNotice}
        </p>
      ) : null}
      {passwordError ? (
        <p class="feedback error" role="status">
          {passwordError}
        </p>
      ) : null}

      <p class="muted">
        {user.password_set_at
          ? `Set ${new Date(user.password_set_at).toLocaleDateString()}.`
          : 'No password set.'}
      </p>

      <form method="post" action="/api/auth/password/set">
        <label>
          {user.password_set_at ? 'New password' : 'Password'}
          <input
            type="password"
            name="password"
            required
            minlength={passwordMinLength}
            autocomplete="new-password"
          />
        </label>
        <label>
          Again
          <input type="password" name="confirm" required autocomplete="new-password" />
        </label>
        <button class="ghost" type="submit">
          {user.password_set_at ? 'Change it' : 'Set a password'}
        </button>
      </form>

      {user.password_set_at ? (
        <form method="post" action="/api/auth/password/set" class="inline">
          <input type="hidden" name="remove" value="on" />
          <button
            class="ghost small-btn"
            type="submit"
            data-confirm="Remove your password? You will still be able to sign in with an emailed link or a passkey."
          >
            Remove it
          </button>
        </form>
      ) : null}
    </section>

    <section>
      <h2>Account</h2>
      <p class="muted">{user.email}</p>
      <form method="post" action="/api/auth/logout">
        <button type="submit" class="ghost">
          Sign out
        </button>
      </form>
    </section>
  </Layout>
);

export const About = ({ user, stats }) => (
  <Layout title="About" user={user}>
    <h1>About GenreWatch</h1>

    <p class="lede">
      A release calendar for everything that is not sport. Follow a genre or a name, and hear about
      it before it is out rather than after.
    </p>

    <section class="stats">
      <div class="stat">
        <span class="stat-label">Genres</span>
        <span class="stat-value">{stats.genres.toLocaleString('en-US')}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Names you can follow</span>
        <span class="stat-value">{stats.subjects.toLocaleString('en-US')}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Coming up</span>
        <span class="stat-value">{stats.upcoming.toLocaleString('en-US')}</span>
      </div>
    </section>

    <h2>Where this comes from</h2>
    <p>
      Five sources, four of which need no key at all: TVmaze for television, AniList for anime, TMDB
      for film, MusicBrainz for music, and The Space Devs for launches. Each is credited on the
      event it supplied, and every event links back to the page it came from so you can check it.
    </p>

    <h2>Dates we do not know</h2>
    <p>
      A lot of what is coming has a date and no time — a film opens on a Friday, an album is out on
      a Tuesday, and nobody publishes an hour. We store that as a date and say so, rather than
      inventing midnight and pretending to count down to it. Those get reminders the day before and
      on the day; anything with a real start time gets the minute-level reminders you choose.
    </p>

    <h2>Sport</h2>
    <p>
      Deliberately not here. <a href="https://tipoffwatch.com">tipoffwatch.com</a> is the same idea
      built properly for fixtures, with live scores and per-country broadcast listings, and a thin
      copy of it here would be worse than a link.
    </p>

    <h2>Free, and readable by machines</h2>
    <p>
      No ads and no account needed to read anything. There is an RSS feed for every genre, a
      calendar feed for anything you follow, and a <a href="/api/v1">JSON API</a> with no key.
    </p>
  </Layout>
);

export const NotFound = ({ user }) => (
  <Layout title="Not found" user={user}>
    <h1>Not found</h1>
    <p>
      <a href="/">Back to what is coming up</a>
    </p>
  </Layout>
);

/**
 * Notification self-check.
 *
 * A support page, not a feature. When the toggle fails there is nothing on the
 * page that says why -- the browser's push service can refuse or simply never
 * answer, and telling those apart otherwise means DevTools. This runs the same
 * calls the toggle makes, one at a time, and prints what each one did.
 */
export const PushCheck = ({ user, vapidKey }) => (
  <Layout
    title="Notification check"
    user={user}
    vapidKey={vapidKey}
    canonical="/push-check"
    script={assetUrl('push-check.js')}
  >
    <h1>Notification check</h1>
    <p class="muted">
      If turning notifications on did nothing, run this. It tries each step the button takes and
      says which one failed, in plain words.
    </p>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">What this does</h2>
        <p class="card-desc">
          Registers the service worker, asks for permission if it has not been given, and tries to
          subscribe — the same three things the button on your games page does.
        </p>
      </div>
      <div class="card-actions">
        <button type="button" id="run-check" class="cta">
          Run the check
        </button>
      </div>
      <p id="check-verdict" class="feedback" hidden />
      <ol id="check-steps" class="check-steps" hidden />
    </section>

    <p class="muted small">
      Nothing here is stored against your account. The result is logged so it can be looked at if
      you report the problem.
    </p>
  </Layout>
);
