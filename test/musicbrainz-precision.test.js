import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Which release dates MusicBrainz gives us, and which of them we keep.
 *
 * Music was the thinnest category on the site and the cause was this filter, not
 * the source. MusicBrainz knows about 2,228 official releases in a four-month
 * window; requiring a full YYYY-MM-DD kept 245 of them. A genre only shows up on
 * the site once something in it is coming, so discarding 89% of releases
 * discarded most of the genres with them.
 *
 * The module talks to a rate-limited API, so the date rule is exercised directly
 * rather than through a fetch.
 */

const SRC = readFileSync(
  new URL('../packages/catalog/src/musicbrainz.js', import.meta.url).pathname,
  'utf8',
);

/** The real releaseDate(), lifted out of a module that exports only its adapter. */
const releaseDate = new Function(
  `${SRC.slice(SRC.indexOf('function noonUtc'), SRC.indexOf('/** MusicBrainz genre names'))}
   ;return releaseDate;`,
)();

describe('what counts as a release date', () => {
  test('a full date is kept, at day precision', () => {
    const got = releaseDate('2026-09-18');
    expect(got.precision).toBe('day');
    expect(got.startsAt.toISOString()).toBe('2026-09-18T12:00:00.000Z');
  });

  test('a year-month is kept, at month precision', () => {
    // The 89% that used to be thrown away.
    const got = releaseDate('2026-09');
    expect(got.precision).toBe('month');
    expect(got.startsAt.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  test('a bare year is still refused', () => {
    // "Sometime in 2026" is not something a reader can act on, and it would
    // swamp a four-month window with a whole year.
    expect(releaseDate('2026')).toBeNull();
  });

  test('junk is refused rather than coerced', () => {
    for (const bad of ['', 'soon', '2026-13-40', '26-09-18', null, undefined]) {
      expect(releaseDate(bad)).toBeNull();
    }
  });

  test('noon, so the Americas do not see the day before', () => {
    // Same reason tmdb.js uses noon. Midnight UTC is the previous evening in
    // every timezone west of London.
    for (const d of ['2026-09-18', '2026-09']) {
      expect(releaseDate(d).startsAt.getUTCHours()).toBe(12);
    }
  });
});

describe('a month-precision release cannot claim a time', () => {
  test('timeKnown is false for every release, whatever the precision', () => {
    // There is no such thing as a 3pm album, and a reminder that claims an hour
    // for a month-precision row would be inventing one.
    const block = SRC.slice(SRC.indexOf('events.push({'), SRC.indexOf('runtimeMin'));
    expect(block).toContain('timeKnown: false');
    expect(block).toContain('precision: when.precision');
  });
});

describe('genres per artist', () => {
  test('more than the top four are kept', () => {
    // The tags are already in a response we paid a request for; the fourth to
    // eighth are the specific ones worth browsing by.
    expect(SRC).toContain('.slice(0, 8)');
  });
});
