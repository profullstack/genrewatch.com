/**
 * RSS 2.0 output.
 *
 * Feeds are the distribution surface for this site, so they carry real content
 * rather than a bare title: a reader that never visits should still learn who is
 * playing, when, where and on what channel.
 */

/** Escape for XML text and attributes. Ampersand first or the rest double-escape. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const rfc822 = (d) => new Date(d).toUTCString();

function title(event) {
  const match =
    event.away_name && event.home_name ? `${event.away_name} at ${event.home_name}` : event.name;
  if (event.state === 'in') return `${match} — live, ${event.status_detail ?? 'in progress'}`;
  if (event.state === 'post' && event.home_score !== null) {
    return `${match} — final, ${event.away_score}–${event.home_score}`;
  }
  return match;
}

function description(event, siteUrl) {
  const parts = [
    event.league_name,
    event.venue ? `at ${[event.venue, event.venue_city].filter(Boolean).join(', ')}` : null,
    // Named market for the same reason the event page names it: a listing is only
    // true somewhere, and a feed item is read far from wherever we rendered it.
    event.broadcast
      ? `on ${event.broadcast}${event.broadcast_country ? ` (${event.broadcast_country})` : ''}`
      : null,
  ].filter(Boolean);
  const when = new Date(event.starts_at).toUTCString();
  return `${parts.join(' · ')}. Starts ${when}. ${siteUrl}/events/${event.id}`;
}

/**
 * @param {object[]} events
 * @param {{ title: string, description: string, feedUrl: string, siteUrl: string, link?: string }} opts
 */
export function buildFeed(
  events,
  { title: feedTitle, description: feedDesc, feedUrl, siteUrl, link },
) {
  const items = events
    .map((e) =>
      [
        '    <item>',
        `      <title>${esc(title(e))}</title>`,
        `      <link>${esc(`${siteUrl}/events/${e.id}`)}</link>`,
        // Permanent and stable: a reader must not re-show a fixture because its
        // score changed.
        `      <guid isPermaLink="false">genrewatch-event-${e.id}</guid>`,
        `      <pubDate>${rfc822(e.starts_at)}</pubDate>`,
        `      <category>${esc(e.league_name)}</category>`,
        `      <description>${esc(description(e, siteUrl))}</description>`,
        '    </item>',
      ].join('\n'),
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(feedTitle)}</title>
    <link>${esc(link ?? siteUrl)}</link>
    <description>${esc(feedDesc)}</description>
    <language>en</language>
    <generator>GenreWatch</generator>
    <lastBuildDate>${rfc822(new Date())}</lastBuildDate>
    <ttl>60</ttl>
    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}
