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
export const GenresIndex = ({ user, categories, genres, genreCounts, upcoming }) => {
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

export const SubjectPage = ({ user, subject, events, genres, following }) => (
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

    <section>
      <h2>Coming up</h2>
      <EventList events={events} emptyText="Nothing scheduled." />
    </section>

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

export const EventPage = ({ user, event, genres, comments, following, ownChannels }) => {
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
        A reader's own channels, matched against their own list.

        Nothing here is shared, pooled or relayed: these URLs came from this
        account and go back only to this account. The page is deliberately not
        cached in Redis for exactly this reason.

        The empty state is not decoration. Rendering nothing when a list is present
        but nothing matched is indistinguishable from the feature being broken --
        which is how it read before the count was carried back.
      */}
      {ownChannels?.hasList ? (
        <section>
          <h2>In your list</h2>

          {/* On demand first: it is there whenever they want it, where a channel
              is a claim about right now. */}
          {ownChannels.onDemand?.length > 0 ? (
            <>
              <h3>Available on demand</h3>
              <ul class="channels">
                {ownChannels.onDemand.map((ch, i) => (
                  <li>
                    <span>{ch.title}</span>
                    <a
                      class="ghost small-btn"
                      href={`/events/${event.id}/playlist.m3u?tier=vod&n=${i}`}
                    >
                      Open
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {ownChannels.matches.length > 0 ? (
            <>
              <p class="muted small">
                From the playlist you added. Opening one hands a file to your own player — nothing
                is streamed through GenreWatch.
              </p>
              <ul class="channels">
                {ownChannels.matches.map((ch, i) => (
                  <li>
                    <span>{ch.title}</span>
                    <a class="ghost small-btn" href={`/events/${event.id}/playlist.m3u?n=${i}`}>
                      Open
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : ownChannels.onDemand?.length > 0 ? null : (
            <p class="empty">
              None of your {ownChannels.channelCount.toLocaleString('en-US')} entries look like they
              carry this. Provider names vary a lot, so it may still be in there under a name we did
              not recognise.
            </p>
          )}

          {/* A different claim, worded as one: a 24/7 genre channel carries
              whatever is on, which is not the same as having this. */}
          {ownChannels.genre?.length > 0 ? (
            <>
              <h3>Channels for this genre</h3>
              <p class="muted small">
                These carry the genre rather than this specific thing, so they may or may not be
                showing it.
              </p>
              <ul class="channels">
                {ownChannels.genre.map((ch, i) => (
                  <li>
                    <span>{ch.title}</span>
                    <a
                      class="ghost small-btn"
                      href={`/events/${event.id}/playlist.m3u?tier=genre&n=${i}`}
                    >
                      Open
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

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
                <span class="who">{commenterName(c)}</span>
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
 * Search results, past and future together.
 *
 * The one page here that is not a calendar. A film from 1999 and one out next
 * month are equally good answers to "do you have this", so nothing is filtered by
 * date and the year is shown instead -- which is what tells them apart.
 */
export const SearchPage = ({ user, term, category, results, owned }) => (
  <Layout title={term ? `${term} — search` : 'Search'} user={user}>
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
        Everything we know about, whether it is out yet or not. If you have added a channel list,
        results say which ones you already have.
      </p>
    ) : results.length === 0 ? (
      <p class="empty">Nothing matched “{term}”.</p>
    ) : (
      <ul class="results">
        {results.map((r) => (
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
    )}

    {/* Only once there is something to sit under. An ad above an empty result
        set is the only thing on the page, which is both worse to read and
        billed identically. */}
    {term && results.length > 0 ? <Ad format="text_link" /> : null}
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
export const Channels = ({ user, playlist, groups }) => (
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

export const SignIn = ({ mode, sent, next }) => (
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
  playlistNotice,
  playlistError,
  profileNotice,
  profileError,
}) => (
  <Layout title="Settings" user={user}>
    <h1>Settings</h1>

    {/* A reader's own channel list. Private to this account: never shown to anyone
        else, never pooled, and never offered for sale. */}
    <section>
      <h2>Your channel list</h2>
      <p class="muted small">
        If you subscribe to a service that gives you an M3U playlist, add it here and we will tell
        you which of your own channels is carrying something you follow. It stays private to your
        account, and nothing is streamed through GenreWatch — opening a channel hands a playlist
        file to the player you already use. Browse it at <a href="/my/channels">your channels</a>.
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

      <form method="post" action="/api/playlist">
        <label class="field">
          <span>Playlist URL</span>
          <input
            type="url"
            name="url"
            required
            placeholder="http://your-provider.example/playlist/…"
            autocomplete="off"
          />
        </label>
        <label class="field">
          <span>Name (optional)</span>
          <input type="text" name="label" placeholder="My subscription" autocomplete="off" />
        </label>
        <button class="cta" type="submit">
          {playlist ? 'Replace list' : 'Add list'}
        </button>
      </form>
      <p class="muted small">
        The address is stored encrypted because it usually contains your username and password. Only
        you ever see it, and removing the list deletes it.
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
