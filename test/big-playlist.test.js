import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { MAX_CHANNELS, matchTerms, parseM3u } from '../packages/catalog/src/m3u.js';

/**
 * Importing a list that is a whole VOD catalogue rather than a channel lineup.
 *
 * Reported as "I uploaded a 38MB m3u and got: that list is larger than we store".
 * Raising the byte cap alone would not have fixed it -- three other limits sat
 * behind it, and two of them fail silently:
 *
 *   1. the 8MB byte cap, which is what produced the message;
 *   2. a 20,000-entry parser cap that TRUNCATED without saying so;
 *   3. a read path that loaded every row and normalised it in JS on every page;
 *   4. a five-minute poll that re-downloads the whole file, which at 38MB is
 *      11GB a day off the reader's own line.
 */

describe('the byte ceiling', () => {
  const cfg = readFileSync(
    new URL('../packages/config/src/index.js', import.meta.url).pathname,
    'utf8',
  );
  const src = readFileSync(
    new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
    'utf8',
  );

  /*
   * There is no ceiling by default, and the history is the argument for that.
   *
   * 8MB refused a real 38MB list; 100MB refused a real 583MB one, with the same
   * sentence. Every raise was a guess at how large a provider catalogue can get
   * and every guess was wrong within months, because the number was never about
   * what we can handle -- only about what we had happened to see.
   */
  test('is off by default, and is still a knob', () => {
    expect(cfg).toContain("num('PLAYLIST_MAX_BYTES', 0)");
  });

  /*
   * When an operator DOES set one: checked before the download from the header,
   * and then again DURING it.
   *
   * It used to be measured on the finished string, which meant a provider that
   * understated its content-length -- or sent none, which is common -- had
   * already been read into memory in full by the time the limit was consulted.
   * The ceiling is counted off the wire, so an oversized list is abandoned
   * mid-flight and the download is cancelled with it.
   */
  test('is checked from the header and again as the bytes arrive', () => {
    expect(src).toContain("res.headers.get('content-length')");
    // Counted inside the chunk callback, which is what makes it mid-flight.
    const cb = src.slice(src.indexOf('onChunk: (chunk)'));
    expect(cb.slice(0, cb.indexOf('},'))).toContain('bytes > cap');
  });

  /*
   * Both checks are conditional on a cap being set.
   *
   * `0` is what an unset PLAYLIST_MAX_BYTES parses to. Comparing against it
   * unguarded would refuse every list ever offered, with the message this whole
   * change exists to stop producing.
   */
  test('an unset cap accepts any size rather than refusing every size', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const guard of code.matchAll(/(?:len|bytes) > cap/g)) {
      const before = code.slice(Math.max(0, guard.index - 40), guard.index);
      expect(before, `unguarded ceiling check: ${guard[0]}`).toContain('cap > 0');
    }
    // And the guard is actually reached twice: header, then wire.
    expect([...code.matchAll(/cap > 0/g)]).toHaveLength(2);
  });
});

describe('the entry ceiling', () => {
  /*
   * The silent one. A reader importing 300,000 entries got 20,000 rows, no error,
   * and no way to tell which 280,000 were missing.
   */
  test('is high enough for a real VOD catalogue', () => {
    expect(MAX_CHANNELS).toBeGreaterThanOrEqual(300_000);
  });

  test('is per-call, so configuration decides rather than a constant', () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `#EXTINF:-1,Film ${i}\nhttp://x/movie/${i}.mp4`,
    ).join('\n');
    expect(parseM3u(many)).toHaveLength(50);
    expect(parseM3u(many, { max: 10 })).toHaveLength(10);
  });

  test('is also off by default, so a catalogue is stored whole', () => {
    const cfg = readFileSync(
      new URL('../packages/config/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    // 300,000 was the same silent-truncation bug one order of magnitude along: a
    // 583MB catalogue is ~2.6 million entries, and handing back 300,000 of them
    // is worse than refusing, because the reader cannot tell.
    expect(cfg).toContain("num('PLAYLIST_MAX_CHANNELS', 0)");
  });

  test('and hitting it is reported rather than swallowed', () => {
    const src = readFileSync(
      new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    // The parser reports it, rather than the caller inferring it from a length:
    // it is the half that knows it stopped accepting entries.
    expect(src).toContain('truncated = list.truncated');
    expect(src).toContain('truncated,');
  });
});

describe('polling a large list', () => {
  const src = readFileSync(
    new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
    'utf8',
  );

  /*
   * The provider supports no conditional request, so every poll pulls the whole
   * file. Five minutes on 38MB is 11GB a day from a datacenter IP against the
   * reader's own subscription, which is how a line gets flagged.
   */
  test('the interval scales with size and is floored at the configured minimum', () => {
    const fn = src.slice(src.indexOf('function nextRefreshAt'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('Math.max(floorMs, scaledMs)');
    expect(body).toContain('config.playlists.refreshBytesPerMinute');
  });

  test('and the size actually reaches it', () => {
    // Counted off the wire now rather than measured on a string, because there is
    // no longer a string: bytes is what the download actually cost anyway.
    expect(src).toContain('nextRefreshAt(bytes)');
    expect(src).not.toMatch(/nextRefreshAt\(\)/);
  });

  /*
   * The regression this whole change exists to prevent.
   *
   * `await res.text()` held a 300,000-entry catalogue as one string, hashed it
   * into a second copy and split it into an array of every line. Beside the HTTP
   * server that starved it: 513 connections banked up in the accept queue, the
   * edge answering "connection dial timeout", every five minutes after boot.
   */
  test('the body is never buffered whole', () => {
    // Comments stripped first: the ones above the fetch quote the old calls by
    // name, and a guard that its own explanation trips is worse than none.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('res.text()');
    // Straight from the wire to a file. It cannot go to the parser directly any
    // more: whether it is wanted at all is only knowable once it is all hashed.
    expect(code).toContain('spillToDisk(res.body');
    // The digest is fed chunk by chunk. A hash of most of a file would silently
    // break the unchanged-poll short circuit rather than fail.
    expect(code).toContain('hash.update(chunk)');
  });

  /*
   * Nor are the ENTRIES, which is the half the byte ceiling was really guarding.
   *
   * 583MB of provider catalogue is roughly 2.6 million entries; the array alone
   * is more heap than the container has. Raising the ceiling without this would
   * have turned a clear refusal into an out-of-memory kill.
   */
  test('the entries are never held whole either', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Handed over per chunk and forgotten, rather than mapped off a result array.
    expect(code).toContain('onEntries:');
    expect(code).not.toMatch(/list\.entries/);
    // And the consumer is awaited, which is what paces the parse to the inserts.
    expect(code).toContain('append(entries.map(toChannelRow))');
  });

  test('the spilled file is removed on every path out, including the throws', () => {
    expect(src).toContain('} finally {');
    expect(src).toContain('await spilled.discard()');
  });
});

describe('reading a large list back', () => {
  let db;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    const [u] = (
      await db.query("insert into users (email) values ('big@example.com') returning id")
    ).rows;
    const [p] = (
      await db.query(
        `insert into user_playlists (user_id, label, source_url) values ($1,'big','sealed')
         returning id`,
        [u.id],
      )
    ).rows;
    // A stand-in catalogue: one row that matters among a few thousand that do not.
    const rows = [];
    for (let i = 0; i < 3000; i++) rows.push([p.id, i, `Filler ${i}`, `filler ${i}`]);
    rows.push([p.id, 3000, '4K: Top Gun Maverick (2022)', 'top gun maverick']);
    for (const [pl, pos, title, norm] of rows) {
      await db.query(
        `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
         values ($1,$2,$3,'sealed',$4)`,
        [pl, pos, title, norm],
      );
    }
  }, 60_000);

  /** Mirrors playlistCandidates. */
  const candidates = async (terms) =>
    (
      await db.query(
        `select c.title from user_playlist_channels c
         join user_playlists p on p.id = c.playlist_id
         where c.norm_title like any($1::text[])
         order by c.position limit 3000`,
        [`{${terms.map((t) => `"%${t}%"`).join(',')}}`],
      )
    ).rows.map((r) => r.title);

  test('the database returns the few rows worth ranking, not the whole list', async () => {
    const found = await candidates(['maverick']);
    expect(found).toEqual(['4K: Top Gun Maverick (2022)']);
  });

  /*
   * The query and the ranker MUST agree on what a significant word is. A word the
   * ranker would match but the query never asked for is a channel the reader is
   * silently not offered -- which is why both go through matchTerms.
   */
  test('the terms come from the same function the ranker tokenises with', () => {
    const terms = matchTerms({ title: 'Top Gun: Maverick', genreName: 'Action' });
    expect(terms).toContain('maverick');
    expect(terms).toContain('action');
    const playlists = readFileSync(
      new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    expect(playlists).toContain('terms: matchTerms({ title, genreName, categoryName })');
  });

  /* The count is still owed to the page when nothing matched. */
  test('the total is counted separately rather than inferred from the matches', () => {
    const playlists = readFileSync(
      new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    expect(playlists).toContain('q.playlistChannelCount(userId)');
    expect(playlists).not.toContain('channelCount: rows.length');
  });
});
