import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * "I'm still not finding Top Gun: Maverick on this page." -- after being told,
 * correctly, that it WAS on their list.
 *
 * Both were true, and that is the defect. The list holds two entries whose
 * normalised title is exactly `top gun maverick`. The provider answers 404 for
 * both (every extension, every path form -- confirmed against the live line,
 * while /series/ plays on the same credentials).
 *
 * The page then hid them. playlistCandidates dropped any row with a "dead"
 * verdict less than thirty minutes old, so a title the provider consistently
 * fails flickered on a thirty-minute cycle: shown, probed, 404, hidden for half
 * an hour, shown again. Whether the film was on the page depended on when you
 * looked, and the page never once said why.
 *
 * Hiding was the wrong lever. "Your list has this and your line will not serve
 * it" is an answer; vanishing is not, and it reads as the matcher being broken.
 */

const queries = readFileSync(
  new URL('../packages/db/src/queries.js', import.meta.url).pathname,
  'utf8',
);
const playlists = readFileSync(
  new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
  'utf8',
);
const pages = readFileSync(
  new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
  'utf8',
);

const fnBody = (src, name) => {
  const i = src.indexOf(`export async function ${name}`);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('\n}\n', i));
};

describe('a matched entry the provider refuses', () => {
  test('is no longer filtered out of the candidates', () => {
    const body = fnBody(queries, 'playlistCandidates');
    // The clause that caused the flicker. Its absence is the fix.
    expect(body).not.toContain('c.is_live is not false');
  });

  test('the verdict still travels, so the caller can act on it', () => {
    const body = fnBody(queries, 'playlistCandidates');
    expect(body).toContain('c.is_live');
    expect(body).toContain('c.checked_at');
  });

  test('and is separated out rather than offered', () => {
    expect(playlists).toContain('const unavailable = ');
    // Never unsealed: there is nothing to play, so no URL is handed out.
    const i = playlists.indexOf('const unavailable = ');
    const block = playlists.slice(i, i + 400);
    expect(block).not.toContain('open(');
  });

  test('every return shape carries the tier, including the empty ones', () => {
    // A view reading own.unavailable.length must never hit undefined.
    expect(playlists.match(/unavailable: \[\]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(playlists).toContain('    unavailable,');
  });
});

describe('what the page says about it', () => {
  test('it says the list has the title and the provider will not serve it', () => {
    expect(pages).toContain('On your list, but your provider will not serve it');
  });

  test('and points the finger in the right direction', () => {
    expect(pages).toContain("your provider's side, not a naming problem");
  });

  /*
   * The empty state must not fire when there ARE matches that happen to be
   * failing -- "none of your 300,000 entries look like they carry this" would be
   * a flat contradiction of the list printed directly beneath it.
   */
  test('the "nothing matched" wording is suppressed when something did', () => {
    expect(pages).toContain('own.onDemand?.length > 0 || own.unavailable?.length > 0 ? null : (');
  });

  test('a failing entry gets no play control', () => {
    const i = pages.indexOf('On your list, but your provider will not serve it');
    const block = pages.slice(i, pages.indexOf('</>', i));
    expect(block).not.toContain('ChannelRow');
    expect(block).not.toContain('data-player');
  });
});

describe('the trap this comment sits in', () => {
  /*
   * The comment explaining all of this lives INSIDE a tagged template literal.
   * A backtick in it ends the SQL mid-sentence, which is exactly what happened
   * and took the whole app out at build time.
   */
  test('no backtick in any SQL comment in this file', () => {
    /*
     * Targeted at the actual failure mode rather than at template syntax.
     * Parsing interpolations out is not worth it -- ${pgArray(xs.map(...))}
     * nests its own template and braces, and a naive strip mangles it. What
     * broke the build was a /* *\/ comment INSIDE the SQL mentioning a code
     * identifier in backticks, so that is what is checked.
     */
    const comments = [...queries.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
    const offenders = comments
      .filter((c) => /^\s{6,}\*/m.test(c) && c.includes('`'))
      .map((c) => c.slice(0, 70).replace(/\s+/g, ' '));
    expect(offenders).toEqual([]);
  });
});
