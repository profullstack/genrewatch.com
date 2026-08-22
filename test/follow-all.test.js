import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * The two bulk follow controls, and the line between them.
 *
 * "Follow everything" on /genres takes every active genre, and its undo spares the
 * individual names, because those were chosen one at a time and the opposite of
 * "follow every genre" is "stop following every genre". "Unfollow all" on the
 * calendar page is the opposite by design -- it is pressed while looking at the
 * list it empties, so it takes the names too. Both are correct, and each becomes a
 * bug the moment it acquires the other's behaviour.
 */
let db;
let user;
let other;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const mkUser = async (email) =>
    (await db.query(`insert into users (email) values ($1) returning id`, [email])).rows[0].id;
  user = await mkUser('a@example.test');
  other = await mkUser('b@example.test');

  for (const [key, active] of [
    ['music/rock', true],
    ['music/jazz', true],
    ['film/drama', true],
    ['dead/genre', false],
  ]) {
    await db.query(
      `insert into genres (category, provider, provider_key, slug, name, active)
       values (split_part($1,'/',1), 'test', $1, $1, $1, $2)`,
      [key, active],
    );
  }
  // Two names, followed deliberately one at a time. They must survive the genre
  // clear and go with the whole-list clear.
  for (const slug of ['a-band', 'b-band']) {
    await db.query(
      `insert into subjects (category, kind, provider, provider_key, slug, name, display_name)
       values ('music', 'artist', 'test', $1, $1, $1, $1)`,
      [slug],
    );
  }
  await db.query(
    `insert into follows (user_id, subject_type, subject_id)
     select $1, 'subject', s.id from subjects s`,
    [user],
  );
  // Somebody else, whose follows must never be touched by either control.
  await db.query(
    `insert into follows (user_id, subject_type, subject_id)
     select $1, 'genre', g.id from genres g where g.active limit 1`,
    [other],
  );
}, 60_000);

/** The statements behind q.followAllGenres / unfollowAllGenres / unfollowAll. */
const followAllGenres = async (who) =>
  (
    await db.query(
      `insert into follows (user_id, subject_type, subject_id)
       select $1, 'genre', g.id from genres g where g.active
       on conflict do nothing
       returning subject_id`,
      [who],
    )
  ).rows.length;

const unfollowAllGenres = async (who) =>
  (
    await db.query(
      `delete from follows where user_id = $1 and subject_type = 'genre' returning subject_id`,
      [who],
    )
  ).rows.length;

const unfollowAll = async (who) => {
  const { rows } = await db.query(`delete from follows where user_id = $1 returning subject_type`, [
    who,
  ]);
  return {
    removed: rows.length,
    genres: rows.filter((r) => r.subject_type === 'genre').length,
    subjects: rows.filter((r) => r.subject_type === 'subject').length,
  };
};

const countOf = async (who, type) =>
  (
    await db.query(
      `select count(*)::int as n from follows where user_id = $1 and subject_type = $2`,
      [who, type],
    )
  ).rows[0].n;

describe('following every genre', () => {
  test('takes every active genre, and only the active ones', async () => {
    expect(await followAllGenres(user)).toBe(3);
    expect(await countOf(user, 'genre')).toBe(3);
  });

  test('a second press adds nothing rather than double-counting', async () => {
    expect(await followAllGenres(user)).toBe(0);
    expect(await countOf(user, 'genre')).toBe(3);
  });

  test('the genre clear leaves the names alone', async () => {
    expect(await unfollowAllGenres(user)).toBe(3);
    expect(await countOf(user, 'genre')).toBe(0);
    // The whole point of the distinction.
    expect(await countOf(user, 'subject')).toBe(2);
  });
});

describe('unfollowing everything', () => {
  test('clears names as well as genres, and reports the breakdown', async () => {
    await followAllGenres(user);
    expect(await unfollowAll(user)).toEqual({ removed: 5, genres: 3, subjects: 2 });
    expect(await countOf(user, 'genre')).toBe(0);
    expect(await countOf(user, 'subject')).toBe(0);
  });

  test('a second press removes nothing rather than failing', async () => {
    expect(await unfollowAll(user)).toEqual({ removed: 0, genres: 0, subjects: 0 });
  });

  test('leaves every other account alone', async () => {
    expect(await countOf(other, 'genre')).toBe(1);
  });
});

describe('the two clears stay different', () => {
  /**
   * The regression that would be invisible in the UI: if unfollowAll were ever
   * written as the genres-only delete, the calendar page would clear the genres,
   * leave every name chip on the page, and look like a half-working button.
   */
  test('unfollowAll is not scoped to genres, and unfollowAllGenres still is', async () => {
    const src = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const body = (name) => src.slice(src.indexOf(`export async function ${name}(`)).split('\n}')[0];

    expect(body('unfollowAll')).not.toContain("subject_type = 'genre'");
    expect(body('unfollowAllGenres')).toContain("subject_type = 'genre'");
    // Both must stay scoped to one account.
    expect(body('unfollowAll')).toMatch(/user_id = \$\{userId\}/);
    expect(body('unfollowAllGenres')).toMatch(/user_id = \$\{userId\}/);
  });
});

describe('the controls on the page', () => {
  const load = () => import('../apps/web/src/views/pages.jsx');

  test('the genre index states the size before the press', async () => {
    const { GenresIndex } = await load();
    const html = (
      await GenresIndex({
        user: { id: 'u' },
        categories: ['music'],
        genres: [{ category: 'music', slug: 'rock', name: 'Rock', upcoming: 3 }],
        genreCounts: { total: 120, following: 4 },
        upcoming: 3800,
      }).toString()
    ).toString();

    expect(html).toContain('Follow everything!');
    // A button that quietly enrols someone in thousands of notifications is a
    // trap; the size has to be on the page beside it.
    expect(html).toContain('releases in the next fortnight');
    expect(html).toContain('/api/unfollow-all');
    expect(html).toContain('You follow 4 so far');
  });

  test('the calendar page offers the whole-list clear, names what goes, and asks first', async () => {
    const { Following } = await load();
    const html = (
      await Following({
        user: { id: 'u' },
        events: [],
        follows: [
          { subject_type: 'subject', subject_id: 1, slug: 'a-band', label: 'A Band' },
          { subject_type: 'subject', subject_id: 2, slug: 'b-band', label: 'B Band' },
          { subject_type: 'genre', subject_id: 3, slug: 'rock', label: 'Rock' },
        ],
        cleared: null,
        calendarUrl: 'https://genrewatch.com/calendar/me/tok.ics',
      }).toString()
    ).toString();

    expect(html).toContain('/api/unfollow-everything');
    expect(html).toContain('Unfollow all');
    // The breakdown is the point: /genres spares the names, so "all" here has to
    // say out loud that these ones do not survive.
    expect(html).toContain('2 names and 1 genre');
    expect(html).toContain('data-confirm');
  });

  test('nothing followed means nothing to clear', async () => {
    const { Following } = await load();
    const html = (
      await Following({ user: { id: 'u' }, events: [], follows: [], cleared: null }).toString()
    ).toString();
    expect(html).not.toContain('/api/unfollow-everything');
  });

  test('the receipt says what was removed, not just that something was', async () => {
    const { Following } = await load();
    const html = (
      await Following({
        user: { id: 'u' },
        events: [],
        follows: [],
        cleared: { removed: 5, subjects: 2, genres: 3 },
      }).toString()
    ).toString();
    expect(html).toContain('Unfollowed 5');
    expect(html).toContain('2 names and 3 genres');
  });
});
