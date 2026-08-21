/** Shared bits of markup. Kept small and dumb on purpose. */

/**
 * Times are rendered in UTC on the server and localised in the browser.
 *
 * Schedule pages are cached in Redis and served byte-identical to everyone, so a
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

const fmtDayUtc = (d) =>
  new Date(d).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

/**
 * @param zone  also print which timezone the time is in. Worth it where someone
 *              is deciding whether they can watch (a single fixture); noise on a
 *              list, where every row would repeat the same word.
 *
 * The server renders UTC because it has no browser; localiseTimes() in app.js
 * rewrites all three spans to the visitor's zone on load.
 */
export const LocalTime = ({ at, zone = false }) => {
  const iso = new Date(at).toISOString();
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
 * One line: "3:00 PM · Wed, Aug 19 · PDT".
 *
 * The separators are real text in the markup, not borders or gaps, because the
 * stacked version depends entirely on CSS to be legible -- there is no
 * whitespace between its spans, so anywhere the stylesheet does not reach (a new
 * context, or a browser still holding an old cached copy) it renders as
 * "3:00 PMWed, Aug 19PDT". This one reads correctly with no stylesheet at all.
 */
export const KickoffTime = ({ at }) => {
  const iso = new Date(at).toISOString();
  return (
    <time class="line" datetime={iso} data-local>
      <span data-local-time>{fmtTimeUtc(at)}</span>
      {' · '}
      <span data-local-day>{fmtDayUtc(at)}</span>
      {' · '}
      <span data-tz-abbr>UTC</span>
    </time>
  );
};

/**
 * The time column for a fixture row.
 *
 * Once a game is under way its kickoff time is the least interesting thing about
 * it, so the column shows how far in it is instead -- with the scheduled time kept
 * underneath for anyone checking they are watching the right one.
 */
export const RowTime = ({ event }) => {
  if (event.state !== 'in') return <LocalTime at={event.starts_at} />;
  return (
    <time datetime={new Date(event.starts_at).toISOString()} data-local>
      <span class="t live-clock">{event.status_detail ?? 'Live'}</span>
      <span class="d" data-local-time>
        {fmtTimeUtc(event.starts_at)}
      </span>
    </time>
  );
};

/**
 * Where a live game actually is: "Bot 6th", "Top 9th", "68'", "Q3 04:12".
 *
 * The provider already phrases this per sport, so it is passed through rather than
 * reassembled from period and clock -- an inning, a quarter and a football minute
 * are not the same shape and any generic formatting gets one of them wrong. The
 * badge used to say a flat "Live", which is the one thing the viewer already knows.
 */
export const StateBadge = ({ state, detail }) => {
  if (state === 'in') return <span class="badge live">{detail ?? 'Live'}</span>;
  if (state === 'post') return <span class="badge done">{detail ?? 'Final'}</span>;
  return null;
};

/** Follow / unfollow as a plain form, so it works with JavaScript off. */
export const FollowButton = ({ user, subjectType, subjectId, following, next, label }) => {
  // Whoever the button is about, in every state. Two of these sit side by side on
  // an event page, one per team, so a bare "Follow" leaves the reader guessing
  // which side each one is -- and "Following" with no name is worse, because it is
  // the state you most need to be able to read back.
  //
  // Callers that render a long list of one-team rows -- the team picker -- pass no
  // label at all, because the row already says the name right beside the button.
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

export const EventRow = ({ event }) => (
  <li class={`event ${event.state}${event.following ? ' followed' : ''}`}>
    <RowTime event={event} />

    <div class="matchup">
      <a href={`/events/${event.id}`}>
        {/* The star marks a fixture the viewer already follows, so a schedule page
            reads the same way as the My games list. It is decorative for a signed-out
            visitor, who never has one. */}
        {event.following ? (
          <span
            class="followed-star"
            role="img"
            title="You follow one of these teams"
            aria-label="Following"
          >
            ★
          </span>
        ) : null}
        {event.away_name && event.home_name ? (
          <>
            {/* Which side is at home cannot be read from the order: North America
                writes the visitor first, most of the world writes the host first,
                and a row mixing both conventions in one list settles nothing. The
                tags say it outright -- except at a neutral ground, where there is
                nothing to say. */}
            {event.neutral_site ? null : (
              <abbr class="ha away" title="Away team">
                A
              </abbr>
            )}
            {event.away_name}
            <span class="join">{event.neutral_site ? 'vs' : 'at'}</span>
            {event.neutral_site ? null : (
              <abbr class="ha home" title="Home team">
                H
              </abbr>
            )}
            {event.home_name}
          </>
        ) : (
          event.name
        )}
      </a>
      <span class="meta">
        {event.league_name}
        {event.venue ? ` · ${event.venue}` : ''}
        {/* The arena name alone only means something to people who already know the
            city, which is nobody browsing 354 leagues. */}
        {event.venue_city ? `, ${event.venue_city}` : ''}
        <StateBadge state={event.state} detail={event.status_detail} />
      </span>
    </div>

    {/* Shown while a game is in progress too, not only once it is finished --
        a live row with no score was the whole point of watching it. */}
    {(event.state === 'in' || event.state === 'post') && event.home_score !== null ? (
      <span class={`score${event.state === 'in' ? ' live' : ''}`}>
        {event.away_score}–{event.home_score}
      </span>
    ) : null}
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

/** A team in the follow picker. */
export const TeamRow = ({ team, user, next }) => (
  <li class="team">
    {team.logo_url ? (
      <img src={team.logo_url} alt="" loading="lazy" width="28" height="28" />
    ) : (
      <span class="team-blank" />
    )}
    <div class="team-name">
      <a href={`/teams/${team.slug}`}>{team.display_name}</a>
      <span class="meta">
        {team.upcoming > 0 ? `${team.upcoming} upcoming` : 'no fixtures scheduled'}
      </span>
    </div>
    <FollowButton
      user={user}
      subjectType="team"
      subjectId={team.id}
      following={team.following}
      next={next}
    />
  </li>
);
