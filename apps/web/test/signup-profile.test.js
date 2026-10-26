import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createProfileStore, saveSignupProfile, validateProfile } from '@profullstack/profile';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { SignIn } = await import('../src/views/pages.jsx');
const html = async (node) => String(await node.toString());

/**
 * The shared @profullstack/profile fields on signup: asked for on the signup page
 * only, carried on the magic-link token (the account does not exist until the
 * link is spent), and saved into user_profiles on verify.
 *
 * Migrations run up to the one under test, then a person with a display name is
 * inserted so the backfill in 0020 has something to copy.
 */
let db;
let profiles;
let takeSql;
const PROFILE_MIGRATION = '0020_user_profiles.sql';

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../../../packages/db/migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files.filter((f) => f < PROFILE_MIGRATION)) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  await db.query(
    `insert into users (email, display_name) values ('grace@navy.mil', 'Grace Brewster Hopper'), ('solo@x.io', 'Cher')`,
  );
  for (const f of files.filter((f) => f >= PROFILE_MIGRATION)) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  // takeSignupProfile's SQL lifted from queries.js and run as written, so an edit
  // to the shipped query is what gets tested.
  const source = await readFile(
    new URL('../../../packages/db/src/queries.js', import.meta.url).pathname,
    'utf8',
  );
  const at = source.indexOf('export async function takeSignupProfile(');
  const open = source.indexOf('sql`', at);
  takeSql = source.slice(open + 4, source.indexOf('`;', open)).replace(/\$\{tokenHash\}/, '$1');
  // PGlite has a pg-style query(text, params) -> { rows }, which the package
  // adapts the same way it adapts a node-postgres client.
  profiles = createProfileStore(db);
}, 60_000);

describe('signup page', () => {
  test('signup asks for the profile fields, sign-in does not', async () => {
    const signup = await html(SignIn({ mode: 'signup' }));
    for (const name of ['first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url']) {
      expect(signup).toContain(`name="${name}"`);
    }
    expect(signup).toContain('name="mode" value="signup"');
    // One email box, the form's own.
    expect(signup.match(/name="email"/g)?.length).toBe(2); // magic link + password forms

    const login = await html(SignIn({ mode: 'login' }));
    expect(login).not.toContain('name="first_name"');
    expect(login).not.toContain('name="mode"');
  });

  test('a refused signup shows the error beside the field and keeps what was typed', async () => {
    const out = await html(
      SignIn({
        mode: 'signup',
        values: { email: 'ada@acme.com', first_name: 'Ada' },
        errors: { last_name: 'Last name is required.' },
      }),
    );
    expect(out).toContain('value="Ada"');
    expect(out).toContain('Last name is required.');
  });
});

describe('signup stores the fields', () => {
  test('validated on request, carried on the token, saved on verify', async () => {
    const form = {
      email: 'Ada@Acme.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      company_domain: 'https://www.acme.com/about',
      job_title: 'VP Engineering',
      linkedin_url: 'in/ada-lovelace',
      mode: 'signup',
      next: '/following',
    };
    const check = validateProfile(form);
    expect(check.ok).toBe(true);

    // What insertLoginToken / takeSignupProfile do, on the real schema.
    await db.query(
      `insert into login_tokens (token_hash, email, expires_at, profile)
       values ('\\x01', $1, now() + interval '20 minutes', $2::jsonb)`,
      [check.profile.email, JSON.stringify(check.profile)],
    );
    const [user] = (
      await db.query(`insert into users (email) values ($1) returning id, email`, [
        check.profile.email,
      ])
    ).rows;
    await db.query(`update login_tokens set consumed_at = now() where token_hash = '\\x01'`);
    const take = async () =>
      (await db.query(takeSql, [new Uint8Array([1])])).rows[0]?.profile ?? null;
    const carried = await take();
    // Handed out once: a second read finds nothing.
    expect(await take()).toBeNull();

    const saved = await saveSignupProfile(profiles, user.id, carried, { email: user.email });
    expect(saved.ok).toBe(true);
    expect(await profiles.get(user.id)).toMatchObject({
      email: 'ada@acme.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      company_domain: 'acme.com',
      job_title: 'VP Engineering',
      linkedin_url: 'https://www.linkedin.com/in/ada-lovelace',
    });
  });

  test('a signup without a last name is refused before any link exists', () => {
    const check = validateProfile({ email: 'x@y.com', first_name: 'X' });
    expect(check.ok).toBe(false);
    expect(Object.keys(check.errors)).toContain('last_name');
  });
});

describe('backfill from display_name', () => {
  test('first word to first_name, the rest to last_name', async () => {
    const { rows } = await db.query(
      `select p.first_name, p.last_name, p.email from user_profiles p join users u on u.id = p.user_id
       where u.email = 'grace@navy.mil'`,
    );
    expect(rows[0]).toEqual({
      first_name: 'Grace',
      last_name: 'Brewster Hopper',
      email: 'grace@navy.mil',
    });
  });

  test('a single name leaves last_name empty', async () => {
    const { rows } = await db.query(
      `select p.first_name, p.last_name from user_profiles p join users u on u.id = p.user_id
       where u.email = 'solo@x.io'`,
    );
    expect(rows[0]).toEqual({ first_name: 'Cher', last_name: null });
  });

  test('re-running never overwrites what is there', async () => {
    const dir = new URL('../../../packages/db/migrations/', import.meta.url).pathname;
    await db.query(
      `update user_profiles set first_name = 'Amazing' from users u
       where u.id = user_profiles.user_id and u.email = 'grace@navy.mil'`,
    );
    await db.exec(await readFile(dir + PROFILE_MIGRATION, 'utf8'));
    const { rows } = await db.query(
      `select p.first_name from user_profiles p join users u on u.id = p.user_id
       where u.email = 'grace@navy.mil'`,
    );
    expect(rows[0].first_name).toBe('Amazing');
  });
});
