import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * The genre tag on an event row.
 *
 * A list on this site mixes five categories and a few hundred genres, so "is this
 * a horror film or a documentary" is the first question a row has to answer -- and
 * it was not answered on the row at all.
 */

const components = readFileSync(
  new URL('../apps/web/src/views/components.jsx', import.meta.url).pathname,
  'utf8',
);
const pages = readFileSync(
  new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
  'utf8',
);
const queries = readFileSync(
  new URL('../packages/db/src/queries.js', import.meta.url).pathname,
  'utf8',
);

describe('what the tag says', () => {
  test('the genre where a row has one', () => {
    expect(components).toContain('event.genre_name ??');
  });

  /*
   * An event with no genre edges yet -- a freshly ingested title, a launch --
   * still belongs to something, and a blank where every neighbouring row has a tag
   * reads as missing data rather than as an absence of genre.
   */
  test('and the category where it does not', () => {
    expect(components).toContain('CATEGORY_NAME[event.category]');
  });

  test('it links only where the slug came back with the row', () => {
    expect(components).toContain('event.genre_slug ?');
  });
});

describe('where the genre comes from', () => {
  test('every list query gets it, because they share one column list', () => {
    // EVENT_COLUMNS is the fragment every event list selects. Adding the tag there
    // rather than per query is what stops one list rendering a bare row.
    const cols = queries.slice(queries.indexOf('const EVENT_COLUMNS'));
    const body = cols.slice(0, cols.indexOf('`;'));
    expect(body).toContain('as genre_name');
    expect(body).toContain('as genre_slug');
  });

  /*
   * A join would multiply every event row by its genre count -- a thing belongs to
   * five genres at once, which is the whole reason event_genres exists -- and
   * every caller would then need a distinct it does not currently have.
   */
  test('as a subquery rather than a join, so no row is duplicated', () => {
    const cols = queries.slice(queries.indexOf('const EVENT_COLUMNS'));
    const body = cols.slice(0, cols.indexOf('`;'));
    expect(body).toContain('(select g.name from event_genres');
    expect(body).not.toMatch(/join event_genres[\s\S]*as genre_name/);
  });

  test('the pick is deterministic rather than whatever sorts first', () => {
    const cols = queries.slice(queries.indexOf('const EVENT_COLUMNS'));
    expect(cols.slice(0, cols.indexOf('`;'))).toContain('order by g.priority, g.name limit 1');
  });
});

describe('the two category-name lists agree', () => {
  /*
   * components.jsx cannot import CATEGORY_LABEL from pages.jsx -- that module
   * imports this one, and reaching back would be a cycle -- so the five words are
   * written twice. This is what keeps them the same.
   */
  test('every category in the page labels is in the tag fallback', () => {
    const labels = [...pages.matchAll(/^ {2}(tv|film|anime|music|space): \{ name: '([^']+)'/gm)];
    expect(labels.length).toBe(5);
    for (const [, slug, name] of labels) {
      expect(components).toContain(`${slug}: '${name}'`);
    }
  });
});
