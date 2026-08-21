import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const QUERIES = new URL('../packages/db/src/queries.js', import.meta.url).pathname;

/**
 * citext must reach the application as a string.
 *
 * citext is an EXTENSION type: its OID is assigned by the database when the
 * extension is installed, not fixed like a built-in. A driver can therefore only
 * decode it if it happens to recognise that OID, and when it does not the value
 * arrives as something that is not a string -- which renders as "[object Object]"
 * the moment a page prints it, and silently compares unequal to every string it is
 * checked against, which is the worse half.
 *
 * The fix is not to coerce at each render site, because there is no end to those
 * and each one is a chance to forget. It is to cast once, where the value leaves
 * the database.
 */
describe('citext never leaves the query layer as citext', () => {
  test('every query that selects a citext column casts it to text', async () => {
    const src = await readFile(QUERIES, 'utf8');

    /*
     * Strip the correct form first, then look for what is left.
     *
     * Scanning for a bare `email` directly flags the ALIAS in
     * `u.email::text as email`, which is the fix rather than the bug -- so the
     * cast is removed from the text before the search, and anything still
     * matching is a genuine uncast select.
     */
    const stripped = src
      .replace(/\b\w*\.?email::text as email\b/g, '')
      .replace(/\b\w*\.?handle::text as handle\b/g, '');

    const offenders = [];
    for (const m of stripped.matchAll(/\bselect\b[\s\S]{0,500}?`/g)) {
      const list = m[0];
      // Writes name the column too; only select lists matter here.
      if (list.includes('insert into') || list.includes('on conflict')) continue;
      if (/\b(?:u\.)?(?:email|handle)\b/.test(list)) {
        offenders.push(list.replace(/\s+/g, ' ').slice(0, 90));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the session user carries a string email and handle', async () => {
    const src = await readFile(QUERIES, 'utf8');
    const fn = src.slice(src.indexOf('export async function getSessionUser'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('u.email::text as email');
    expect(body).toContain('u.handle::text as handle');
  });

  test('the reason is written down where the next person will look', async () => {
    const src = await readFile(QUERIES, 'utf8');
    // A cast with no explanation gets "tidied up" by whoever sees it next.
    expect(src).toContain('citext columns are cast to text');
  });
});
