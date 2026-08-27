import { describe, expect, test } from 'bun:test';
import { rankChannelsForTitle } from '../packages/catalog/src/m3u.js';

/**
 * "Why is this page matching streams for Top Chef instead of Top Gun: Maverick?"
 *
 * Because one word was enough. The ranker accepted any channel sharing a single
 * significant token with the title -- "Top Chef S23E07" and "Top Gun: Maverick"
 * share "top" -- and then, because the entry was a video file rather than a live
 * channel, promoted it into the ON-DEMAND tier: the strongest claim the page
 * makes, made on the weakest evidence there is.
 *
 * Two separate mistakes, and both are fixed here:
 *   1. one token out of three is a coincidence, not a match;
 *   2. what separates the tiers is how sure we are, not whether the entry
 *      happens to be a file. Certainty is decided by matching every word.
 */

const file = (id, title) => ({ id, title, url: `http://x/movie/${id}.mkv`, kind: 'vod' });
const series = (id, title) => ({ id, title, url: `http://x/series/${id}.mkv`, kind: 'series' });
const chan = (id, title) => ({ id, title, url: `http://x/live/${id}.ts`, kind: 'live' });

const rank = (channels, title) => rankChannelsForTitle(channels, { title });

describe('the reported case', () => {
  const TOP_CHEF = [
    series(1, 'Top Chef S23E07'),
    series(2, 'Top Chef S19E10'),
    series(3, 'Top Chef S19E09'),
  ];

  test('Top Chef is not offered for Top Gun: Maverick, in any tier', () => {
    const r = rank(TOP_CHEF, 'Top Gun: Maverick');
    expect(r.onDemand).toEqual([]);
    expect(r.certain).toEqual([]);
    expect(r.likely).toEqual([]);
  });

  test('and the actual film still is', () => {
    const r = rank([...TOP_CHEF, file(9, '4K: Top Gun: Maverick (2022)')], 'Top Gun: Maverick');
    expect(r.onDemand.map((c) => c.id)).toEqual([9]);
  });

  /*
   * The 1986 film shares two of the three words. It is genuinely a near miss
   * rather than a coincidence, so it is offered -- but as a maybe, never as the
   * on-demand copy of what was asked for.
   */
  test('a near miss is a maybe, not a certainty', () => {
    const r = rank([file(10, 'Top Gun (1986)')], 'Top Gun: Maverick');
    expect(r.onDemand).toEqual([]);
    expect(r.likely.map((c) => c.id)).toEqual([10]);
  });
});

describe('what still has to match', () => {
  test('an exact file is on demand', () => {
    expect(rank([file(1, 'Casablanca (1942)')], 'Casablanca').onDemand.map((c) => c.id)).toEqual([
      1,
    ]);
  });

  test('a series episode matches on the show name', () => {
    expect(rank([series(2, 'Severance S02E03')], 'Severance').onDemand.map((c) => c.id)).toEqual([
      2,
    ]);
  });

  test('a live channel of the exact name is certain, not on demand', () => {
    const r = rank([chan(3, 'Top Gun: Maverick')], 'Top Gun: Maverick');
    expect(r.certain.map((c) => c.id)).toEqual([3]);
    expect(r.onDemand).toEqual([]);
  });

  test('a long title still matches on half its words', () => {
    // Four significant words; a file naming two of them is a real candidate.
    const r = rank([file(4, 'MI Dead Reckoning')], 'Mission Impossible Dead Reckoning');
    expect(r.likely.map((c) => c.id)).toEqual([4]);
  });

  test('but not on one of them', () => {
    expect(rank([file(5, 'Dead Silence')], 'Mission Impossible Dead Reckoning').likely).toEqual([]);
  });
});

describe('single common words', () => {
  /*
   * The general form of the bug. Every one of these shares exactly one word with
   * the title and nothing else, and every one of them used to be offered.
   */
  for (const [title, decoy] of [
    ['Top Gun: Maverick', 'Top Chef S23E07'],
    ['The Last of Us', 'Last Man Standing S01E02'],
    ['Dead Poets Society', 'The Walking Dead S11E01'],
    ['Star Wars', 'Star Trek: Picard S03E01'],
  ]) {
    test(`"${decoy}" is not offered for "${title}"`, () => {
      const r = rank([series(1, decoy)], title);
      expect([...r.onDemand, ...r.certain, ...r.likely]).toEqual([]);
    });
  }
});
