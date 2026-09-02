import { config } from '@genre/config';

/** Shared bits of markup. Kept small and dumb on purpose. */

/**
 * Times are rendered in UTC on the server and localised in the browser.
 *
 * Genre pages are cached in Redis and served byte-identical to everyone, so a
 * time baked in one viewer's zone would be wrong for the next. The server emits a
 * machine-readable UTC `datetime` plus a readable UTC fallback, and public/app.js
 * rewrites the text to the viewer's own zone. With JavaScript off the page still
 * shows a correct time, explicitly labelled UTC rather than silently wrong.
 */
const fmtTimeUtc = (d) =>
  new Date(d).toLocaleTimeString('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });

export const fmtDayUtc = (d) =>
  new Date(d).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

const fmtMonthUtc = (d) =>
  new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

const fmtYearUtc = (d) =>
  new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric' });

/**
 * How precisely do we actually know when this happens?
 *
 * The single most important distinction on this site, and the one the sports
 * original never had to make. A fixture always has a kickoff. A release very
 * often has only "September 2026", and the adapters store that as noon UTC on a
 * representative day so it can be ordered and indexed like anything else.
 *
 * Printing that stored instant as a time would be inventing one. So every
 * renderer asks here first, and a row without a known time never shows a clock --
 * not a greyed-out one, not an approximate one, none.
 */
export function whenLabel(event) {
  if (event.time_known) return { kind: 'time' };
  if (event.precision === 'year') return { kind: 'year', text: fmtYearUtc(event.starts_at) };
  if (event.precision === 'month') return { kind: 'month', text: fmtMonthUtc(event.starts_at) };
  return { kind: 'day', text: fmtDayUtc(event.starts_at) };
}

/**
 * @param zone  also print which timezone the time is in. Worth it where someone
 *              is deciding whether they can watch (a single event); noise on a
 *              list, where every row would repeat the same word.
 *
 * The server renders UTC because it has no browser; localiseTimes() in app.js
 * rewrites the spans to the visitor's zone on load. A date-only event is emitted
 * WITHOUT the data-local-time hook, so the client script leaves it alone rather
 * than "localising" a time that does not exist -- which would shift a release
 * onto the wrong day for anyone west of UTC.
 */
export const LocalTime = ({ at, zone = false, event = null }) => {
  const iso = new Date(at).toISOString();
  const when = event ? whenLabel(event) : { kind: 'time' };

  if (when.kind !== 'time') {
    return (
      <time datetime={iso} class="undated">
        <span class="t">{when.text}</span>
        <span class="d">{when.kind === 'day' ? 'date only' : 'expected'}</span>
      </time>
    );
  }

  return (
    <time datetime={iso} data-local>
      <span class="t" data-local-time>
        {fmtTimeUtc(at)}
      </span>
      <span class="d" data-local-day>
        {fmtDayUtc(at)}
      </span>
      {zone ? (
        <span class="z" data-tz-abbr>
          UTC
        </span>
      ) : null}
    </time>
  );
};

/**
 * One line: "3:00 PM · Wed, Aug 19 · PDT", or "September 2026" when that is all
 * anyone knows.
 *
 * The separators are real text in the markup, not borders or gaps, because the
 * stacked version depends entirely on CSS to be legible -- there is no whitespace
 * between its spans, so anywhere the stylesheet does not reach (a new context, or
 * a browser still holding an old cached copy) it renders as
 * "3:00 PMWed, Aug 19PDT". This one reads correctly with no stylesheet at all.
 */
export const StartTime = ({ event }) => {
  const iso = new Date(event.starts_at).toISOString();
  const when = whenLabel(event);

  if (when.kind !== 'time') {
    return (
      <time class="line undated" datetime={iso}>
        <span>{when.text}</span>
        {when.kind === 'day' ? null : <span class="hint"> · exact date not announced</span>}
      </time>
    );
  }

  return (
    <time class="line" datetime={iso} data-local>
      <span data-local-time>{fmtTimeUtc(event.starts_at)}</span>
      {' · '}
      <span data-local-day>{fmtDayUtc(event.starts_at)}</span>
      {' · '}
      <span data-tz-abbr>UTC</span>
    </time>
  );
};

/** What kind of thing this is, when the word is worth saying. */
const KIND_LABEL = {
  premiere: 'Premiere',
  'season-premiere': 'Season premiere',
  finale: 'Finale',
  special: 'Special',
  launch: 'Launch',
  release: 'Release',
  film: 'Film',
};

export const KindBadge = ({ kind }) => {
  const label = KIND_LABEL[kind];
  // "Episode" is the default state of the biggest category on the site, so
  // badging it would put a grey pill on four thousand rows that says nothing.
  if (!label) return null;
  return <span class={`badge kind-${kind}`}>{label}</span>;
};

/** Follow / unfollow as a plain form, so it works with JavaScript off. */
export const FollowButton = ({ user, subjectType, subjectId, following, next, label }) => {
  // Whoever the button is about, in every state. A bare "Follow" leaves the reader
  // guessing what it follows when more than one sits on a page -- and "Following"
  // with no name is worse, because it is the state you most need to read back.
  //
  // Callers rendering a long list of one-name rows pass no label, because the row
  // already says the name right beside the button.
  const who = label ? ` ${label}` : '';

  if (!user) {
    return (
      <a
        class="ghost small-btn"
        title="Sign in to follow"
        href={`/login?next=${encodeURIComponent(next ?? '/')}`}
      >
        ☆ Follow{who}
      </a>
    );
  }
  return (
    <form method="post" action={following ? '/api/unfollow' : '/api/follow'} class="inline">
      <input type="hidden" name="subject_type" value={subjectType} />
      <input type="hidden" name="subject_id" value={subjectId} />
      <input type="hidden" name="next" value={next ?? '/'} />
      {/* data-label lets the client rebuild the unfollowed wording without having to
          re-render the row from the server. */}
      <button
        type="submit"
        data-label={label ?? ''}
        class={following ? 'ghost small-btn following' : 'ghost small-btn'}
      >
        {following ? `★ Following${who}` : `☆ Follow${who}`}
      </button>
    </form>
  );
};

/**
 * Which genre a row is, as a tag rather than as more grey text.
 *
 * A list on this site mixes five categories and a few hundred genres, so "is this
 * a horror film or a documentary" is the first question a row has to answer -- and
 * it was not answered anywhere on the row at all. The subject's name was there,
 * the venue was there, the genre was not.
 *
 * The genre where the row carries one, and the category otherwise: an event with
 * no genre edges yet (a freshly ingested title, a launch) still belongs to
 * something, and a blank where every neighbouring row has a tag reads as missing
 * data rather than as an absence of genre.
 */
export const GenreTag = ({ event }) => {
  const label = event.genre_name ?? CATEGORY_NAME[event.category] ?? event.category;
  if (!label) return null;
  const tag = <span class="genre-tag">{label}</span>;
  // Linked only where the slug came back with the row. A chip that navigates on
  // some rows and not others is worse than one that never does.
  return event.genre_slug ? (
    <a class="genre-tag-link" href={`/genres/${event.genre_slug}`}>
      {tag}
    </a>
  ) : (
    tag
  );
};

/**
 * Category names, for the fallback above.
 *
 * Deliberately not imported from pages.jsx's CATEGORY_LABEL: that module imports
 * this one, and reaching back would be a cycle. Five words is cheaper than
 * restructuring both files, and a test pins the two lists together.
 */
const CATEGORY_NAME = {
  tv: 'Television',
  film: 'Film',
  anime: 'Anime',
  music: 'Music',
  space: 'Spaceflight',
};

export const EventRow = ({ event }) => (
  <li class={`event ${event.category}${event.following ? ' followed' : ''}`}>
    <LocalTime at={event.starts_at} event={event} />

    <div class="matchup">
      <a href={`/events/${event.id}`}>
        {/* The star marks something the viewer already follows, so a genre page
            reads the same way as their own list. It is decorative for a signed-out
            visitor, who never has one. */}
        {event.following ? (
          <span class="followed-star" role="img" title="You follow this" aria-label="Following">
            ★
          </span>
        ) : null}
        {event.name}
      </a>
      <span class="meta">
        <GenreTag event={event} />
        <a class="subject-link" href={`/subjects/${event.subject_slug}`}>
          {event.subject_name}
        </a>
        {event.venue ? ` · ${event.venue}` : ''}
        {/* A channel or a pad name alone only means something to people who already
            know the market, which is nobody browsing five categories at once. */}
        {event.venue_region ? `, ${event.venue_region}` : ''}
        <KindBadge kind={event.kind} />
      </span>
    </div>
  </li>
);

export const EventList = ({ events, emptyText }) =>
  events.length === 0 ? (
    <p class="empty">{emptyText ?? 'Nothing scheduled.'}</p>
  ) : (
    <ul class="events">
      {events.map((e) => (
        <EventRow event={e} />
      ))}
    </ul>
  );

/** One followable name in a picker: a show, a film, an artist, an agency. */
export const SubjectRow = ({ subject, user, next }) => (
  <li class="subject">
    {subject.image_url ? (
      <img src={subject.image_url} alt="" loading="lazy" width="28" height="28" />
    ) : (
      <span class="subject-blank" />
    )}
    <div class="subject-name">
      <a href={`/subjects/${subject.slug}`}>{subject.display_name}</a>
      <span class="meta">
        {subject.kind}
        {subject.upcoming > 0 ? ` · ${subject.upcoming} upcoming` : ' · nothing scheduled'}
      </span>
    </div>
    <FollowButton
      user={user}
      subjectType="subject"
      subjectId={subject.id}
      following={subject.following}
      next={next}
    />
  </li>
);

/** A genre chip, used wherever an event or a name has to show what it is filed as. */
export const GenreChips = ({ genres }) =>
  !genres || genres.length === 0 ? null : (
    <p class="chips">
      {genres.map((g) => (
        <a class="chip" href={`/genres/${g.slug}`}>
          {g.name}
        </a>
      ))}
    </p>
  );

/**
 * One network ad unit.
 *
 * Two rules, both learned from reading ad.js rather than from taste.
 *
 * FIRST: an impression is billed the moment the unit is FILLED, at the single
 * DOMContentLoaded scan -- ad.js calls /api/ads/serve there and then. It has no
 * IntersectionObserver, so nothing waits for the unit to be seen. A unit hidden
 * with CSS, or pushed off-screen, or clipped because it is wider than the
 * viewport, is billed exactly like one somebody read. That makes "render all
 * four sizes and show the right one" not a layout choice but a metering lie, and
 * it is why this component exists instead of a bare div at each call site.
 *
 * SECOND: only two of the four formats survive every width. text_link is
 * rendered at 100% width by ad.js, and the 300x250 rectangle fits inside the
 * narrowest phone. The 728x90 leaderboard and the 320x50 mobile banner both
 * need a viewport test to place honestly, and ad.js offers no way to make one --
 * no matchMedia, no resize handler, no auto format -- so they are not used.
 *
 * The consequence worth stating: at most ONE unit renders per page.
 */
export const Ad = ({ format = 'banner_300x250', label = 'Advertisement' }) => {
  if (!config.ads.enabled) return null;
  return (
    <aside class={`ad ad-${format}`} aria-label={label}>
      {/* Named for a screen reader and marked as an aside, so it is skippable
          and is not read as part of the page's own content. */}
      <span class="ad-label">{label}</span>
      <div data-cp-ad="" data-slot={config.ads.slot} data-format={format} />
    </aside>
  );
};
