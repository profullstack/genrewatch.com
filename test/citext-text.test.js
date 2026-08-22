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
      const stmt = m[0];
      // Writes name the column too; only select lists matter here.
      if (stmt.includes('insert into') || stmt.includes('on conflict')) continue;

      /*
       * Only the SELECT LIST, not the whole statement.
       *
       * The rule is about what leaves as citext, and a WHERE clause returns
       * nothing -- `where email = ${address}` is a comparison, which is precisely
       * what citext is for and must not be cast away. Scanning to the end of the
       * statement flagged those too, which would have pushed a correct query into
       * a wrong one to satisfy the test.
       */
      const from = stmt.search(/\bfrom\b/);
      const list = from === -1 ? stmt : stmt.slice(0, from);

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

describe('the detail enrichment window', () => {
  /*
   * `starts_at > now()` excluded anything released today. A dated release is
   * stored at the noon anchor, so by the afternoon it is in the past and its page
   * could never be enriched however many passes ran -- which is exactly the page
   * that gets opened, because it is the one that just came out.
   */
  test('reaches back, so something out today can still be enriched', async () => {
    const src = await readFile(QUERIES, 'utf8');
    const fn = src.slice(src.indexOf('export async function eventsNeedingDetail'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("now() - interval '7 days'");
    expect(body).not.toMatch(/starts_at > now\(\)\s*$/m);
  });
});

describe('SQL comments inside tagged templates', () => {
  /*
   * A backtick inside a SQL comment in a sql`` template does not raise a syntax
   * error. It ends the template early, and Bun then SEGFAULTS on the wreckage --
   * `bun test` dumps core with no file, no line and no message worth reading.
   *
   * It cost a confusing few minutes here, and the only reason it was diagnosed at
   * all is that it had happened before. A grep is cheaper than rediscovering it.
   */
  test('no backtick appears inside a SQL comment', async () => {
    const src = await readFile(QUERIES, 'utf8');

    /*
     * Only inside a sql`` region. A backtick in a JSDoc comment above a function
     * is ordinary prose and perfectly safe -- it is only fatal between the
     * backticks that open and close a tagged template, which is why this walks
     * the file rather than grepping it.
     */
    const offenders = [];
    let inSql = false;
    for (const raw of src.split('\n')) {
      const line = raw.trim();
      if (!inSql) {
        if (/\bsql`/.test(raw) && !/\bsql`.*`/.test(raw)) inSql = true;
        continue;
      }
      // A lone closing backtick ends the template.
      if (/^`;?\s*$/.test(line)) {
        inSql = false;
        continue;
      }
      if ((line.startsWith('--') || line.startsWith('*')) && line.includes('`')) {
        offenders.push(line.slice(0, 80));
      }
    }
    expect(offenders).toEqual([]);
  });
});
