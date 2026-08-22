import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
process.env.SITE_URL = 'https://genrewatch.com';

/**
 * Inviting people.
 *
 * The link half needs no defending -- the inviter sends it themselves. Everything
 * here is about the other half, which puts our domain on the envelope of mail a
 * stranger never asked for, and about not turning either half into a way to find out
 * who has an account.
 */

/* ------------------------------------------------------------ the schema -- */

let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const mkUser = async (email) =>
  (await db.query(`insert into users (email) values ($1) returning id`, [email])).rows[0].id;

describe('the schema keeps the rules', () => {
  test('an account can only be invited once, by one person', async () => {
    const a = await mkUser('inviter-a@example.test');
    const b = await mkUser('inviter-b@example.test');
    const joined = await mkUser('joined@example.test');

    await db.query(`insert into invite_claims (invited_user_id, inviter_id) values ($1,$2)`, [
      joined,
      a,
    ]);
    // Second claim on the same person loses rather than erroring the sign-in path.
    const again = await db.query(
      `insert into invite_claims (invited_user_id, inviter_id) values ($1,$2)
       on conflict do nothing returning invited_user_id`,
      [joined, b],
    );
    expect(again.rows).toHaveLength(0);

    const { rows } = await db.query(
      `select inviter_id from invite_claims where invited_user_id = $1`,
      [joined],
    );
    expect(rows[0].inviter_id).toBe(a);
  });

  test('inviting yourself is refused by the database, not just by the code', async () => {
    const me = await mkUser('self@example.test');
    await expect(
      db.query(`insert into invite_claims (invited_user_id, inviter_id) values ($1,$1)`, [me]),
    ).rejects.toThrow();
  });

  test('an invite code is unique across accounts', async () => {
    const a = await mkUser('code-a@example.test');
    const b = await mkUser('code-b@example.test');
    await db.query(`update users set invite_code = 'samecode' where id = $1`, [a]);
    await expect(
      db.query(`update users set invite_code = 'samecode' where id = $1`, [b]),
    ).rejects.toThrow();
  });

  test('a new account has no invite code until it asks for one', async () => {
    const u = await mkUser('fresh-code@example.test');
    const { rows } = await db.query(`select invite_code from users where id = $1`, [u]);
    expect(rows[0].invite_code).toBeNull();
  });

  /**
   * The upsert has to say whether it inserted, or the invite flow cannot tell a new
   * account from somebody who already had one and clicked a friend's link.
   */
  test('findOrCreateUser can tell an insert from an update', async () => {
    const once = await db.query(
      `insert into users (email) values ('xmax@example.test')
       on conflict (email) do update set last_seen_at = now()
       returning (xmax = 0) as created`,
    );
    expect(once.rows[0].created).toBe(true);

    const twice = await db.query(
      `insert into users (email) values ('xmax@example.test')
       on conflict (email) do update set last_seen_at = now()
       returning (xmax = 0) as created`,
    );
    expect(twice.rows[0].created).toBe(false);
  });
});

/* ----------------------------------------------------------- the sending -- */

const state = {
  sent: [],
  sentSince: 0,
  invitedRecently: new Set(),
  codes: new Map(),
};

/**
 * Passed in rather than mocked at the module level.
 *
 * bun's mock.module replaces a specifier for the WHOLE test process, so a second
 * file mocking '@genre/db/queries' silently replaces this one's version and both
 * sets of tests start failing in ways that only appear in a full run. The functions
 * under test take their database as an argument precisely so this file does not have
 * to reach for that hammer.
 */
const queries = {
  ensureInviteCode: async ({ userId, code }) => {
    if (!state.codes.has(userId)) state.codes.set(userId, code);
    return state.codes.get(userId);
  },
  getUserByInviteCode: async (code) => {
    for (const [userId, c] of state.codes) if (c === code) return { id: userId };
    return null;
  },
  recordInviteClaim: async ({ inviterId, invitedUserId }) =>
    Boolean(inviterId && invitedUserId && inviterId !== invitedUserId),
  invitesSentSince: async () => state.sentSince,
  invitedRecently: async ({ email }) => state.invitedRecently.has(email),
  recordInviteSend: async ({ email }) => state.sent.push(email),
};

const invites = await import('../packages/auth/src/invites.js');

const me = { id: 'u1', email: 'me@example.test', display_name: 'Ann' };
const send = async (args) => state.sent.push(args) && true;

beforeEach(() => {
  state.sent = [];
  state.sentSince = 0;
  state.invitedRecently = new Set();
  state.codes = new Map();
});

describe('reading a list of addresses', () => {
  test('splits on commas, spaces and newlines', () => {
    expect(invites.parseAddresses('a@x.test, b@x.test\nc@x.test')).toEqual([
      'a@x.test',
      'b@x.test',
      'c@x.test',
    ]);
  });

  test('deduplicates and lowercases, so a pasted list is not charged twice', () => {
    expect(invites.parseAddresses('A@x.test, a@x.test')).toEqual(['a@x.test']);
  });

  test('drops anything that is not an address', () => {
    expect(invites.parseAddresses('not-an-email, ok@x.test, @@')).toEqual(['ok@x.test']);
  });
});

describe('the daily cap', () => {
  test('refuses once the day is spent, and points at the link instead', async () => {
    state.sentSince = invites.DAILY_SEND_LIMIT;
    const r = await invites.sendInvites({ user: me, raw: 'a@x.test', send, db: queries });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Share your link');
    expect(state.sent).toHaveLength(0);
  });

  test('sends only up to what is left, counting the rest as skipped', async () => {
    state.sentSince = invites.DAILY_SEND_LIMIT - 1;
    const r = await invites.sendInvites({
      user: me,
      raw: 'a@x.test b@x.test c@x.test',
      send,
      db: queries,
    });
    expect(r.ok).toBe(true);
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(2);
  });

  test('one submission cannot carry an unbounded list', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `p${i}@x.test`).join(',');
    const r = await invites.sendInvites({ user: me, raw: many, send, db: queries });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(String(invites.MAX_PER_SUBMISSION));
    expect(state.sent).toHaveLength(0);
  });

  test('an empty or unusable field is refused rather than silently doing nothing', async () => {
    expect((await invites.sendInvites({ user: me, raw: '   ', send, db: queries })).ok).toBe(false);
    expect((await invites.sendInvites({ user: me, raw: 'nonsense', send, db: queries })).ok).toBe(
      false,
    );
  });
});

describe('not badgering the person on the other end', () => {
  test('an address somebody already invited is skipped', async () => {
    state.invitedRecently = new Set(['known@x.test']);
    const r = await invites.sendInvites({
      user: me,
      raw: 'known@x.test, new@x.test',
      send,
      db: queries,
    });
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(1);
    expect(state.sent.map((s) => s.email)).toEqual(['new@x.test']);
  });

  test('you cannot invite yourself', async () => {
    const r = await invites.sendInvites({ user: me, raw: 'me@example.test', send, db: queries });
    expect(r.sent).toBe(0);
    expect(state.sent).toHaveLength(0);
  });

  test('a send that throws does not abandon the rest of the list', async () => {
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1) throw new Error('resend 500');
      return true;
    };
    const r = await invites.sendInvites({
      user: me,
      raw: 'a@x.test, b@x.test',
      send: flaky,
      db: queries,
    });
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe('what the sender is told', () => {
  test('the result is counts, never per-address outcomes', async () => {
    // Naming which address was skipped would say who already has an account here,
    // which is exactly what the sign-in page refuses to answer.
    state.invitedRecently = new Set(['known@x.test']);
    const r = await invites.sendInvites({
      user: me,
      raw: 'known@x.test, new@x.test',
      send,
      db: queries,
    });
    expect(Object.keys(r).sort()).toEqual(['ok', 'sent', 'skipped']);
    expect(JSON.stringify(r)).not.toContain('known@x.test');
  });
});

describe('what the invitee is told', () => {
  test('a chosen name, never the inviter’s email address', () => {
    expect(invites.inviterName({ display_name: 'Ann', email: 'me@example.test' })).toBe('Ann');
    expect(invites.inviterName({ handle: 'ann', email: 'me@example.test' })).toBe('@ann');
    // The important one: with nothing chosen, it must not fall back to the address.
    expect(invites.inviterName({ email: 'me@example.test' })).toBe('Someone');
  });

  test('the email says how they got it and that nothing was created for them', async () => {
    const src = await readFile(
      new URL('../packages/notify/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    const body = src.slice(src.indexOf('export async function sendInviteEmail'));
    expect(body).toContain('somebody typed your address into an invite form');
    expect(body).toContain('will not email you again');
    // The envelope stays ours; the inviter's address is never put in it.
    expect(body).toContain('from: config.mail.from');
  });
});

describe('claiming', () => {
  test('credits the inviter for a genuinely new account', async () => {
    state.codes = new Map([['inviter', 'CODE123']]);
    expect(
      await invites.claimInvite({
        code: 'CODE123',
        user: { id: 'newbie' },
        created: true,
        db: queries,
      }),
    ).toBe(true);
  });

  test('does not credit somebody who already had an account', async () => {
    state.codes = new Map([['inviter', 'CODE123']]);
    expect(
      await invites.claimInvite({
        code: 'CODE123',
        user: { id: 'oldie' },
        created: false,
        db: queries,
      }),
    ).toBe(false);
  });

  test('an unknown or missing code is ignored rather than breaking the sign-in', async () => {
    expect(
      await invites.claimInvite({
        code: 'NOPE',
        user: { id: 'newbie' },
        created: true,
        db: queries,
      }),
    ).toBe(false);
    expect(
      await invites.claimInvite({ code: null, user: { id: 'newbie' }, created: true, db: queries }),
    ).toBe(false);
  });

  test('you cannot claim your own code', async () => {
    state.codes = new Map([['self', 'MINE']]);
    expect(
      await invites.claimInvite({ code: 'MINE', user: { id: 'self' }, created: true, db: queries }),
    ).toBe(false);
  });
});

describe('the page', () => {
  const load = () => import('../apps/web/src/views/pages.jsx');

  test('shows the link, the limit, and who joined', async () => {
    const { Invite } = await load();
    const html = (
      await Invite({
        user: { id: 'u' },
        url: 'https://genrewatch.com/i/abc',
        accepted: [{ claimed_at: new Date().toISOString(), display_name: 'Bo' }],
        remaining: 7,
        dailyLimit: 10,
        maxPerSubmission: 5,
      }).toString()
    ).toString();

    expect(html).toContain('https://genrewatch.com/i/abc');
    expect(html).toContain('7 left today');
    expect(html).toContain('Bo');
    expect(html).toContain('/api/invite/email');
  });

  test('an accepted invite with no chosen name is not reported by email', async () => {
    const { Invite } = await load();
    const html = (
      await Invite({
        user: { id: 'u' },
        url: 'https://genrewatch.com/i/abc',
        accepted: [{ claimed_at: new Date().toISOString(), email: 'private@example.test' }],
        remaining: 5,
        dailyLimit: 10,
        maxPerSubmission: 5,
      }).toString()
    ).toString();

    expect(html).toContain('Someone new');
    expect(html).not.toContain('private@example.test');
  });

  test('the send button is disabled once the day is spent', async () => {
    const { Invite } = await load();
    const html = (
      await Invite({
        user: { id: 'u' },
        url: 'https://genrewatch.com/i/abc',
        accepted: [],
        remaining: 0,
        dailyLimit: 10,
        maxPerSubmission: 5,
      }).toString()
    ).toString();
    expect(html).toContain('Back tomorrow');
    expect(html).toContain('disabled');
  });
});

describe('the query that feeds the page', () => {
  test('invitesAccepted never selects an email address', async () => {
    const src = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const body = src.slice(src.indexOf('export async function invitesAccepted')).split('\n}')[0];
    expect(body).not.toContain('email');
    expect(body).toContain('display_name');
  });
});
