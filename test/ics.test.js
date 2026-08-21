import { describe, expect, test } from 'bun:test';
import { buildCalendar } from '../apps/web/src/lib/ics.js';

const base = {
  id: 1,
  name: 'Severance 2x03',
  subject_name: 'Severance',
  venue: 'Apple TV+',
  venue_region: 'Streaming',
};

const build = (e) => buildCalendar([e], { name: 'test', siteUrl: 'https://genrewatch.com' });

describe('a timed event', () => {
  const ics = build({ ...base, starts_at: '2026-09-04T18:30:00Z', time_known: true });

  test('is a normal timed VEVENT', () => {
    expect(ics).toContain('DTSTART:20260904T183000Z');
    expect(ics).not.toContain('VALUE=DATE');
  });

  test('is alarmed an hour ahead', () => {
    expect(ics).toContain('TRIGGER:-PT60M');
  });
});

describe('a date-only event', () => {
  /*
   * The whole point of time_known, expressed in the one format where getting it
   * wrong is most visible.
   *
   * A release stored at noon UTC rendered as a timed VEVENT shows up in a calendar
   * as a block starting at 5am in California, and its -PT60M alarm fires at 11pm
   * the night before. iCalendar has a representation for "this happens on this
   * day" and this is it.
   */
  const ics = build({ ...base, starts_at: '2026-09-04T12:00:00Z', time_known: false });

  test('is an all-day VEVENT with no clock time', () => {
    expect(ics).toContain('DTSTART;VALUE=DATE:20260904');
    expect(ics).not.toContain('DTSTART:20260904T120000Z');
  });

  test('ends on the following day, because DTEND is exclusive', () => {
    expect(ics).toContain('DTEND;VALUE=DATE:20260905');
  });

  test('is alarmed on the morning of, not the night before', () => {
    expect(ics).toContain('TRIGGER;RELATED=START:PT9H');
    expect(ics).not.toContain('TRIGGER:-PT60M');
  });
});

describe('calendar hygiene', () => {
  test('a UID is stable so a refresh updates rather than duplicates', () => {
    const a = build({ ...base, starts_at: '2026-09-04T18:30:00Z', time_known: true });
    const b = build({ ...base, starts_at: '2026-09-05T18:30:00Z', time_known: true });
    expect(a).toContain('UID:event-1@genrewatch.com');
    expect(b).toContain('UID:event-1@genrewatch.com');
  });

  test('every line ends CRLF, as the format requires', () => {
    const ics = build({ ...base, starts_at: '2026-09-04T18:30:00Z', time_known: true });
    expect(ics.includes('\r\n')).toBe(true);
  });
});
