import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { EventRow } = await import('../apps/web/src/views/components.jsx');
const { buildCalendar } = await import('../apps/web/src/lib/ics.js');
const { buildFeed } = await import('../apps/web/src/lib/rss.js');
const espn = await import('../packages/sports/src/espn.js');

const render = async (node) => (await node.toString()).toString();

const EVENT = {
  id: 42,
  starts_at: '2026-08-19T17:10:00.000Z',
  name: 'San Diego Padres at New York Mets',
  short_name: 'SD @ NYM',
  state: 'pre',
  venue: 'Citi Field',
  venue_city: 'New York',
  venue_region: 'New York',
  neutral_site: false,
  home_name: 'New York Mets',
  away_name: 'San Diego Padres',
  home_score: null,
  away_score: null,
  status_detail: null,
  broadcast: 'SNY',
  league_name: 'Major League Baseball',
  league_slug: 'baseball-mlb',
  sport: 'baseball',
};

describe('home and away', () => {
  /**
   * The ordering convention is not shared across sports: North America writes the
   * visitor first, most of the world writes the host first. A schedule listing 354
   * leagues mixes both in one column, so position alone can never say which side is
   * at home.
   */
  test('a row marks each side', async () => {
    const out = await render(EventRow({ event: EVENT }));
    expect(out).toContain('title="Away team"');
    expect(out).toContain('title="Home team"');
    // The mark belongs to the team it precedes, not to the row.
    expect(out.indexOf('title="Away team"')).toBeLessThan(out.indexOf('San Diego Padres'));
    expect(out.indexOf('title="Home team"')).toBeLessThan(out.indexOf('New York Mets'));
    expect(out.indexOf('San Diego Padres')).toBeLessThan(out.indexOf('New York Mets'));
  });

  test('a neutral ground claims nothing', async () => {
    // A World Cup group game or an NFL game in London still names a home side in
    // the feed. Printing "Home" next to it would be false.
    const out = await render(EventRow({ event: { ...EVENT, neutral_site: true } }));
    expect(out).not.toContain('title="Home team"');
    expect(out).not.toContain('title="Away team"');
    expect(out).toContain('vs');
  });

  test('a row without both team names falls back to the provider title', async () => {
    const out = await render(EventRow({ event: { ...EVENT, home_name: null, away_name: null } }));
    expect(out).toContain('San Diego Padres at New York Mets');
    expect(out).not.toContain('title="Home team"');
  });
});

describe('where the game is', () => {
  test('a row names the city, not only the arena', async () => {
    const out = await render(EventRow({ event: EVENT }));
    expect(out).toContain('Citi Field, New York');
  });

  test('a missing city leaves the arena alone rather than a dangling comma', async () => {
    const out = await render(EventRow({ event: { ...EVENT, venue_city: null } }));
    expect(out).toContain('Citi Field');
    expect(out).not.toContain('Citi Field,');
  });

  test('the calendar entry carries somewhere a phone can navigate to', () => {
    const ics = buildCalendar([EVENT], { name: 'Test', siteUrl: 'https://genrewatch.com' });
    expect(ics).toContain('LOCATION:Citi Field\\, New York\\, New York');
  });

  test('the feed item says where too', () => {
    const xml = buildFeed([EVENT], {
      title: 'T',
      description: 'D',
      feedUrl: 'https://genrewatch.com/feeds/all.xml',
      siteUrl: 'https://genrewatch.com',
    });
    expect(xml).toContain('at Citi Field, New York');
  });
});

describe('the adapter supplies both', () => {
  test('a real schedule carries a region and a neutral flag', async () => {
    const { events } = await espn.fetchSchedule({
      providerKey: 'soccer/eng.1',
      from: new Date(),
      to: new Date(Date.now() + 21 * 86400000),
    });
    expect(events.length).toBeGreaterThan(0);

    // Every fixture must carry the flag as a real boolean: null would render as
    // "not neutral" by accident rather than by decision.
    for (const e of events) expect(typeof e.neutralSite).toBe('boolean');

    // Soccer venues carry a country where US ones carry a state; at least one
    // fixture in a fortnight of the Premier League should have an address at all.
    const withRegion = events.filter((e) => e.venueRegion);
    expect(withRegion.length).toBeGreaterThan(0);
  }, 60000);
});
