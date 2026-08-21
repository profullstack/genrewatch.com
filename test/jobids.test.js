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
  test('a backfill id is not derived from state the backfill itself resets', async () => {
    const src = await readFile(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );

    // The regression, twice over: an hour bucket collided with an earlier routine
    // sync, then a count-derived id collided with the previous backfill because the
    // counts reset to the same numbers. Both times BullMQ matched a completed job
    // and the work silently never ran while the queue reported success.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text
    expect(src).toContain('backfill-${minuteStamp()}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text
    expect(src).not.toContain('u${unnamed}-r${rosterless}');
  });

  test('the routine sweep keeps an hour bucket, which is genuinely periodic', async () => {
    const src = await readFile(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text
    expect(src).toContain('seed-all-${hourStamp()}');
  });
});
