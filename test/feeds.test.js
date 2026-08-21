import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { buildCalendar } = await import('../apps/web/src/lib/ics.js');
const { buildFeed } = await import('../apps/web/src/lib/rss.js');

const EVENT = {
  id: 42,
  starts_at: '2026-08-19T17:10:00.000Z',
  name: 'San Diego Padres at New York Mets',
  short_name: 'SD @ NYM',
  venue: 'Citi Field',
  state: 'pre',
  home_score: null,
  away_score: null,
  status_detail: null,
  broadcast: 'MLB.TV, SNY',
  league_name: 'Major League Baseball',
  league_slug: 'baseball-mlb',
  sport: 'baseball',
  home_name: 'New York Mets',
  away_name: 'San Diego Padres',
};

const OPTS = { name: 'Test', siteUrl: 'https://genrewatch.com' };

describe('iCalendar', () => {
  const ics = buildCalendar([EVENT], OPTS);

  test('uses CRLF throughout, which some clients reject outright without', () => {
    expect(ics.includes('\r\n')).toBe(true);
    // No bare LF anywhere.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  test('carries a stable UID so a refresh updates rather than duplicates', () => {
    expect(ics).toContain('UID:event-42@genrewatch.com');
    expect(buildCalendar([EVENT], OPTS)).toContain('UID:event-42@genrewatch.com');
  });

  test('stamps times in UTC', () => {
    expect(ics).toContain('DTSTART:20260819T171000Z');
    expect(ics).toMatch(/DTEND:\d{8}T\d{6}Z/);
  });

  test('escapes the characters that silently break a calendar', () => {
    const out = buildCalendar([{ ...EVENT, venue: 'A;B,C\\D' }], OPTS);
    // Input A;B,C\D must emit A\;B\,C\\D -- note the JS literal needs its own
    // doubling, which is exactly the trap that left ';' unescaped in the source.
    expect(out).toContain('LOCATION:A\\;B\\,C\\\\D');
  });

  test('folds long lines without splitting a multi-byte character', () => {
    const long = `Atlético ${'Ñ'.repeat(90)}`;
    const out = buildCalendar([{ ...EVENT, home_name: long, away_name: 'X' }], OPTS);
    for (const line of out.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
    // Survives a round trip: no mojibake from a mid-codepoint split.
    expect(out.replace(/\r\n /g, '')).toContain('Atlético');
  });

  test('includes an hour-before alarm', () => {
    expect(ics).toContain('TRIGGER:-PT60M');
  });
});

describe('RSS', () => {
  const xml = buildFeed([EVENT], {
    title: 'T',
    description: 'D',
    feedUrl: 'https://genrewatch.com/feeds/all.xml',
    siteUrl: 'https://genrewatch.com',
  });

  test('is well-formed enough to parse, with a self link', () => {
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<atom:link href="https://genrewatch.com/feeds/all.xml"');
    expect(xml).toContain('<guid isPermaLink="false">genrewatch-event-42</guid>');
  });

  test('an item reads standalone: teams, league, venue, broadcaster', () => {
    expect(xml).toContain('San Diego Padres at New York Mets');
    expect(xml).toContain('Major League Baseball');
    expect(xml).toContain('Citi Field');
    expect(xml).toContain('MLB.TV');
  });

  test('a live game says so in the title, a finished one shows the score', () => {
    const live = buildFeed([{ ...EVENT, state: 'in', status_detail: 'Bot 4th' }], {
      title: 'T',
      description: 'D',
      feedUrl: 'u',
      siteUrl: 's',
    });
    expect(live).toContain('live, Bot 4th');

    const done = buildFeed([{ ...EVENT, state: 'post', home_score: 4, away_score: 2 }], {
      title: 'T',
      description: 'D',
      feedUrl: 'u',
      siteUrl: 's',
    });
    expect(done).toContain('final, 2–4');
  });

  test('escapes ampersands once, not twice', () => {
    const out = buildFeed([{ ...EVENT, venue: 'Smith & Sons' }], {
      title: 'A & B',
      description: 'D',
      feedUrl: 'u',
      siteUrl: 's',
    });
    expect(out).toContain('<title>A &amp; B</title>');
    expect(out).not.toContain('&amp;amp;');
  });
});

describe('live period display', () => {
  test('the badge shows where the game is, not a flat "Live"', async () => {
    const src = await Bun.file(
      new URL('../apps/web/src/views/components.jsx', import.meta.url).pathname,
    ).text();

    // "Live" is the one thing a viewer looking at a live row already knows. The
    // provider phrases the period per sport -- Bot 6th, Top 9th, 68', Q3 -- so it
    // is passed through rather than rebuilt, which would get at least one wrong.
    expect(src).toContain("{detail ?? 'Live'}");
    expect(src).not.toContain('>● Live<');

    // And the row's time column shows the clock once play starts.
    expect(src).toContain('export const RowTime');
    expect(src).toContain("event.status_detail ?? 'Live'");
    expect(src).toContain('<RowTime event={event} />');
  });
});
