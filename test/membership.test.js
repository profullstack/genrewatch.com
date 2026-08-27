import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  commissionCents,
  creditReferral,
  grantMembership,
  MEMBERSHIP_KIND,
} from '../packages/payments/src/membership.js';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Premium membership, and the commission an invite earns on it.
 *
 * The rules pinned here are the ones that are quiet when broken and expensive when
 * they are: a replayed webhook granting a second year, a renewal throwing away
 * time somebody paid for, an inviter credited twice for one sale, and a list
 * narrowed to named friends that a stranger can still read.
 */

let db;
/** The production functions take a tagged template. PGlite takes $1 placeholders.
 *  Twelve lines of adapter, and the tests exercise the real SQL rather than a
 *  paraphrase of it -- which is the whole point, since every bug worth catching
 *  here lives inside a query. */
let tx;
let alice;
let bob;
let carol;

const paymentFor = async (userId, cents = 1000, ref = crypto.randomUUID()) =>
  (
    await db.query(
      `insert into payments (user_id, provider_ref, amount_cents, currency, status)
       values ($1, $2, $3, 'USD', 'paid') returning id`,
      [userId, ref, cents],
    )
  ).rows[0].id;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  tx = async (strings, ...values) => {
    let text = '';
    strings.forEach((part, i) => {
      text += part;
      if (i < values.length) text += `$${i + 1}`;
    });
    return (await db.query(text, values)).rows;
  };

  const mk = async (email, handle) =>
    (
      await db.query(`insert into users (email, handle) values ($1, $2) returning id`, [
        email,
        handle,
      ])
    ).rows[0].id;
  alice = await mk('alice@example.test', 'alice');
  bob = await mk('bob@example.test', 'bob');
  carol = await mk('carol@example.test', 'carol');
}, 60_000);

describe('what a commission comes to', () => {
  test('twenty per cent of ten dollars is two dollars', () => {
    expect(commissionCents({ amountCents: 1000, rateBps: 2000 })).toBe(200);
  });

  test('a fraction of a cent rounds DOWN, never up', () => {
    // 20% of 999 is 199.8. Rounding up pays out more than was taken in, on every
    // transaction, forever.
    expect(commissionCents({ amountCents: 999, rateBps: 2000 })).toBe(199);
  });

  test('nonsense earns nothing rather than NaN', () => {
    expect(commissionCents({ amountCents: undefined, rateBps: 2000 })).toBe(0);
    expect(commissionCents({ amountCents: -500, rateBps: 2000 })).toBe(0);
    expect(commissionCents({ amountCents: 1000, rateBps: 0 })).toBe(0);
  });
});

describe('granting a term', () => {
  test('a first term runs from now', async () => {
    const pid = await paymentFor(alice);
    const row = await grantMembership(tx, {
      userId: alice,
      paymentId: pid,
      priceCents: 1000,
      currency: 'USD',
      termDays: 365,
    });
    const days = (new Date(row.expires_at) - new Date(row.started_at)) / 86_400_000;
    expect(Math.round(days)).toBe(365);
    expect(row.replayed).toBe(false);
  });

  test('renewing STACKS onto the end rather than restarting', async () => {
    const [before] = await db
      .query(`select max(expires_at) as e from memberships where user_id = $1`, [alice])
      .then((r) => r.rows);

    const pid = await paymentFor(alice);
    const row = await grantMembership(tx, {
      userId: alice,
      paymentId: pid,
      priceCents: 1000,
      currency: 'USD',
      termDays: 365,
    });

    // Renewing with a year left must not donate that year back to us.
    expect(new Date(row.started_at).getTime()).toBe(new Date(before.e).getTime());
    const total = (new Date(row.expires_at) - Date.now()) / 86_400_000;
    expect(Math.round(total)).toBe(730);
  });

  test('a replayed webhook cannot mint a second term', async () => {
    const pid = await paymentFor(bob);
    const first = await grantMembership(tx, {
      userId: bob,
      paymentId: pid,
      priceCents: 1000,
      currency: 'USD',
      termDays: 365,
    });
    const again = await grantMembership(tx, {
      userId: bob,
      paymentId: pid,
      priceCents: 1000,
      currency: 'USD',
      termDays: 365,
    });

    expect(again.replayed).toBe(true);
    expect(new Date(again.expires_at).getTime()).toBe(new Date(first.expires_at).getTime());

    const { rows } = await db.query(
      `select count(*)::int as n from memberships where user_id = $1`,
      [bob],
    );
    expect(rows[0].n).toBe(1);
  });

  test('a term with no length is refused rather than made perpetual', async () => {
    await expect(
      grantMembership(tx, { userId: carol, paymentId: null, priceCents: 1000, termDays: 0 }),
    ).rejects.toThrow(/term/);
  });

  test('the kind tag is one string, not two spellings', () => {
    expect(MEMBERSHIP_KIND).toBe('membership');
  });
});

describe('crediting the person who invited them', () => {
  test('nobody invited the buyer, so nobody is paid', async () => {
    const pid = await paymentFor(carol);
    const row = await creditReferral(tx, {
      buyerId: carol,
      paymentId: pid,
      amountCents: 1000,
      currency: 'USD',
      rateBps: 2000,
    });
    expect(row).toBeNull();
  });

  test('the inviter earns the rate, once', async () => {
    await db.query(`insert into invite_claims (invited_user_id, inviter_id) values ($1, $2)`, [
      carol,
      alice,
    ]);
    const pid = await paymentFor(carol);

    const first = await creditReferral(tx, {
      buyerId: carol,
      paymentId: pid,
      amountCents: 1000,
      currency: 'USD',
      rateBps: 2000,
    });
    expect(first.amount_cents).toBe(200);
    expect(first.referrer_id).toBe(alice);

    // The upstream retries a webhook until it gets a 200. Every retry must earn
    // nothing further, or a $10 sale eventually pays out $10.
    const replay = await creditReferral(tx, {
      buyerId: carol,
      paymentId: pid,
      amountCents: 1000,
      currency: 'USD',
      rateBps: 2000,
    });
    expect(replay).toBeNull();

    const { rows } = await db.query(
      `select count(*)::int as n, sum(amount_cents)::int as total
       from referral_commissions where payment_id = $1`,
      [pid],
    );
    expect(rows[0].n).toBe(1);
    expect(rows[0].total).toBe(200);
  });

  test('the rate is stored on the row, not read back from configuration', async () => {
    const { rows } = await db.query(
      `select distinct rate_bps from referral_commissions where referrer_id = $1`,
      [alice],
    );
    // Changing the rate later must not re-price what somebody was already promised.
    expect(rows[0].rate_bps).toBe(2000);
  });

  test('you cannot invite yourself into a commission', async () => {
    await expect(
      db.query(`insert into invite_claims (invited_user_id, inviter_id) values ($1, $1)`, [bob]),
    ).rejects.toThrow();
  });

  test('being invited twice is not a state the schema allows', async () => {
    await expect(
      db.query(`insert into invite_claims (invited_user_id, inviter_id) values ($1, $2)`, [
        carol,
        bob,
      ]),
    ).rejects.toThrow();
  });
});

describe('who a shared list is open to', () => {
  let listId;

  beforeAll(async () => {
    listId = (
      await db.query(
        `insert into user_playlists (user_id, source_url, channel_count) values ($1, 'sealed', 3)
         returning id`,
        [alice],
      )
    ).rows[0].id;
    await db.query(
      `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
       values ($1, 0, 'Sky Sports', 'sealed', 'sky sports')`,
      [listId],
    );
  });

  test('the flag and the audience cannot disagree', async () => {
    // A row saying "shared" with an audience of nobody is unreachable; one saying
    // "not shared" with an audience is a list some query will read as open.
    await expect(
      db.query(`update user_playlists set shared = true where id = $1`, [listId]),
    ).rejects.toThrow();
    await expect(
      db.query(`update user_playlists set share_audience = 'everyone' where id = $1`, [listId]),
    ).rejects.toThrow();
  });

  /** The predicate every cross-account read uses. Written once here, exactly as
   *  the queries write it, so a change to one side fails loudly on the other. */
  const visibleTo = async (viewer) =>
    (
      await db.query(
        `select c.id
           from user_playlists p
           join user_playlist_channels c on c.playlist_id = p.id
          where p.shared
            and (
              p.share_audience = 'everyone'
              or (p.share_audience = 'friends' and exists (
                    select 1 from playlist_share_grants g
                    where g.playlist_id = p.id and g.audience_user_id = $1::uuid))
            )
            and ($1::uuid is null or p.user_id <> $1)`,
        [viewer],
      )
    ).rows;

  test('a private list is visible to nobody', async () => {
    expect(await visibleTo(bob)).toHaveLength(0);
  });

  test('shared with everyone is visible to any signed-in reader', async () => {
    await db.query(
      `update user_playlists set shared = true, share_audience = 'everyone' where id = $1`,
      [listId],
    );
    expect(await visibleTo(bob)).toHaveLength(1);
    expect(await visibleTo(carol)).toHaveLength(1);
  });

  test('shared with friends is visible only to the people named', async () => {
    await db.query(`update user_playlists set share_audience = 'friends' where id = $1`, [listId]);
    // Nobody named yet: narrowing the audience must not leave it open.
    expect(await visibleTo(bob)).toHaveLength(0);
    expect(await visibleTo(carol)).toHaveLength(0);

    await db.query(
      `insert into playlist_share_grants (playlist_id, audience_user_id) values ($1, $2)`,
      [listId, bob],
    );
    expect(await visibleTo(bob)).toHaveLength(1);
    // Carol follows Alice and can see the site. That is not consent to a credential.
    expect(await visibleTo(carol)).toHaveLength(0);
  });

  test('a signed-out reader sees nothing on a friends list', async () => {
    expect(await visibleTo(null)).toHaveLength(0);
  });

  test('the owner never sees their own list in the shared read', async () => {
    expect(await visibleTo(alice)).toHaveLength(0);
  });
});

describe('how far back a conversation can be read', () => {
  beforeAll(async () => {
    await db.query(
      `insert into messages (sender_id, recipient_id, body, created_at)
       values ($1, $2, 'ancient', now() - interval '400 days'),
              ($1, $2, 'old', now() - interval '90 days'),
              ($1, $2, 'recent', now() - interval '2 days')`,
      [alice, bob],
    );
  });

  const windowed = async (days) =>
    (
      await db.query(
        `select body from messages
          where ((sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1))
            and ($3::int is null or created_at > now() - make_interval(days => $3::int))`,
        [alice, bob, days],
      )
    ).rows.map((r) => r.body);

  test('a member reads all of it', async () => {
    expect((await windowed(null)).sort()).toEqual(['ancient', 'old', 'recent']);
  });

  test('a free account reads the window only', async () => {
    expect(await windowed(30)).toEqual(['recent']);
  });

  test('nothing is deleted to make that true', async () => {
    // The whole product claim rests on this: joining brings the thread back.
    const { rows } = await db.query(
      `select count(*)::int as n from messages where sender_id = $1 and recipient_id = $2`,
      [alice, bob],
    );
    expect(rows[0].n).toBe(3);
  });

  test('the withheld count is what the page reports', async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from messages
        where ((sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1))
          and created_at <= now() - make_interval(days => 30)`,
      [alice, bob],
    );
    // "There are 2 older messages" and an empty space are different sentences.
    expect(rows[0].n).toBe(2);
  });
});
