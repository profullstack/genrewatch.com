import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const files = ['../packages/queue/src/index.js', '../packages/queue/src/workers.js'].map(
  (f) => new URL(f, import.meta.url).pathname,
);

/**
 * BullMQ reserves ':' in custom job ids for its own repeatable-job keys and throws
 * "Custom Id cannot contain :" unless the id splits into exactly three parts.
 *
 * This is a runtime-only failure with no type or lint signal, and it is silent until
 * the exact code path runs: a two-part id killed the container on boot, and a
 * four-part id in the fan-out would only have thrown once a real user followed a
 * team -- in production, at kickoff.
 */
describe('bullmq job ids', () => {
  test('no job id contains a colon', async () => {
    const offenders = [];
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      for (const m of src.matchAll(/jobId:\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
        if (m[1].includes(':')) offenders.push(`${f.split('/').pop()}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the ids that exist are still distinct per event, offset and page', async () => {
    const src = await readFile(files[1], 'utf8');
    // Guards against "fixing" the colon by dropping the interpolations that make
    // the id unique, which would silently collapse every page onto one job.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text
    expect(src).toContain('`fo-${e.id}-${offsetMinutes}`');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text
    expect(src).toContain('`bt-${eventId}-${offsetMinutes}-${after}`');
  });
});

describe('sync job ids', () => {
  test('the seed id is bucketed by minute, not by anything the work resets', async () => {
    const src = await readFile(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );

    /*
     * The regression, twice over in the sibling repo: an hour bucket collided with
     * an earlier routine sync, then a count-derived id collided with the previous
     * backfill because the counts reset to the same numbers. Both times BullMQ
     * matched a completed job and the work silently never ran while the queue
     * reported success.
     *
     * A minute bucket still collapses a boot storm across instances, which is all
     * the deduplication was ever for, and can never block a later pass.
     */
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text
    expect(src).toContain('seed-${minuteStamp()}');
    expect(src).not.toContain('hourStamp()');
  });

  test('minuteStamp cannot emit a colon', async () => {
    const src = await readFile(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    // toISOString() is full of colons and the id must not be; the replace is the
    // only thing standing between this and a runtime crash on every boot.
    const line = src.split('\n').find((l) => l.includes('const minuteStamp'));
    expect(line).toBeDefined();
    expect(line).toContain('replace(');

    // And prove it on the real function rather than only on its source text.
    const minuteStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    expect(minuteStamp()).not.toContain(':');
  });
});
