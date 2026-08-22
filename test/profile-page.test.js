import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * The profile page.
 *
 * It publishes what somebody follows, which is more revealing than their name, so
 * the gates are the whole test. Two of them: a profile exists only for an account
 * that CHOSE a handle, and it is visible to others only while profile_public is on.
 * The first is why adding this page exposes nobody who was already here -- handle is
 * null until somebody types one.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, params) => (await db.query(sql, params)).rows;

describe('nobody gets a page they did not ask for', () => {
  test('a new account has no handle, so no profile exists for it', async () => {
    const [u] = await rows(
      `insert into users (email) values ('quiet@example.test') returning handle, profile_public`,
    );
    expect(u.handle).toBeNull();
    // profile_public defaults on, which is only safe BECAUSE handle does not.
    expect(u.profile_public).toBe(true);
  });

  test('the sitemap only carries handles, so a handle-less account is never listed', async () => {
    const listed = await rows(
      `select u.handle from users u
        where u.handle is not null and u.profile_public
          and (u.bio is not null or u.display_name is not null
               or exists (select 1 from follows f where f.user_id = u.id))`,
    );
    expect(listed).toEqual([]);
  });
});

describe('which profiles go to search engines', () => {
  /** The filter publicProfiles() applies, run against the real schema. */
  const listed = async () =>
    (
      await rows(
        `select u.handle::text as handle from users u
          where u.handle is not null and u.profile_public
            and (u.bio is not null or u.display_name is not null
                 or exists (select 1 from follows f where f.user_id = u.id))
          order by u.handle`,
      )
    ).map((r) => r.handle);

  test('a handle and nothing else is not submitted', async () => {
    // A page with no bio, no name and nothing followed is a thin page, and
    // submitting thousands of them teaches a crawler the site is mostly empty.
    await db.query(`insert into users (email, handle) values ('e@example.test', 'emptyperson')`);
    expect(await listed()).not.toContain('emptyperson');
  });

  test('a bio, a name, or something followed is enough', async () => {
    await db.query(`insert into users (email, handle, bio) values ('b@x.test','hasbio','hi')`);
    await db.query(
      `insert into users (email, handle, display_name) values ('n@x.test','hasname','N')`,
    );
    const [follower] = await rows(
      `insert into users (email, handle) values ('f@x.test','hasfollow') returning id`,
    );
    const [g] = await rows(
      `insert into genres (category, provider, provider_key, slug, name)
       values ('music','t','k1','k1','K') returning id`,
    );
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'genre',$2)`,
      [follower.id, g.id],
    );

    const l = await listed();
    expect(l).toContain('hasbio');
    expect(l).toContain('hasname');
    expect(l).toContain('hasfollow');
  });

  test('a private profile drops out with no cleanup', async () => {
    await db.query(`update users set profile_public = false where handle = 'hasbio'`);
    expect(await listed()).not.toContain('hasbio');
    await db.query(`update users set profile_public = true where handle = 'hasbio'`);
  });
});

describe('the page itself', () => {
  const load = () => import('../apps/web/src/views/pages.jsx');

  const render = async (props) => {
    const { ProfilePage } = await load();
    return (
      await ProfilePage({
        user: null,
        profile: { id: 'p1', handle: 'ann', display_name: 'Ann', profile_public: true },
        follows: [
          { subject_type: 'genre', subject_id: 1, slug: 'rock', label: 'Rock' },
          { subject_type: 'subject', subject_id: 2, slug: 'a-band', label: 'A Band' },
        ],
        upcoming: [],
        isOwner: false,
        ...props,
      }).toString()
    ).toString();
  };

  test('shows the follows, split by kind, linked to their pages', async () => {
    const html = await render();
    expect(html).toContain('/genres/rock');
    expect(html).toContain('/subjects/a-band');
    expect(html).toContain('Following (2)');
  });

  test('shows the schedule heading and an empty state naming the person', async () => {
    const html = await render();
    expect(html).toContain('Coming up');
    expect(html).toContain('Nothing coming up for what Ann follows');
  });

  test('never renders an email address', async () => {
    // The profile is built from chosen fields only. Nothing here should be able to
    // reach an address even if one is handed in by accident.
    const html = await render({
      profile: {
        id: 'p1',
        handle: 'ann',
        display_name: 'Ann',
        profile_public: true,
        email: 'private@example.test',
      },
    });
    expect(html).not.toContain('private@example.test');
  });

  test('the owner is told whether anyone else can see it', async () => {
    const publicOwner = await render({ isOwner: true });
    expect(publicOwner).toContain('as everyone else sees it');

    const privateOwner = await render({
      isOwner: true,
      profile: { id: 'p1', handle: 'ann', display_name: 'Ann', profile_public: false },
    });
    expect(privateOwner).toContain('Only you can see this');
  });

  test('a private profile is not offered to crawlers as canonical', async () => {
    const html = await render({
      isOwner: true,
      profile: { id: 'p1', handle: 'ann', display_name: 'Ann', profile_public: false },
    });
    expect(html).not.toContain('rel="canonical"');
  });
});

describe('the route gates', () => {
  const src = () => readFile(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');

  test('a private profile 404s rather than 403s', async () => {
    // 403 confirms the handle is taken, and a private profile that announces itself
    // is only half private.
    const s = await src();
    const route = s.slice(s.indexOf("app.get('/u/:handle'"));
    const body = route.slice(0, route.indexOf('\n});'));
    expect(body).toContain('!profile.profile_public && !isOwner');
    expect(body).toContain('404');
    expect(body).not.toContain('403');
  });

  test('the owner can still see their own private profile', async () => {
    const s = await src();
    const route = s.slice(s.indexOf("app.get('/u/:handle'"));
    expect(route.slice(0, 900)).toContain('viewer?.id === profile.id');
  });

  test('the profile page is not put in the Redis cache', async () => {
    // It differs for the owner; caching it would serve one reader's private page to
    // the next visitor.
    const s = await src();
    const route = s.slice(s.indexOf("app.get('/u/:handle'"));
    expect(route.slice(0, route.indexOf('\n});'))).not.toContain('cached(');
  });
});

describe('linking to a profile', () => {
  test('a comment author is linked only when the profile is public', async () => {
    const s = await readFile(
      new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(s).toContain('c.handle && c.profile_public');
    // The name still shows either way; only the link is conditional.
    expect(s).toContain('<span class="who">{commenterName(c)}</span>');
  });

  test('the header links a profile only once a handle exists', async () => {
    const s = await readFile(
      new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(s).toContain('props.user?.handle ?');
  });

  test('u, i and invite cannot be claimed as handles', async () => {
    const { handleAvailableShape } = await import('../packages/db/src/queries.js');
    for (const taken of ['u', 'i', 'invite', 'settings', 'genres']) {
      expect(handleAvailableShape(taken)).toBe(false);
    }
    expect(handleAvailableShape('anthony')).toBe(true);
  });
});
