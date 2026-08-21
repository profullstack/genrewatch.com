import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  allMarkets,
  matchListings,
  normaliseTeam,
  pickMarket,
  sameTeam,
  splitFixture,
  sportName,
} from '../packages/sports/src/sportsdb.js';

/**
 * The fallback that fills in broadcasters ESPN does not carry.
 *
 * Two halves worth guarding. The matcher decides whether a TV listing describes one
 * of our fixtures, and a false positive there is the expensive kind of bug -- it
 * tells somebody to turn on a channel that is showing something else. And the write
 * has to lose to ESPN, which is the more precise source wherever it has an answer.
 */

describe('team name matching', () => {
  test('club suffixes are noise, not identity', () => {
    expect(normaliseTeam('Collingwood Football Club')).toBe('collingwood');
    expect(sameTeam('Collingwood Football Club', 'Collingwood')).toBe(true);
    expect(sameTeam('Brisbane Lions', 'Brisbane Lions')).toBe(true);
  });

  test('a shared word is not a shared team', () => {
    // The exact pair that plain substring matching gets wrong.
    expect(sameTeam('Manchester City', 'Manchester United')).toBe(false);
    expect(sameTeam('Norwich City', 'Manchester City')).toBe(false);
    expect(sameTeam('Real Madrid', 'Real Sociedad')).toBe(false);
  });

  test('a fragment cannot match a league', () => {
    // Without the length floor, "ars" matches Arsenal and every other short token
    // becomes a wildcard across 354 leagues.
    expect(sameTeam('ars', 'Arsenal')).toBe(false);
    expect(sameTeam('', 'Arsenal')).toBe(false);
  });

  test('accents are folded', () => {
    expect(sameTeam('Atlético Madrid', 'Atletico Madrid')).toBe(true);
  });
});

describe('fixture titles', () => {
  test('splits "Home vs Away"', () => {
    expect(splitFixture('Collingwood Football Club vs Brisbane Lions')).toEqual([
      'Collingwood Football Club',
      'Brisbane Lions',
    ]);
  });

  test('anything that is not two sides is rejected rather than guessed', () => {
    expect(splitFixture('NFL RedZone')).toBeNull();
    expect(splitFixture('')).toBeNull();
  });
});

describe('matching an event to listings', () => {
  // The real row TheSportsDB returned for genrewatch event 455, verified
  // 2026-08-21 -- the fixture ESPN reports with an empty broadcasts array.
  const listings = [
    {
      event: 'Collingwood Football Club vs Brisbane Lions',
      channel: '7 Queensland',
      country: 'Australia',
    },
    { event: 'Carlton vs Fremantle', channel: 'Fox Footy', country: 'Australia' },
  ];

  test('matches the fixture ESPN has no broadcaster for', () => {
    const hits = matchListings({ home: 'Collingwood', away: 'Brisbane Lions' }, listings);
    expect(hits).toHaveLength(1);
    expect(hits[0].channel).toBe('7 Queensland');
  });

  test('home/away order does not matter', () => {
    // ESPN titles it "Away at Home" and TheSportsDB "Home vs Away". Requiring both
    // sides to match means the disagreement costs nothing.
    const hits = matchListings({ home: 'Brisbane Lions', away: 'Collingwood' }, listings);
    expect(hits).toHaveLength(1);
  });

  test('one side matching is not a match', () => {
    expect(matchListings({ home: 'Collingwood', away: 'Carlton' }, listings)).toHaveLength(0);
  });

  test('an event with an unresolved side is skipped, not guessed', () => {
    expect(matchListings({ home: 'Collingwood', away: null }, listings)).toHaveLength(0);
  });
});

describe('choosing a market', () => {
  const rows = [
    { channel: 'Sky Sports', country: 'United Kingdom' },
    { channel: 'TNT Sports', country: 'United Kingdom' },
    { channel: 'USA Network', country: 'United States' },
  ];

  test('picks the market with the most coverage and names it', () => {
    expect(pickMarket(rows)).toEqual({
      country: 'United Kingdom',
      channels: ['Sky Sports', 'TNT Sports'],
    });
  });

  test('a preferred market wins even when it is smaller', () => {
    expect(pickMarket(rows, 'United States')).toEqual({
      country: 'United States',
      channels: ['USA Network'],
    });
  });

  test('nothing to show is null rather than an empty string', () => {
    expect(pickMarket([])).toBeNull();
    expect(pickMarket([{ channel: '', country: 'Australia' }])).toBeNull();
  });
});

describe('keeping every market', () => {
  // A Champions League tie is the case that made this necessary: four broadcasters
  // across three countries, where collapsing to one showed most readers a channel
  // they cannot watch.
  const rows = [
    { channel: 'CBS', country: 'United States' },
    { channel: 'Paramount+', country: 'United States' },
    { channel: 'TNT Sports', country: 'United Kingdom' },
    { channel: 'beIN Sports', country: 'France' },
  ];

  test('groups by country, widest market first', () => {
    expect(allMarkets(rows)).toEqual([
      { country: 'United States', channels: ['CBS', 'Paramount+'] },
      { country: 'France', channels: ['beIN Sports'] },
      { country: 'United Kingdom', channels: ['TNT Sports'] },
    ]);
  });

  test('equal markets order alphabetically, so syncs do not reshuffle the tabs', () => {
    const a = allMarkets([
      { channel: 'TNT Sports', country: 'United Kingdom' },
      { channel: 'beIN Sports', country: 'France' },
    ]);
    expect(a.map((m) => m.country)).toEqual(['France', 'United Kingdom']);
  });

  test('a duplicated listing is one channel, not two', () => {
    const a = allMarkets([
      { channel: 'Sky Sports', country: 'United Kingdom' },
      { channel: 'Sky Sports', country: 'United Kingdom' },
    ]);
    expect(a).toEqual([{ country: 'United Kingdom', channels: ['Sky Sports'] }]);
  });

  test('an unattributed listing is International rather than dropped', () => {
    expect(allMarkets([{ channel: 'MLS Season Pass', country: null }])).toEqual([
      { country: 'International', channels: ['MLS Season Pass'] },
    ]);
  });

  test('the flat column still gets the primary market, for the feeds', () => {
    // RSS, ICS and the reminder emails have nowhere to put a tab strip.
    expect(pickMarket(rows).channels.join(', ')).toBe('CBS, Paramount+');
  });
});

describe('sport name mapping', () => {
  test('our ESPN slugs translate', () => {
    expect(sportName('australian-football')).toBe('Australian Football');
    expect(sportName('football')).toBe('American Football');
    expect(sportName('hockey')).toBe('Ice Hockey');
  });

  test('an unmapped sport is null, so the caller does not invent a name', () => {
    expect(sportName('kabaddi')).toBeNull();
  });
});

describe('the write loses to ESPN', () => {
  let db;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    // Seeded BETWEEN 0013 and 0014, not after both. The backfill in 0014 is the
    // thing under test, and a row inserted once every migration has run is a row
    // the backfill never saw -- which is how this test first passed vacuously.
    for (const f of files.filter((f) => f < '0014')) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    await db.exec(`
      insert into leagues (provider, provider_key, sport, slug, name)
        values ('espn','australian-football/afl','australian-football','afl','AFL');
      insert into events (provider, provider_key, league_id, starts_at, state, name)
        values
          ('espn','1','1',now() + interval '1 day','pre','no listing yet'),
          ('espn','2','1',now() + interval '1 day','pre','espn already answered');
      update events set broadcast = 'NFL Net', broadcast_source = 'espn', broadcast_country = 'United States'
        where provider_key = '2';
    `);
    for (const f of files.filter((f) => f >= '0014')) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);

  test('the migration backfills provenance for listings already stored', async () => {
    // 0013 runs over a table that already holds ESPN values; they must not end up
    // labelled as coming from nowhere.
    const { rows } = await db.query(
      `select broadcast_source, broadcast_country from events where provider_key = '2'`,
    );
    expect(rows[0]).toEqual({ broadcast_source: 'espn', broadcast_country: 'United States' });
  });

  test('fills a fixture that has no broadcaster', async () => {
    const { rows } = await db.query(
      `update events e set broadcast = v.broadcast, broadcast_source = 'thesportsdb',
              broadcast_country = v.country
         from (values (1::bigint, '7 Queensland'::text, 'Australia'::text)) as v(id, broadcast, country)
        where e.id = v.id and e.broadcast is null
        returning e.id`,
    );
    expect(rows).toHaveLength(1);
    const [row] = (
      await db.query(`select broadcast, broadcast_country from events where provider_key = '1'`)
    ).rows;
    expect(row).toEqual({ broadcast: '7 Queensland', broadcast_country: 'Australia' });
  });

  test('0014 backfills a market list from what 0013 already stored', async () => {
    // A row that had a listing before the picker existed must not render an empty
    // tab strip until its league happens to be swept again.
    const { rows } = await db.query(
      `select broadcast_markets from events where provider_key = '2'`,
    );
    expect(rows[0].broadcast_markets).toEqual([
      { country: 'United States', channels: ['NFL Net'] },
    ]);
  });

  test('a multi-market write round-trips through jsonb', async () => {
    await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, state, name)
         values ('espn','3','1',now() + interval '2 days','pre','carried everywhere')`,
    );
    const markets = [
      { country: 'United States', channels: ['CBS', 'Paramount+'] },
      { country: 'United Kingdom', channels: ['TNT Sports'] },
    ];
    await db.query(
      `update events e set broadcast = $2, broadcast_country = $3,
              broadcast_markets = $4::jsonb, broadcast_source = 'thesportsdb'
         where e.provider_key = $1 and e.broadcast is null`,
      ['3', 'CBS, Paramount+', 'United States', JSON.stringify(markets)],
    );
    const { rows } = await db.query(
      `select broadcast, broadcast_markets from events where provider_key = '3'`,
    );
    expect(rows[0].broadcast_markets).toEqual(markets);
    // The flat column keeps carrying the primary market for the feeds.
    expect(rows[0].broadcast).toBe('CBS, Paramount+');
  });

  test('refuses to overwrite a listing ESPN already supplied', async () => {
    // The pass fetches over the network between building its work list and
    // writing, and a live tick landing an ESPN listing in that gap is expected.
    // The guard lives in the statement, not just in the work list.
    const { rows } = await db.query(
      `update events e set broadcast = v.broadcast, broadcast_source = 'thesportsdb'
         from (values (2::bigint, 'Channel 7'::text)) as v(id, broadcast)
        where e.id = v.id and e.broadcast is null
        returning e.id`,
    );
    expect(rows).toHaveLength(0);
    const [row] = (
      await db.query(`select broadcast, broadcast_source from events where provider_key = '2'`)
    ).rows;
    expect(row).toEqual({ broadcast: 'NFL Net', broadcast_source: 'espn' });
  });
});

describe('the market picker renders', () => {
  /** Enough of an event row for EventPage; the picker only reads the markets. */
  const eventWith = (markets) => ({
    id: 455,
    league_id: 1,
    league_name: 'AFL',
    league_slug: 'australian-football-afl',
    sport: 'australian-football',
    name: 'Brisbane Lions at Collingwood',
    short_name: 'BL @ COLL',
    starts_at: new Date('2026-08-21T09:40:00Z'),
    state: 'pre',
    home_name: 'Collingwood',
    away_name: 'Brisbane Lions',
    broadcast: markets?.[0]?.channels.join(', ') ?? null,
    broadcast_country: markets?.[0]?.country ?? null,
    broadcast_markets: markets,
  });

  const html = async (event) => {
    const { EventPage } = await import('../apps/web/src/views/pages.jsx');
    return String(
      EventPage({ user: null, event, offers: [], plays: [], comments: [], entitlement: null }),
    );
  };

  test('two markets become a labelled list, one per country', async () => {
    const out = await html(
      eventWith([
        { country: 'United States', channels: ['CBS', 'Paramount+'] },
        { country: 'United Kingdom', channels: ['TNT Sports'] },
      ]),
    );
    expect(out).toContain('Where to watch');
    expect(out).toContain('data-country="United States"');
    expect(out).toContain('data-country="United Kingdom"');
    // Every market is on the page before any script runs: with JS off the reader
    // sees all of them rather than one country's channels presented as the answer.
    expect(out).toContain('CBS · Paramount+');
    expect(out).toContain('TNT Sports');
  });

  test('a single market stays a stat tile and grows no picker', async () => {
    const out = await html(eventWith([{ country: 'Australia', channels: ['7 Queensland'] }]));
    expect(out).not.toContain('Where to watch');
    expect(out).toContain('Watch on TV · Australia');
  });

  test('a fixture nobody lists renders neither', async () => {
    const out = await html(eventWith(null));
    expect(out).not.toContain('Where to watch');
    expect(out).not.toContain('Watch on TV');
  });

  test('a jsonb column arriving as a string is still rendered', async () => {
    // Whether the driver parses jsonb is not something the view should depend on.
    const markets = [
      { country: 'United States', channels: ['CBS'] },
      { country: 'France', channels: ['beIN Sports'] },
    ];
    const out = await html({ ...eventWith(markets), broadcast_markets: JSON.stringify(markets) });
    expect(out).toContain('data-country="France"');
  });
});
