import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { EventPage } = await import('../apps/web/src/views/pages.jsx');

const EVENT = {
  id: 94,
  name: 'San Francisco 49ers at Los Angeles Chargers',
  short_name: 'SF @ LAC',
  state: 'in',
  sport: 'football',
  league_slug: 'football-nfl',
  league_name: 'National Football League',
  starts_at: new Date('2026-08-21T02:00:00Z'),
  home_name: 'Los Angeles Chargers',
  away_name: 'San Francisco 49ers',
  home_score: 0,
  away_score: 0,
  home_team_id: 24,
  away_team_id: 25,
};

/** A stored row as playsForEvent returns it: snake_case, nulls not undefined. */
const play = (over) => ({
  id: 1,
  text: 'K.Black left tackle to SF 11 for 5 yards',
  away_score: null,
  home_score: null,
  scoring: false,
  period_number: 1,
  period_label: '13:43 · 1st',
  play_type: 'Rush',
  ...over,
});

const html = async (props) =>
  (
    await EventPage({
      user: null,
      event: EVENT,
      offers: [],
      entitlement: null,
      ...props,
    }).toString()
  ).toString();

describe('event page action log', () => {
  test('a game with no stored plays shows no empty section', async () => {
    const out = await html({ plays: [] });
    expect(out).not.toContain('Live action');
    expect(out).not.toContain('How it went');
  });

  test('a live game with plays gets the live heading and the log', async () => {
    const out = await html({ plays: [play({})] });
    expect(out).toContain('Live action');
    expect(out).toContain('K.Black left tackle');
    expect(out).toContain('13:43 · 1st');
  });

  test('a finished game reads as a recap rather than as live', async () => {
    const out = await html({ event: { ...EVENT, state: 'post' }, plays: [play({})] });
    expect(out).toContain('How it went');
    expect(out).not.toContain('Live action');
  });

  test('a scoring play with a running score shows it', async () => {
    const out = await html({
      plays: [play({ text: 'CJ Donaldson 1 Yd Run', scoring: true, away_score: 0, home_score: 7 })],
    });
    expect(out).toContain('0–7');
  });

  test('a scoring play with no running score shows when, not a bare dash', async () => {
    // Soccer states the score in the sentence and leaves the columns null. Rendering
    // them anyway printed "–" on its own where a score belongs.
    const out = await html({
      plays: [
        play({
          text: 'Goal! Vancouver Whitecaps FC 0, Houston Dynamo FC 1. Franco Negri.',
          scoring: true,
          period_label: "34'",
          away_score: null,
          home_score: null,
        }),
      ],
    });
    expect(out).toContain('Franco Negri');
    // Escaped, because a soccer minute label really is an apostrophe.
    expect(out).toContain('<span class="play-when">34&#39;</span>');
    expect(out).not.toContain('>–<');
  });
});

/**
 * Not every fixture is a contest between two named sides.
 *
 * A grand prix, a golf tournament, a fight card and a tennis draw are one event
 * with a field, and the provider gives no competitors at all. The page assumed two
 * sides regardless, so every one of them rendered a pair of blank crests either
 * side of the literal words "Away vs Home", under a Follow heading standing over an
 * empty div -- a follow section with nothing in it to follow.
 */
describe('an event with no two sides', () => {
  const SOLO = {
    id: 61753,
    name: 'US Open',
    short_name: null,
    state: 'pre',
    sport: 'tennis',
    league_id: 77,
    league_slug: 'tennis-atp',
    league_name: 'ATP',
    starts_at: new Date('2026-08-25T04:00:00Z'),
    venue: 'New York, USA',
    neutral_site: true,
    home_name: null,
    away_name: null,
    home_team_id: null,
    away_team_id: null,
    home_score: null,
    away_score: null,
  };

  const solo = async (over) =>
    (
      await EventPage({
        user: null,
        event: { ...SOLO, ...over },
        offers: [],
        entitlement: null,
        plays: [],
        comments: [],
        followingLeague: false,
      }).toString()
    ).toString();

  test('the name is shown instead of "Away vs Home"', async () => {
    const out = await solo();
    expect(out).toContain('US Open');
    expect(out).not.toContain('>Away<');
    expect(out).not.toContain('>Home<');
  });

  test('no blank crest is drawn where there is no team', async () => {
    const out = await solo();
    expect(out).not.toContain('team-blank');
    expect(out).not.toContain('role-tag');
  });

  test('the scoreboard drops to two columns rather than leaving a hole', async () => {
    const out = await solo();
    expect(out).toContain('class="scoreboard solo"');
    // And "vs" means nothing with one name, so it is not printed either.
    expect(out).not.toContain('<span class="vs">vs</span>');
  });

  test('the competition can be followed, since there is no side to', async () => {
    const out = await solo();
    expect(out).toContain('Follow ATP');
    // Signed out, that is a prompt to sign in rather than a dead heading.
    expect(out).toContain('/login?next=%2Fevents%2F61753');
  });

  test('a live one still shows its status', async () => {
    const out = await solo({ state: 'in', status_detail: 'Round 2' });
    expect(out).toContain('Round 2');
    expect(out).toContain('badge live');
  });

  test('a normal fixture is untouched', async () => {
    const out = await html({ plays: [] });
    expect(out).toContain('San Francisco 49ers');
    expect(out).toContain('Los Angeles Chargers');
    expect(out).not.toContain('scoreboard solo');
    // Both team follows still offered, and no league follow bolted on.
    expect(out).toContain('Follow San Francisco 49ers');
    expect(out).toContain('Follow Los Angeles Chargers');
    expect(out).not.toContain('Follow National Football League');
  });
});
