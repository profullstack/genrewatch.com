import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  channelMatchesFixture,
  channelsForFixture,
  oneChannelM3u,
  parseM3u,
} from '../packages/sports/src/m3u.js';

process.env.PLAYLIST_SECRET = 'test-secret-for-sealing-values';
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * A reader's own channel list.
 *
 * The feature is personal by construction and the tests are mostly about keeping it
 * that way: one account's list must never be reachable from another, the stored URL
 * is a credential and must never be stored or rendered in the clear, and the match
 * has to require BOTH teams or it will point somebody at the wrong game.
 */

describe('parsing a real provider playlist', () => {
  // Shapes taken from an actual 7,059-entry list: numbered slots with the teams in
  // the title, empty slots, a session-data line, and entries whose URL is separated
  // from the #EXTINF by another directive.
  const sample = [
    '#EXTM3U',
    '#EXT-X-SESSION-DATA:DATA-ID="com.xui.1_5_13"',
    '#EXTINF:-1,NFL 01: 8PM Las Vegas Raiders  vs  Houston Texans',
    'http://example.test/u/p/406464',
    '#EXTINF:-1,NFL 03:',
    'http://example.test/u/p/406466',
    '#EXTINF:-1,D+ (UK) Events 96: Australian Rules Football | GWS Giants _ Carlton | AFL',
    '#EXTVLCOPT:network-caching=1000',
    'http://example.test/u/p/397524',
    '#EXTINF:-1,Broken entry with no url',
  ].join('\n');

  test('reads title and url pairs', () => {
    const rows = parseM3u(sample);
    expect(rows).toHaveLength(3);
    expect(rows[0].title).toBe('NFL 01: 8PM Las Vegas Raiders  vs  Houston Texans');
    expect(rows[0].url).toBe('http://example.test/u/p/406464');
  });

  test('an empty slot is kept, because it gets a title later', () => {
    // The provider rewrites these near kickoff; dropping them means the next
    // refresh is the only way they ever appear.
    expect(parseM3u(sample)[1].title).toBe('NFL 03:');
  });

  test('a directive between the title and the url does not break the pair', () => {
    expect(parseM3u(sample)[2].url).toBe('http://example.test/u/p/397524');
  });

  test('an entry with no url is dropped rather than half-stored', () => {
    expect(parseM3u(sample).some((r) => r.title.startsWith('Broken'))).toBe(false);
  });

  test('nothing usable in, nothing out', () => {
    expect(parseM3u('')).toEqual([]);
    expect(parseM3u('not a playlist at all')).toEqual([]);
  });
});

describe('matching a fixture to a channel', () => {
  test('both teams must appear, whatever the separator', () => {
    expect(
      channelMatchesFixture(
        'NFL 01: 8PM Las Vegas Raiders  vs  Houston Texans',
        'Houston Texans',
        'Las Vegas Raiders',
      ),
    ).toBe(true);
    // Underscore, pipe and dash all appear in the same real playlist.
    expect(
      channelMatchesFixture(
        'D+ (UK) Events 96: Aussie Rules | GWS Giants _ Carlton | AFL',
        'Carlton',
        'GWS Giants',
      ),
    ).toBe(true);
    expect(
      channelMatchesFixture('(GB) ViaPlay 22: Ulster - Cardiff Rugby', 'Ulster', 'Cardiff'),
    ).toBe(true);
  });

  test('one team is not enough', () => {
    // A 24/7 club channel mentions one side forever and is never "this fixture".
    expect(channelMatchesFixture('Arsenal - EPL - Premier League', 'Arsenal', 'Chelsea')).toBe(
      false,
    );
  });

  test('a shared word does not make a match', () => {
    expect(
      channelMatchesFixture('Manchester City vs Norwich City', 'Manchester United', 'Norwich City'),
    ).toBe(false);
  });

  test('an empty slot matches nothing', () => {
    expect(channelMatchesFixture('NFL 03:', 'Houston Texans', 'Las Vegas Raiders')).toBe(false);
  });

  test('the shortest title ranks first, as the most specific slot', () => {
    const picked = channelsForFixture(
      [
        {
          title: 'NFL 07: Raiders vs Texans (Spanish alternate feed, replay 2026-08-21)',
          url: 'b',
        },
        { title: 'NFL 01: Raiders vs Texans', url: 'a' },
      ],
      { home: 'Texans', away: 'Raiders' },
    );
    expect(picked[0].url).toBe('a');
  });
});

describe('the hand-off file', () => {
  test('is a one-channel playlist carrying the reader’s own url', () => {
    const out = oneChannelM3u({ title: 'NFL 01', url: 'http://example.test/u/p/1' });
    expect(out).toBe('#EXTM3U\n#EXTINF:-1,NFL 01\nhttp://example.test/u/p/1\n');
  });

  test('a newline in a title cannot forge extra entries', () => {
    const out = oneChannelM3u({ title: 'evil\n#EXTINF:-1,injected', url: 'http://x.test/1' });
    // Counted as LINES, not substrings: the injected text survives as inert
    // characters inside the one title, which is fine -- what must not happen is a
    // second directive line, and only the line count can tell the two apart.
    const directives = out.split('\n').filter((l) => l.startsWith('#EXTINF'));
    expect(directives).toHaveLength(1);
    expect(out.split('\n').filter(Boolean)).toHaveLength(3);
  });
});

describe('sealing the credential', () => {
  test('a sealed url is not the url, and round-trips', async () => {
    const { seal, open } = await import('../packages/auth/src/secretbox.js');
    const url = 'http://206.212.244.192/playlist/user/password/m3u';
    const sealed = seal(url);
    expect(sealed).not.toContain('password');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(open(sealed)).toBe(url);
  });

  test('a tampered value opens as null rather than garbage', async () => {
    const { seal, open } = await import('../packages/auth/src/secretbox.js');
    const sealed = seal('http://example.test/a');
    const [v, iv, tag, body] = sealed.split('.');
    // Flip the ciphertext: GCM must reject it, not decrypt it into nonsense.
    const flipped = [v, iv, tag, `${body.slice(0, -2)}AA`].join('.');
    expect(open(flipped)).toBeNull();
    expect(open('nonsense')).toBeNull();
  });
});

describe('one account cannot reach another', () => {
  let db;
  let alice;
  let bob;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    const mk = async (email) =>
      (await db.query(`insert into users (email) values ($1) returning id`, [email])).rows[0].id;
    alice = await mk('alice@example.test');
    bob = await mk('bob@example.test');

    await db.query(
      `insert into user_playlists (user_id, label, source_url) values ($1, 'alice list', 'sealed-a')`,
      [alice],
    );
    const pl = (await db.query(`select id from user_playlists where user_id = $1`, [alice]))
      .rows[0];
    await db.query(
      `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
       values ($1, 0, 'NFL 01: Raiders vs Texans', 'sealed-url', 'nfl 01 raiders vs texans')`,
      [pl.id],
    );
  }, 60_000);

  test('the owner sees their channels', async () => {
    const { rows } = await db.query(
      `select c.title from user_playlist_channels c
         join user_playlists p on p.id = c.playlist_id
        where p.user_id = $1`,
      [alice],
    );
    expect(rows).toHaveLength(1);
  });

  test('another account sees none of them', async () => {
    const { rows } = await db.query(
      `select c.title from user_playlist_channels c
         join user_playlists p on p.id = c.playlist_id
        where p.user_id = $1`,
      [bob],
    );
    expect(rows).toEqual([]);
  });

  test('one list per account: adding again replaces rather than accumulates', async () => {
    await db.query(
      `insert into user_playlists (user_id, label, source_url) values ($1, 'second', 'sealed-b')
       on conflict (user_id) do update set label = excluded.label, source_url = excluded.source_url`,
      [alice],
    );
    const { rows } = await db.query(`select label from user_playlists where user_id = $1`, [alice]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('second');
  });

  test('deleting the account takes the credentials with it', async () => {
    await db.query(`delete from users where id = $1`, [alice]);
    const left = await db.query(`select 1 from user_playlists where user_id = $1`, [alice]);
    const chans = await db.query(`select 1 from user_playlist_channels`);
    expect(left.rows).toEqual([]);
    expect(chans.rows).toEqual([]);
  });
});

describe('the list is never offered for sale', () => {
  test('no code joins a playlist to stream_offers', async () => {
    // The whole distinction this feature rests on: your own subscription, for you.
    // A join between these two tables would be the moment it stopped being that.
    const q = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const both = /user_playlist[\s\S]{0,400}stream_offers|stream_offers[\s\S]{0,400}user_playlist/;
    expect(both.test(q)).toBe(false);
  });
});
