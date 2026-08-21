import { Layout } from './Layout.jsx';
import { CATEGORY_LABEL } from './pages.jsx';

/**
 * The feed directory.
 *
 * Feeds are the cheapest distribution this site has, so they get a page a person
 * can read rather than only a sitemap entry a crawler can.
 */
export const Feeds = ({ user, categories, genres }) => (
  <Layout
    title="Feeds"
    user={user}
    description="RSS feeds and calendar subscriptions for every genre we track."
  >
    <h1>Feeds</h1>
    <p class="lede">
      Everything we track, as RSS. No key, no account, no rate card — point a reader at any of
      these. Every genre also has a calendar feed you can subscribe to in a calendar app.
    </p>

    <ul class="genre-feeds">
      <li>
        <a href="/feeds/all.xml">Everything</a>
        <span class="muted small">every category, next 150 events</span>
      </li>
    </ul>

    <h2>By category</h2>
    <ul class="genre-feeds">
      {categories.map((c) => (
        <li>
          <a href={`/feeds/category/${c.category}.xml`}>
            {CATEGORY_LABEL[c.category]?.name ?? c.category}
          </a>
          <span class="muted">{c.genres} genres</span>
        </li>
      ))}
    </ul>

    <h2>By genre</h2>
    <p class="muted small">
      Busiest first. Every genre has a feed at <code>/feeds/genre/&lt;slug&gt;.xml</code> and a
      calendar at <code>/calendar/genre/&lt;slug&gt;.ics</code>, whether or not it is listed here.
    </p>
    <ul class="genre-feeds">
      {genres.map((g) => (
        <li>
          <a href={`/feeds/genre/${g.slug}.xml`}>{g.slug.replace(/-/g, ' ')}</a>
          <span class="muted">
            {g.n} upcoming · <a href={`/calendar/genre/${g.slug}.ics`}>calendar</a>
          </span>
        </li>
      ))}
    </ul>

    <h2>By name</h2>
    <p class="muted small">
      Any page for a show, film, artist or agency has a feed at{' '}
      <code>/feeds/subject/&lt;slug&gt;.xml</code> — the slug is the one in its URL.
    </p>

    <h2>For machines</h2>
    <p class="muted small">
      There is also a <a href="/api/v1">JSON API</a> with no key. Every event it returns carries{' '}
      <code>time_known</code>: when it is false the date is real and the clock time is not, so do
      not render one.
    </p>
  </Layout>
);
