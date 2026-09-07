import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseM3uStream } from '../packages/catalog/src/m3u.js';
import { readSpill, spillToDisk } from '../packages/playlists/src/spill.js';

/**
 * Storing a list that does not fit in memory.
 *
 * Reported as "that list is 583MB, which is larger than we store". The ceiling
 * that produced it had been raised twice before -- 8MB, then 100MB -- and each
 * raise was wrong within months, because the number was never really about bytes.
 * The import held every parsed entry until it knew whether it wanted them, and
 * 583MB of provider catalogue is roughly 2.6 million entries: raising the ceiling
 * alone would have swapped a clear refusal for an out-of-memory kill.
 *
 * So the claim under test is not "big lists are allowed" but "nothing here scales
 * with the size of the list". These run a few thousand entries rather than a few
 * million, so what they measure is the SHAPE -- what is resident at once, and
 * whether it grows with the input -- which is the part that has to hold at 583MB.
 */

const entriesOf = (n, from = 0) =>
  Array.from(
    { length: n },
    (_, i) =>
      `#EXTINF:-1 group-title="VOD | Action",Film ${from + i}\nhttp://line.test/movie/u/p/${from + i}.mkv`,
  ).join('\n');

/** A body that arrives in pieces, the way a provider's does. */
async function* wire(text, size = 4096) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

describe('a list is streamed to disk rather than held', () => {
  test('the file holds the whole body and the hash covers all of it', async () => {
    const list = entriesOf(5000);
    const expected = new TextEncoder().encode(list).byteLength;
    let hashed = 0;
    const spilled = await spillToDisk(wire(list), {
      onChunk: (c) => {
        hashed += c.byteLength;
      },
    });
    try {
      expect((await stat(spilled.path)).size).toBe(expected);
      expect(hashed).toBe(expected);
    } finally {
      await spilled.discard();
    }
  });

  test('discard removes the file, so imports do not fill the disk', async () => {
    const spilled = await spillToDisk(wire(entriesOf(10)));
    expect(existsSync(spilled.path)).toBe(true);
    await spilled.discard();
    expect(existsSync(spilled.path)).toBe(false);
  });

  /*
   * A provider that understates content-length, or sends none at all, must be cut
   * off mid-flight rather than after we have taken the whole thing -- and must not
   * leave the partial download behind when it is.
   */
  test('a ceiling thrown mid-download abandons the download and the file', async () => {
    let seen = 0;
    await expect(
      spillToDisk(wire(entriesOf(20_000)), {
        onChunk: (c) => {
          seen += c.byteLength;
          if (seen > 50_000) throw new Error('that list is larger than we store');
        },
      }),
    ).rejects.toThrow('larger than we store');
    // Abandoned early rather than after the whole thing arrived.
    expect(seen).toBeLessThan(new TextEncoder().encode(entriesOf(20_000)).byteLength / 2);
  });
});

describe('the spilled file is parsed straight into the store', () => {
  /**
   * Parse a spilled list the way importPlaylist does, reporting what the pass
   * held at once rather than only what came out of it.
   */
  const load = async (list, { max = 0, batchSize = 500 } = {}) => {
    const spilled = await spillToDisk(wire(list));
    const stored = [];
    let pending = [];
    let peakHeld = 0;
    let overlapping = 0;
    let raced = false;
    try {
      const result = await parseM3uStream(readSpill(spilled.path), {
        max,
        onEntries: async (batch) => {
          if (overlapping > 0) raced = true;
          overlapping += 1;
          pending.push(...batch);
          peakHeld = Math.max(peakHeld, pending.length);
          while (pending.length >= batchSize) {
            // Stands in for the insert: awaited, which is what paces the parse.
            await Promise.resolve();
            stored.push(...pending.splice(0, batchSize));
          }
          overlapping -= 1;
        },
      });
      stored.push(...pending);
      pending = [];
      return { stored, peakHeld, raced, truncated: result.truncated, kept: result.kept };
    } finally {
      await spilled.discard();
    }
  };

  test('every entry of a list far larger than a batch is stored, in order', async () => {
    const { stored, kept, truncated } = await load(entriesOf(12_000));
    expect(stored).toHaveLength(12_000);
    expect(kept).toBe(12_000);
    expect(truncated).toBe(false);
    expect(stored[0].title).toBe('Film 0');
    // The last one lands on the flushed tail, after the final chunk was drained:
    // the entry a streaming parse is most likely to drop.
    expect(stored[11_999].title).toBe('Film 11999');
    expect(stored[6000].group).toBe('VOD | Action');
    expect(stored[6000].kind).toBe('vod');
  });

  /*
   * The actual claim. If what is resident grew with the list, 583MB would still
   * fail -- just later, and as an OOM rather than as a message.
   */
  test('what is held at once is a batch, and does not grow with the list', async () => {
    const small = await load(entriesOf(4000));
    const large = await load(entriesOf(16_000));
    expect(large.stored).toHaveLength(16_000);
    /*
     * Four times the input, the same working set. That is the assertion that
     * matters: the peak is set by how much the file read hands over at once --
     * a 64KB buffer, so a few hundred entries -- and by nothing about the size
     * of the list. A peak that tracked the input is what 583MB dies on.
     */
    expect(large.peakHeld).toBeLessThanOrEqual(small.peakHeld * 1.2 + 50);
    // And in absolute terms it stays a small multiple of a batch, not a catalogue.
    expect(large.peakHeld).toBeLessThan(large.stored.length / 8);
  });

  test('the consumer sets the pace, so the parse cannot run ahead of the writer', async () => {
    const { raced } = await load(entriesOf(8000));
    expect(raced).toBe(false);
  });

  test('an operator who does set an entry ceiling still gets one, and is told', async () => {
    const { stored, truncated } = await load(entriesOf(5000), { max: 1200 });
    expect(stored).toHaveLength(1200);
    expect(truncated).toBe(true);
  });

  test('no ceiling means no ceiling, not nothing stored', async () => {
    // 0 is what an unset PLAYLIST_MAX_CHANNELS parses to. Read literally it would
    // store an empty playlist and report success, which nothing would catch.
    const { stored, truncated } = await load(entriesOf(3000), { max: 0 });
    expect(stored).toHaveLength(3000);
    expect(truncated).toBe(false);
  });
});
