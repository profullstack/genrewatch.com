/**
 * iCalendar output.
 *
 * Written by hand rather than pulled from a library because the format is small
 * and the failure mode is silent: a calendar client that dislikes a line simply
 * shows nothing, with no error anyone sees. The rules that actually bite:
 *
 *   - CRLF line endings, everywhere. LF-only feeds are rejected outright by some
 *     clients and silently truncated by others.
 *   - Lines fold at 75 octets, continued with a leading space.
 *   - A stable UID per event, or every refresh creates duplicates instead of
 *     updating what is already in the calendar.
 *   - Commas, semicolons, backslashes and newlines are escaped in text values.
 */

const CRLF = '\r\n';

/** Escape a TEXT value per RFC 5545 §3.3.11. Order matters: backslash first. */
function esc(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** UTC stamp: 20260819T171000Z. */
function stamp(date) {
  return `${new Date(date).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * Fold to 75 octets, not 75 characters.
 *
 * A team name with an accent is multi-byte, so counting characters can emit a
 * line that is over the limit — and split one mid-codepoint, which renders as
 * mojibake in the client.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const chunks = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off to a codepoint boundary (continuation bytes are 10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines lose one octet to the leading space
  }
  return chunks.join(`${CRLF} `);
}

function title(event) {
  return event.away_name && event.home_name
    ? `${event.away_name} at ${event.home_name}`
    : event.name;
}

/**
 * @param {object[]} events
 * @param {{ name: string, siteUrl: string, defaultMinutes?: number }} opts
 */
export function buildCalendar(events, { name, siteUrl, defaultMinutes = 150 }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GenreWatch//Fixtures//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    // Hints the client to re-fetch hourly. Advisory, but without it some clients
    // poll once a day and a rescheduled fixture stays wrong until tomorrow.
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];

  const now = stamp(new Date());

  for (const e of events) {
    const start = new Date(e.starts_at);
    const end = new Date(start.getTime() + defaultMinutes * 60_000);
    const desc = [
      e.league_name,
      e.broadcast
        ? `On ${e.broadcast}${e.broadcast_country ? ` (${e.broadcast_country})` : ''}`
        : null,
      `${siteUrl}/events/${e.id}`,
    ]
      .filter(Boolean)
      .join('\n');

    lines.push(
      'BEGIN:VEVENT',
      // Stable across refreshes, so a client updates the entry instead of adding
      // a second copy every time it polls.
      `UID:event-${e.id}@genrewatch.com`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${esc(title(e))}`,
      `DESCRIPTION:${esc(desc)}`,
      // The arena plus where it is: a calendar entry that says only "PNC Park" is
      // useless to the phone trying to work out how long it takes to get there.
      e.venue
        ? `LOCATION:${esc([e.venue, e.venue_city, e.venue_region].filter(Boolean).join(', '))}`
        : null,
      `URL:${siteUrl}/events/${e.id}`,
      // Duration is a guess for most sports, so mark it as such rather than
      // blocking out someone's calendar as if it were a confirmed meeting.
      'TRANSP:TRANSPARENT',
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      'TRIGGER:-PT60M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(`${title(e)} starts in an hour`)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(fold).join(CRLF) + CRLF;
}
