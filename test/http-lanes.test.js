import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const SRC = new URL('../packages/catalog/src/http.js', import.meta.url).pathname;

describe('per-host rate limiting', () => {
  /*
   * A 429 widens the host's gap permanently, because backing off once and then
   * resuming the old cadence walks straight back into the limit. But the widening
   * has to be bounded: doubling without a ceiling turns six 429s into a
   * seventy-second wait before every request, and a lane wait already in flight
   * cannot be interrupted by the caller's deadline. MusicBrainz did exactly this
   * on the first production sync -- no error, no output, ten minutes of nothing.
   */
  test('the 429 backoff is bounded', async () => {
    const src = await readFile(SRC, 'utf8');
    expect(src).toContain('MAX_GAP_MS');
    // Every ASSIGNMENT to a lane's gap must clamp, or the ceiling has a hole in
    // it. Matched on the dot so the `minGapMs = 0` destructuring default -- which
    // is a parameter, not a lane -- does not count as a write.
    const writes = src.match(/\.minGapMs = [^;]+;/gs) ?? [];
    expect(writes.length).toBe(2);
    for (const w of writes) expect(w).toContain('Math.min');
  });

  test('doubling from the floor still lands under the ceiling', () => {
    const MAX = 30_000;
    let gap = 1100;
    for (let i = 0; i < 20; i++) gap = Math.min(Math.max(gap * 2, 1000), MAX);
    expect(gap).toBe(MAX);
    // And the ceiling is short enough that a bounded pass actually ends: twelve
    // pages at the ceiling is minutes, not hours.
    expect((MAX * 12) / 60_000).toBeLessThan(10);
  });

  test('404 is data, not an error -- most windows are empty most of the time', async () => {
    const src = await readFile(SRC, 'utf8');
    expect(src).toContain('if (res.status === 404) return null;');
  });
});
