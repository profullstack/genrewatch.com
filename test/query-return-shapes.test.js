import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A query that projects a row must hand back the row.
 *
 * This exists because of a specific self-inflicted outage. Fixing the magic-link
 * bug meant changing ONE function from `return row ?? null` to
 * `return row?.email ?? null`. Verifying that the new test failed without the fix
 * was done with `sed`, and the sed to put it back matched every occurrence in the
 * file: sixteen unrelated functions were rewritten to return an email column that
 * most of their tables do not even have.
 *
 * getSubjectBySlug then returned null for every title in a 318,280-row catalogue,
 * so every film and show 404'd -- reported as "I'm getting 404 on movies like Top
 * Gun: Maverick". getGenreBySlug, getEvent, getPlaylist and getSessionUser went
 * the same way. The full suite stayed green through all of it.
 *
 * So the check is structural, on the source, because that is the shape the
 * mistake had: a mechanical edit that is individually plausible everywhere it
 * landed and wrong in all but one place.
 */

const src = readFileSync(
  new URL('../packages/db/src/queries.js', import.meta.url).pathname,
  'utf8',
);

/** Every `export async function name(` in the file, with its body. */
function fns() {
  const out = new Map();
  const re = /export async function (\w+)\(/g;
  for (const m of src.matchAll(re)) {
    const start = m.index;
    const next = src.indexOf('\nexport ', start + 1);
    out.set(m[1], src.slice(start, next === -1 ? src.length : next));
  }
  return out;
}

describe('returning a column instead of a row', () => {
  test('exactly one query returns an email, and it is the sign-in link', () => {
    const offenders = [...fns()]
      .filter(([, body]) => body.includes('return row?.email ?? null'))
      .map(([name]) => name);
    expect(offenders).toEqual(['consumeLoginToken']);
  });

  /*
   * Named individually rather than derived, because these are the ones whose
   * breakage is invisible: they return null, the caller renders a 404 or a
   * signed-out page, and nothing throws.
   */
  test('the lookups a page depends on hand back the whole row', () => {
    const all = fns();
    for (const name of [
      'getSubjectBySlug',
      'getGenreBySlug',
      'getEvent',
      'getPlaylist',
      'getSessionUser',
      'getUserByHandle',
      'getUserForPassword',
      'getUserByInviteCode',
      'userByCalendarToken',
      'sharedChannelById',
      'ownChannelById',
    ]) {
      const body = all.get(name);
      expect(body, `${name} is missing`).toBeDefined();
      expect(body, `${name} returns a column, not the row`).not.toContain('return row?.email');
    }
  });

  /*
   * The general form of the same mistake: a function whose SELECT does not name
   * `email` cannot legitimately return `row.email`. Catches the next mechanical
   * edit even if it picks a different set of functions than this one did.
   */
  test('no query returns a column its own select never asked for', () => {
    const bad = [];
    for (const [name, body] of fns()) {
      const m = body.match(/return row\?\.(\w+)/);
      if (!m) continue;
      const column = m[1];
      /*
       * Only the SQL counts. Searching the whole function body finds the word in
       * the `return row?.email` line itself, which made this pass against the
       * very regression it was written for -- and `select *` is not evidence
       * either: subjects has no email column and `select *` from it happily
       * matched nothing at all.
       */
      // Every tagged template in the body, not just ones tagged `sql`: a query
      // that runs inside a caller's transaction is tagged `tx`, and anchoring on
      // `sql` flagged the correct eventStartsAt as a violation.
      const sqlText = [...body.matchAll(/`([\s\S]*?)`/g)].map((x) => x[1]).join('\n');
      const named = new RegExp(`\\b${column}\\b`).test(sqlText);
      if (!named) bad.push(`${name} -> ${column}`);
    }
    expect(bad).toEqual([]);
  });
});
