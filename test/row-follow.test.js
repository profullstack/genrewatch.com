import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const PAGES = new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname;

/**
 * The follow control on a list row, and on a genre in the browse grid.
 *
 * It exists because of what the site looked like to somebody arriving for the
 * first time. The front page was a list of what lands today, every row named the
 * film or the show it was about, and there was no way to follow any of them: the
 * button lived on the name's own page, one click further in. /genres was a grid of
 * a few hundred followable genres with no button on any of them either. A reader
 * could scroll either page from top to bottom and find nothing to follow.
 */
const row = {
  id: 31312,
  category: 'film',
  kind: 'release',
  name: 'Margin Call',
  starts_at: '2026-09-25T00:00:00.000Z',
  time_known: false,
  precision: 'day',
  subject_id: 50839,
  subject_slug: 'margin-call-50839',
  subject_name: 'Margin Call',
  genre_name: 'Thriller',
  genre_slug: 'thriller-film',
  following: false,
};

const landing = async (props) => {
  const { Landing } = await import('../apps/web/src/views/pages.jsx');
  return String(await Landing(props).toString());
};

const firstRow = (html) => html.match(/<li class="event[\s\S]*?<\/li>/)?.[0] ?? '';

describe('following a name from the row it is on', () => {
  test('a signed-out reader gets a sign-in link that returns to the page', async () => {
    const out = firstRow(await landing({ user: null, today: [row] }));
    expect(out).toContain('class="row-follow"');
    // Named, not a bare "Follow": a mixed list puts a different name on every row,
    // and a column of identical buttons says nothing about what each one follows.
    expect(out).toContain('☆ Follow Margin Call');
    expect(out).toContain('href="/login?next=%2F"');
  });

  test('a signed-in reader who follows it can unfollow from the row', async () => {
    const out = firstRow(
      await landing({ user: { id: 'u1' }, today: [{ ...row, following: true }] }),
    );
    expect(out).toContain('action="/api/unfollow"');
    expect(out).toContain('name="subject_type" value="subject"');
    expect(out).toContain('name="subject_id" value="50839"');
    expect(out).toContain('★ Following Margin Call');
  });

  /*
   * The column this rests on. `following` was already the answer to exactly the
   * right question -- it is set when the viewer follows THIS ROW'S subject -- but
   * the id the form has to post stopped at the query, so every list on the site was
   * read-only for one missing column.
   */
  test('a row with no subject id carries no button rather than a broken form', async () => {
    const out = firstRow(await landing({ user: null, today: [{ ...row, subject_id: null }] }));
    expect(out).not.toContain('row-follow');
  });

  test('the id travels on every event list, from one place', async () => {
    const queries = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const at = queries.indexOf('const EVENT_COLUMNS = sql`');
    expect(at).toBeGreaterThan(-1);
    expect(queries.slice(at, queries.indexOf('`;', at))).toContain('e.subject_id');
  });

  /*
   * Where it is turned on, asserted against the source rather than by rendering
   * every page.
   *
   * The rule is about the LIST: a per-row button earns its place where consecutive
   * rows are about different NAMES, and is the page header repeated a dozen times
   * where they are not. A genre page counts as mixed even though every row shares
   * the genre, because the button follows the name and the names differ. A name's
   * own page does not, and must not grow one by somebody threading the prop through
   * for consistency.
   */
  test('only the lists whose rows differ opt in', async () => {
    const src = await readFile(PAGES, 'utf8');
    const bodyOf = (name) => {
      const start = src.indexOf(`export const ${name} = `);
      if (start < 0) throw new Error(`no such page: ${name}`);
      const next = src.indexOf('\nexport const ', start + 10);
      return src.slice(start, next > 0 ? next : undefined);
    };

    for (const name of ['Landing', 'GenresIndex', 'CategoryPage', 'GenrePage']) {
      expect({ page: name, optsIn: /\n\s+showFollow\b/.test(bodyOf(name)) }).toEqual({
        page: name,
        optsIn: true,
      });
    }
    for (const name of ['SubjectPage', 'Following', 'ProfilePage']) {
      expect({ page: name, optsIn: /\n\s+showFollow\b/.test(bodyOf(name)) }).toEqual({
        page: name,
        optsIn: false,
      });
    }
  });
});

describe('following a genre from the browse grid', () => {
  test('both grids render the shared row, so neither can drift', async () => {
    const src = await readFile(PAGES, 'utf8');
    // The markup was written out twice and both copies lacked a button. One
    // component now, used by /genres and by a category.
    expect(src).not.toContain("<li class={g.upcoming > 0 ? 'genre' : 'genre quiet'}>");
    expect((src.match(/<GenreRow /g) ?? []).length).toBe(2);
  });

  test('the grid knows which genres the reader already follows', async () => {
    const queries = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const at = queries.indexOf('export async function listGenres(');
    const body = queries.slice(at, queries.indexOf('\n}', at));
    expect(body).toContain('viewerId');
    expect(body).toContain("f.subject_type = 'genre'");
    // Selecting a joined column means it has to be grouped, or the count above it
    // collapses the row.
    expect(body).toContain('group by g.id, f.user_id');

    // And the routes that draw a grid have to pass the viewer, or every button on
    // it reads "Follow" for something already followed.
    const app = await readFile(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
    expect(app).toContain('q.listGenres({ viewerId: user?.id ?? null })');
    expect(app).toContain('q.listGenres({ category: name, viewerId: user?.id ?? null })');
  });
});
