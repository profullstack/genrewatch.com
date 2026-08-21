/* Renders signed-in pages to static HTML so they can be looked at without a session.
   Scratch tooling: writes into .preview/, which is not committed. */
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
process.env.SITE_URL = 'https://genrewatch.com';

import { cp, mkdir, writeFile } from 'node:fs/promises';

const { EventPage, Following, PushCheck } = await import('./apps/web/src/views/pages.jsx');

const OUT = new URL('./.preview/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
await cp(new URL('./apps/web/public/', import.meta.url).pathname, OUT, { recursive: true });

const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();

const events = [
  {
    id: 1,
    name: 'Detroit Tigers at Pittsburgh Pirates',
    starts_at: at(3),
    state: 'pre',
    league_name: 'Major League Baseball',
    venue: 'PNC Park',
    venue_city: 'Pittsburgh',
    neutral_site: false,
    home_name: 'Pittsburgh Pirates',
    away_name: 'Detroit Tigers',
    home_score: null,
    away_score: null,
  },
  {
    id: 2,
    name: 'Málaga at Atlético Madrid',
    starts_at: at(27),
    state: 'pre',
    league_name: 'LaLiga',
    venue: 'Metropolitano',
    venue_city: 'Madrid',
    neutral_site: false,
    home_name: 'Atlético Madrid',
    away_name: 'Málaga',
    home_score: null,
    away_score: null,
  },
  {
    // A neutral ground: the feed still names a home side, and the page must not.
    id: 3,
    name: 'Argentina vs France',
    starts_at: at(50),
    state: 'pre',
    league_name: 'FIFA World Cup',
    venue: 'Lusail Stadium',
    venue_city: 'Lusail',
    neutral_site: true,
    home_name: 'Argentina',
    away_name: 'France',
    home_score: null,
    away_score: null,
  },
];

const pages = {
  'following.html': Following({
    user: { id: 1, email: 'you@example.com' },
    events,
    follows: [
      { subject_type: 'team', subject_id: 10, label: 'Pittsburgh Pirates' },
      { subject_type: 'team', subject_id: 11, label: 'Atlético Madrid' },
      { subject_type: 'league', subject_id: 3, label: 'Premier League' },
    ],
    vapidKey:
      'BExampleVapidPublicKeyForLayoutOnly_notARealKey_0000000000000000000000000000000000000',
    calendarUrl: 'https://genrewatch.com/calendar/me/00000000-0000-4000-8000-000000000000.ics',
  }),
  'push-check.html': PushCheck({ user: { id: 1 }, vapidKey: 'BDU8swQU' }),
  'event.html': EventPage({
    user: { id: 1 },
    event: {
      id: 42,
      name: 'Detroit Tigers at Pittsburgh Pirates',
      starts_at: at(4),
      state: 'pre',
      league_name: 'Major League Baseball',
      league_slug: 'baseball-mlb',
      sport: 'baseball',
      venue: 'PNC Park',
      venue_city: 'Pittsburgh',
      venue_region: 'Pennsylvania',
      neutral_site: false,
      broadcast: 'MLB.TV, Tigers.TV',
      attendance: 18208,
      home_name: 'Pittsburgh Pirates',
      away_name: 'Detroit Tigers',
      home_slug: 'baseball-mlb-23',
      away_slug: 'baseball-mlb-6',
      home_team_id: 23,
      away_team_id: 6,
      home_record: '61-65',
      away_record: '55-71',
      home_score: null,
      away_score: null,
    },
    offers: [],
    entitlement: null,
    plays: [],
    comments: [],
    followingHome: false,
    followingAway: false,
  }),
};

for (const [file, node] of Object.entries(pages)) {
  const html = `<!doctype html>${(await node.toString()).toString()}`;
  await writeFile(OUT + file, html);
  console.log('wrote', file, html.length, 'bytes');
}
