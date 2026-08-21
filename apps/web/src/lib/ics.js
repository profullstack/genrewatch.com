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
 * A title with an accent is multi-byte, so counting characters can emit a
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

const title = (event) => event.name;

/** YYYYMMDD in UTC, for an all-day entry. */
const dateStamp = (d) => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');

/**
 * @param {object[]} events
 * @param {{ name: string, siteUrl: string, defaultMinutes?: number }} opts
 */
export function buildCalendar(events, { name, siteUrl, defaultMinutes = 150 }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GenreWatch//Releases//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    // Hints the client to re-fetch hourly. Advisory, but without it some clients
    // poll once a day and a rescheduled release stays wrong until tomorrow.
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];

  const now = stamp(new Date());

  for (const e of events) {
    const start = new Date(e.starts_at);
    const desc = [
      e.subject_name,
      e.venue ? `On ${[e.venue, e.venue_region].filter(Boolean).join(', ')}` : null,
      `${siteUrl}/events/${e.id}`,
    ]
      .filter(Boolean)
      .join('\n');

    /*
     * A date-only event is an ALL-DAY entry, not a timed one.
     *
     * iCalendar has a representation for exactly this -- DTSTART;VALUE=DATE with
     * no time component -- and using it is the difference between a calendar
     * showing "Dune: Part Three" across the top of Friday and showing it as a
     * 2.5-hour block starting at noon UTC, which is 4am in California and a lie
     * everywhere. DTEND for an all-day entry is EXCLUSIVE, so it is the next day.
     *
     * The alarm has to move with it: -PT60M on an all-day entry fires at 11pm the
     * night before in most clients, which is precisely the reminder the schema's
     * time_known flag exists to avoid sending.
     */
    const allDay = !e.time_known;
    const timing = allDay
      ? [
          `DTSTART;VALUE=DATE:${dateStamp(start)}`,
          `DTEND;VALUE=DATE:${dateStamp(new Date(start.getTime() + 86_400_000))}`,
        ]
      : [
          `DTSTART:${stamp(start)}`,
          `DTEND:${stamp(new Date(start.getTime() + defaultMinutes * 60_000))}`,
        ];

    const alarm = allDay
      ? [
          'BEGIN:VALARM',
          // 09:00 on the day itself, expressed as nine hours after midnight.
          'TRIGGER;RELATED=START:PT9H',
          'ACTION:DISPLAY',
          `DESCRIPTION:${esc(`${title(e)} is out today`)}`,
          'END:VALARM',
        ]
      : [
          'BEGIN:VALARM',
          'TRIGGER:-PT60M',
          'ACTION:DISPLAY',
          `DESCRIPTION:${esc(`${title(e)} starts in an hour`)}`,
          'END:VALARM',
        ];

    lines.push(
      'BEGIN:VEVENT',
      // Stable across refreshes, so a client updates the entry instead of adding
      // a second copy every time it polls.
      `UID:event-${e.id}@genrewatch.com`,
      `DTSTAMP:${now}`,
      ...timing,
      `SUMMARY:${esc(title(e))}`,
      `DESCRIPTION:${esc(desc)}`,
      // The channel or pad plus where it is: an entry saying only "ITV" is useless
      // to someone in another country.
      e.venue ? `LOCATION:${esc([e.venue, e.venue_region].filter(Boolean).join(', '))}` : null,
      `URL:${siteUrl}/events/${e.id}`,
      // Duration is a guess for most of these, so mark it as such rather than
      // blocking out someone's calendar as if it were a confirmed meeting.
      'TRANSP:TRANSPARENT',
      'STATUS:CONFIRMED',
      ...alarm,
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(fold).join(CRLF) + CRLF;
}
