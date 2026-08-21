import { Layout } from './Layout.jsx';

/**
 * The feed directory.
 *
 * Every feed is public and needs no key, so this page exists to be crawled and
 * linked as much as to be read — it is how the feeds get discovered at all.
 */
export const Feeds = ({ user, sports, leagues }) => (
  <Layout
    title="Feeds"
    user={user}
    canonical="/feeds"
    description="RSS feeds and calendar subscriptions for every sport and league."
  >
    <h1>Feeds</h1>
    <p class="muted">
      Every fixture we track, as RSS. No key, no account, no rate card — point a reader at any of
      these.
    </p>

    <h2>Everything</h2>
    <ul class="leagues">
      <li>
        <a href="/feeds/all.xml">All sports</a>
        <span class="muted small">every league, next 150 fixtures</span>
      </li>
    </ul>

    <h2>By sport</h2>
    <ul class="sports">
      {sports.map((s) => (
        <li>
          <a href={`/feeds/sport/${s.sport}.xml`}>
            <strong>{s.sport.replace(/-/g, ' ')}</strong>
            <span class="muted">{s.leagues} leagues</span>
          </a>
        </li>
      ))}
    </ul>

    <h2>By league</h2>
    <p class="muted small">
      Busiest first. Every league has a feed at <code>/feeds/league/&lt;slug&gt;.xml</code>
      and a calendar at <code>/calendar/league/&lt;slug&gt;.ics</code>, whether or not it is listed
      here.
    </p>
    <ul class="leagues">
      {leagues.map((l) => (
        <li>
          <a href={`/feeds/league/${l.slug}.xml`}>{l.name}</a>
          <span class="muted small">
            {l.upcoming} upcoming · <a href={`/calendar/league/${l.slug}.ics`}>calendar</a>
          </span>
        </li>
      ))}
    </ul>

    <h2>Teams</h2>
    <p class="muted">
      Any team page has a feed at <code>/feeds/team/&lt;slug&gt;.xml</code> — the slug is the one in
      its URL.
    </p>
  </Layout>
);
