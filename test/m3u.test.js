import { describe, expect, test } from 'bun:test';
import {
  channelMatchesTitle,
  channelsForTitle,
  groupsOf,
  isPlaceholder,
  oneChannelM3u,
  parseM3u,
  rankChannelsForTitle,
} from '../packages/catalog/src/m3u.js';

describe('parsing a provider playlist', () => {
  test('reads the title, the group and the URL', () => {
    const list = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="bbc1" group-title="UK | Entertainment",BBC One HD',
      'http://example.test/live/u/p/1.ts',
    ].join('\n');

    expect(parseM3u(list)).toEqual([
      {
        title: 'BBC One HD',
        group: 'UK | Entertainment',
        url: 'http://example.test/live/u/p/1.ts',
      },
    ]);
  });

  /*
   * The bug this parser exists to fix.
   *
   * The sports version split the #EXTINF line on the FIRST comma and called the
   * rest the title. Provider groups routinely contain a comma -- "Movies, Action"
   * is ordinary -- so that produced a title of ` Action",Die Hard` for every such
   * channel. Splitting on the last comma is the whole difference.
   */
  test('a comma inside an attribute does not eat the title', () => {
    const list = [
      '#EXTINF:-1 group-title="Movies, Action",Die Hard',
      'https://example.test/vod/1.mp4',
    ].join('\n');

    const [ch] = parseM3u(list);
    expect(ch.title).toBe('Die Hard');
    expect(ch.group).toBe('Movies, Action');
  });

  test('#EXTGRP applies until it is changed', () => {
    const list = [
      '#EXTM3U',
      '#EXTGRP:Documentary',
      '#EXTINF:-1,Planet Earth',
      'https://example.test/1.ts',
      '#EXTINF:-1,Blue Planet',
      'https://example.test/2.ts',
      '#EXTGRP:Kids',
      '#EXTINF:-1,Bluey',
      'https://example.test/3.ts',
    ].join('\n');

    expect(parseM3u(list).map((c) => [c.title, c.group])).toEqual([
      ['Planet Earth', 'Documentary'],
      ['Blue Planet', 'Documentary'],
      ['Bluey', 'Kids'],
    ]);
  });

  test('an explicit group-title beats an inherited #EXTGRP', () => {
    const list = [
      '#EXTGRP:Kids',
      '#EXTINF:-1 group-title="Horror",The Thing',
      'https://example.test/1.ts',
    ].join('\n');
    expect(parseM3u(list)[0].group).toBe('Horror');
  });

  test('entries with no usable URL are skipped rather than guessed at', () => {
    const list = [
      '#EXTINF:-1,Broken',
      'rtmp://example.test/nope',
      '#EXTINF:-1,Fine',
      'https://ok.test/x.ts',
    ].join('\n');
    expect(parseM3u(list).map((c) => c.title)).toEqual(['Fine']);
  });

  test('groups come back largest first, for the reader own genre index', () => {
    const channels = [
      { group: 'Movies' },
      { group: 'Movies' },
      { group: 'Kids' },
      { group: '' },
      { group: null },
    ];
    expect(groupsOf(channels)).toEqual([
      { name: 'Movies', count: 2 },
      { name: 'Kids', count: 1 },
    ]);
  });
});

describe('matching a channel to an event', () => {
  /*
   * The sports version required BOTH team names, which made the separator between
   * them irrelevant and rejected a channel that merely mentioned one club. A genre
   * event has ONE name, so that safeguard is gone and the opposite risk appears:
   * a short title matching inside an unrelated word.
   */
  test('a title matches only on whole words', () => {
    expect(channelMatchesTitle('Dunedin News', 'Dune')).toBe(false);
    expect(channelMatchesTitle('Dune Part Two 4K', 'Dune')).toBe(true);
  });

  test('provider furniture is ignored on both sides', () => {
    expect(channelMatchesTitle('[4K] Severance (2026) UHD', 'Severance')).toBe(true);
  });

  test('a very short name must match the channel almost exactly', () => {
    expect(channelMatchesTitle('UP Network HD', 'Up')).toBe(false);
    expect(channelMatchesTitle('Up', 'Up')).toBe(true);
  });

  test('the plainest title ranks first', () => {
    const channels = [
      { title: 'Severance S02E03 REPLAY 2026-08-19', url: 'a' },
      { title: 'Severance', url: 'b' },
    ];
    expect(channelsForTitle(channels, { title: 'Severance' })[0].url).toBe('b');
  });
});

describe('handing one channel back', () => {
  test('emits a playable single-entry list', () => {
    expect(oneChannelM3u({ title: 'BBC One', url: 'http://x.test/1.ts' })).toBe(
      '#EXTM3U\n#EXTINF:-1,BBC One\nhttp://x.test/1.ts\n',
    );
  });

  test('a newline in a title cannot break the file format', () => {
    const out = oneChannelM3u({ title: 'Bad\nTitle', url: 'http://x.test/1.ts' });
    expect(out.split('\n').length).toBe(4);
  });
});

describe('tiered matching, ported from the sports matcher', () => {
  const ch = (...titles) => titles.map((t, i) => ({ title: t, url: `u${i}` }));

  /*
   * TOO STRICT was one of the two faults upstream found. Providers abbreviate:
   * a list writes "Severance S02" where the catalogue stores "Severance". The
   * whole-name test still passes there, but a partial like "Foundation Ep 3"
   * against "Foundation" must not be thrown away.
   */
  test('a full-name match is certain', () => {
    const r = rankChannelsForTitle(ch('Severance S02 FHD'), { title: 'Severance' });
    expect(r.certain.map((c) => c.title)).toEqual(['Severance S02 FHD']);
  });

  test('a partial match is likely, not certain', () => {
    const r = rankChannelsForTitle(ch('Dune HD'), { title: 'Dune Part Three' });
    expect(r.certain).toEqual([]);
    expect(r.likely.map((c) => c.title)).toEqual(['Dune HD']);
  });

  /*
   * And the guard that makes loose matching safe. "Dune" appears in "Dune Part
   * Two", so a partial match would happily offer the wrong film to someone
   * waiting for Part Three. A sequel word the subject does not have refuses it.
   */
  test('a different instalment is refused rather than offered', () => {
    const r = rankChannelsForTitle(ch('Dune Part Two 4K'), { title: 'Dune Part Three' });
    expect(r.certain).toEqual([]);
    expect(r.likely).toEqual([]);
  });

  test('but the right instalment still matches', () => {
    const r = rankChannelsForTitle(ch('Dune Part Three 4K'), { title: 'Dune Part Three' });
    expect(r.certain.length).toBe(1);
  });

  /*
   * A 24/7 genre channel carries whatever is on. That is worth showing and is a
   * DIFFERENT claim from "your show is on this", so it gets its own tier.
   */
  test('a genre channel is its own tier, not a match', () => {
    const r = rankChannelsForTitle(ch('Horror HD'), {
      title: 'The Thing',
      genreName: 'Horror',
    });
    expect(r.certain).toEqual([]);
    expect(r.genre.map((c) => c.title)).toEqual(['Horror HD']);
    // And the flat helper excludes it, because it is not an answer to "where is
    // my show on".
    expect(channelsForTitle(ch('Horror HD'), { title: 'The Thing', genreName: 'Horror' })).toEqual(
      [],
    );
  });

  /*
   * Providers park hundreds of unassigned slots. They are short, so they win a
   * shortest-title tiebreak, and every one is dead air.
   */
  test('parked slots are dropped rather than ranked', () => {
    expect(isPlaceholder('MOVIES 03:')).toBe(true);
    expect(isPlaceholder('HORROR: BLANK')).toBe(true);
    expect(isPlaceholder('EN: TBD')).toBe(true);
    expect(isPlaceholder('Severance')).toBe(false);

    const r = rankChannelsForTitle(ch('MOVIES 03:', 'Severance S02'), { title: 'Severance' });
    expect(r.certain.map((c) => c.title)).toEqual(['Severance S02']);
  });

  test('a name made only of stop words still matches on the whole phrase', () => {
    const r = rankChannelsForTitle(ch('The Show HD'), { title: 'The Show' });
    expect(r.certain.length).toBe(1);
  });
});
