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

const title = (event) => event.name;

function description(event, siteUrl) {
  const parts = [
    event.subject_name,
    event.venue ? `on ${[event.venue, event.venue_region].filter(Boolean).join(', ')}` : null,
  ].filter(Boolean);

  /*
   * Never say "starts" about a date we padded.
   *
   * A feed item is read in a reader that has no idea what time_known means, so
   * this is the last place the distinction can be made. Printing a UTC timestamp
   * for a film that only has a release date states an hour nobody announced, and
   * it is the kind of wrong that gets quoted back as fact.
   */
  const when = event.time_known
    ? `Starts ${new Date(event.starts_at).toUTCString()}`
    : `Out ${new Date(event.starts_at).toLocaleDateString('en-US', {
        timeZone: 'UTC',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })}`;

  return `${parts.join(' · ')}. ${when}. ${siteUrl}/events/${event.id}`;
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
        // Permanent and stable: a reader must not re-show an event because a
        // detail on it changed.
        `      <guid isPermaLink="false">genrewatch-event-${e.id}</guid>`,
        `      <pubDate>${rfc822(e.starts_at)}</pubDate>`,
        `      <category>${esc(e.category)}</category>`,
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
