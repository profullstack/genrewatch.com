import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fromPrice, LivePage, LiveUpsell } from '../apps/web/src/views/live.jsx';
import { ChannelRow } from '../apps/web/src/views/pages.jsx';
import { config } from '../packages/config/src/index.js';
import { LIVE_PASS_KIND, PLAN_KEYS, planFor, plansForSale } from '../packages/live/src/index.js';
import * as provider from '../packages/live/src/provider.js';

/**
 * Live TV passes: a line of our own, sold by the week, month or year.
 *
 * The other half of the streaming rail. Bring-your-own plays a list the reader
 * already pays somebody else for; this sells them one from our reseller account,
 * drops it in as a MANAGED list, and gates it on the pass. What a managed list
 * withholds -- the address, the external players, sharing -- is the whole
 * security property, and most of what is tested here.
 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');
const render = async (node) => String(await node.toString());
const user = { id: 'u1', email: 'a@example.test', handle: 'a' };

describe('the plans', () => {
  test('are a week, a month and a year, priced from configuration', () => {
    const plans = plansForSale();
    expect(plans.map((p) => p.key)).toEqual(['week', 'month', 'year']);
    expect(PLAN_KEYS).toEqual(['week', 'month', 'year']);
    expect(plans.map((p) => p.days)).toEqual([7, 30, 365]);
    expect(planFor('week').priceCents).toBe(config.live.weekCents);
    expect(planFor('month').priceCents).toBe(config.live.monthCents);
    expect(planFor('year').priceCents).toBe(config.live.yearCents);
  });

  test('default to a dollar a week, ten a month, four a month for a year', () => {
    expect(config.live.weekCents).toBe(100);
    expect(config.live.monthCents).toBe(1000);
    expect(config.live.yearCents).toBe(4800);
    expect(planFor('year').perMonthCents).toBe(400);
    expect(planFor('month').perMonthCents).toBeNull();
  });

  test('an unknown plan is nothing, not a default', () => {
    expect(planFor('decade')).toBeNull();
    expect(planFor('')).toBeNull();
  });

  test('the webhook tag is its own word', () => {
    expect(LIVE_PASS_KIND).toBe('live_pass');
    expect(LIVE_PASS_KIND).not.toBe('membership');
  });
});

describe('the provider client', () => {
  const withKey = async (fn) => {
    const before = process.env.IPTV_ARGON_API_KEY;
    process.env.IPTV_ARGON_API_KEY = 'test-key';
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env.IPTV_ARGON_API_KEY;
      else process.env.IPTV_ARGON_API_KEY = before;
    }
  };
  const answer =
    (body, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

  test('refuses to call anything without a key', async () => {
    const before = process.env.IPTV_ARGON_API_KEY;
    delete process.env.IPTV_ARGON_API_KEY;
    try {
      await expect(provider.listTemplates({ fetchImpl: answer({}) })).rejects.toThrow(
        'not configured',
      );
    } finally {
      if (before !== undefined) process.env.IPTV_ARGON_API_KEY = before;
    }
  });

  test('opens a line with the package, the bouquet and any extra connections', async () => {
    await withKey(async () => {
      let seen = null;
      const fetchImpl = async (url, init) => {
        seen = { url, init, body: JSON.parse(init.body) };
        return answer({
          error: false,
          id: 4242,
          username: 'u',
          password: 'p',
          xtream_codes_username: 'xu',
          xtream_codes_password: 'xp',
          m3u_download_link: 'http://line.example/get.php?username=xu&password=xp&type=m3u_plus',
          expiration_time: 1_800_000_000,
        })();
      };
      const line = await provider.createLine({ packageId: 113653, connections: 3, fetchImpl });
      expect(seen.url).toBe(`${config.live.provider.baseUrl}/api/v1/create-line`);
      expect(seen.init.headers.authorization).toBe('Bearer test-key');
      expect(seen.body.package).toBe(113653);
      // Two beyond the one a line comes with.
      expect(seen.body.additional_cons).toBe(2);
      // The Xtream pair is what the playlist address uses, so it is what is kept.
      expect(line).toMatchObject({ id: 4242, username: 'xu', password: 'xp' });
      expect(line.m3u).toContain('get.php');
      expect(line.expiresAt).toEqual(new Date(1_800_000_000 * 1000));
    });
  });

  test('a single connection asks for no extras', async () => {
    await withKey(async () => {
      let body = null;
      const fetchImpl = async (_url, init) => {
        body = JSON.parse(init.body);
        return answer({
          error: false,
          id: 1,
          username: 'u',
          password: 'p',
          m3u_download_link: 'http://x/get.php',
          expiration_time: 1,
        })();
      };
      await provider.createLine({ packageId: 1, connections: 1, fetchImpl });
      expect(body.additional_cons).toBeUndefined();
    });
  });

  test('an `error: true` body with a 200 is still a refusal', async () => {
    await withKey(async () => {
      await expect(
        provider.createLine({
          packageId: 1,
          fetchImpl: answer({ error: true, message: 'Insufficient credits' }),
        }),
      ).rejects.toThrow('Insufficient credits');
    });
  });

  test('an extension that extended nothing is a failure, not a success with zero', async () => {
    await withKey(async () => {
      await expect(
        provider.extendLine({
          lineId: 7,
          packageId: 1,
          fetchImpl: answer({ error: false, failed: 1, successful: 0 }),
        }),
      ).rejects.toThrow('extended nothing');
    });
  });
});

describe('the module', () => {
  const src = read('../packages/live/src/index.js');

  test('a renewal stacks, computed in SQL, idempotent on the payment', () => {
    const grant = src.slice(src.indexOf('export async function grantLivePass'));
    const body = grant.slice(0, grant.indexOf('\n}\n'));
    expect(body).toContain('greatest(now(), coalesce(max(expires_at), now()))');
    expect(body).toContain('on conflict (payment_id) do nothing');
    expect(body).toContain('make_interval(days => ${days}::int)');
  });

  test('provisioning is explicit and the tick only takes lists down', () => {
    // The scheduled job calls reconcileLapsed and nothing that creates a line.
    const workers = read('../packages/queue/src/workers.js');
    expect(workers).toContain('reconcileLapsed({ log })');
    expect(workers).not.toContain('ensureLine');
    const lapsed = src.slice(src.indexOf('export async function reconcileLapsed'));
    expect(lapsed.slice(0, lapsed.indexOf('\n}\n'))).not.toContain('provider.');
  });

  test('every credential is sealed before it is stored, and the pass gates the line', () => {
    const ensure = src.slice(src.indexOf('export async function ensureLine'));
    const body = ensure.slice(0, ensure.indexOf('\n}\n'));
    expect(body).toContain('lineUser: seal(created.username)');
    expect(body).toContain('lineSecret: seal(created.password)');
    expect(body).toContain('sourceUrl: seal(created.m3u)');
    expect(body).toContain("if (!pass) return { ok: false, reason: 'no active pass' }");
    // A reader's own list is parked, never dropped.
    expect(body).toContain('stashedSourceUrl: stash.sourceUrl');
  });

  test('the managed list is named for the brand, never the provider', () => {
    expect(src).toContain("label: 'GenreWatch Live TV'");
    expect(src.toLowerCase()).not.toContain('argon');
  });
});

describe('the pages', () => {
  const plans = plansForSale();

  test('sell three passes with the configured prices and no number of their own', async () => {
    const html = await render(LivePage({ user, plans, enabled: true, paymentsEnabled: true }));
    expect(html).toContain('$1 a week');
    expect(html).toContain('$10 a month');
    expect(html).toContain('$4 a month, $48 for the year');
    expect(html).toContain('action="/api/live/buy"');
    expect(html).toContain('name="plan" value="week"');
    expect(html).toContain('name="plan" value="year"');
  });

  test('never name the provider', async () => {
    const html = await render(LivePage({ user, plans, enabled: true, paymentsEnabled: true }));
    expect(html.toLowerCase()).not.toContain('argon');
    expect(read('../apps/web/src/views/live.jsx').toLowerCase()).not.toContain('argon');
    expect(read('../apps/web/src/views/pages.jsx').toLowerCase()).not.toContain('argon');
  });

  test('a signed-out reader sees the prices and is sent to sign in', async () => {
    const html = await render(
      LivePage({ user: null, plans, enabled: true, paymentsEnabled: true }),
    );
    expect(html).toContain('$1 a week');
    expect(html).toContain('Sign in to buy');
    expect(html).not.toContain('action="/api/live/buy"');
  });

  test('a held pass offers to add time and reports on the channels', async () => {
    const pass = { expires_at: new Date('2030-01-01T00:00:00Z').toISOString() };
    const set = await render(
      LivePage({ user, plans, pass, managed: true, enabled: true, paymentsEnabled: true }),
    );
    expect(set).toContain('Add time');
    expect(set).toContain('Your channels are set up');
    const notYet = await render(
      LivePage({ user, plans, pass, managed: false, enabled: true, paymentsEnabled: true }),
    );
    expect(notYet).toContain('Set up my channels');
    expect(notYet).toContain('action="/api/live/use"');
    const ownList = await render(
      LivePage({
        user,
        plans,
        pass,
        managed: false,
        hasOwnList: true,
        enabled: true,
        paymentsEnabled: true,
      }),
    );
    expect(ownList).toContain('Use the pass instead of my list');
  });

  test('the upsell card names the cheapest way in and points back at the game', async () => {
    expect(fromPrice(plans)).toBe('$1 a week');
    const html = await render(LiveUpsell({ plans, eventId: 74799, signedIn: true }));
    expect(html).toContain('from $1 a week');
    expect(html).toContain('href="/live?event=74799"');
    expect(html).toContain('Get a pass');
    const out = await render(LiveUpsell({ plans, eventId: 74799, signedIn: false }));
    expect(out).toContain('See the passes');
  });
});

describe('a managed channel row', () => {
  const ch = { id: 7, title: 'ESPN', url: 'http://line.example.test/u/p/7' };

  test('plays here and nowhere else', async () => {
    const html = await render(ChannelRow({ ch, managed: true }));
    expect(html).toContain('data-play="/my/channels/7/stream.ts"');
    expect(html).not.toContain('vlc-x-callback');
    expect(html).not.toContain('infuse://');
    expect(html).not.toContain('/playlist.m3u');
    expect(html).not.toContain('line.example.test');
  });

  test('a reader’s own row is unchanged', async () => {
    const html = await render(ChannelRow({ ch }));
    expect(html).toContain('vlc-x-callback');
    expect(html).toContain('/my/channels/7/playlist.m3u');
  });
});

describe('the routes', () => {
  const app = read('../apps/web/src/app.js');
  const src = app;
  const routeBody = (start) => {
    const from = app.slice(app.indexOf(start));
    return from.slice(0, from.indexOf('\n});'));
  };

  test('the buy route charges what the page shows, tagged for the webhook', () => {
    const body = routeBody("app.post('/api/live/buy'");
    expect(body).toContain("const plan = live.planFor(String(body.plan ?? ''))");
    expect(body).toContain('amountCents: plan.priceCents');
    expect(body).toContain('metadata: { kind: live.LIVE_PASS_KIND, plan: plan.key }');
    expect(body).not.toContain('argon');
  });

  test('the webhook grants a pass by kind and sets the line up outside the transaction', () => {
    const body = routeBody("app.post('/api/webhooks/coinpay'");
    expect(body).toContain('meta.kind === live.LIVE_PASS_KIND');
    expect(body).toContain('live.grantLivePass(tx, {');
    // After settleWebhook returned, never inside grant().
    expect(body.indexOf('live.ensureLine(')).toBeGreaterThan(body.indexOf('return c.json') - 1);
    expect(body.indexOf('live.ensureLine(')).toBeGreaterThan(
      body.indexOf('await pay.settleWebhook('),
    );
    expect(body).toContain('result.result?.kind === live.LIVE_PASS_KIND');
  });

  test('a stream on a managed list needs a live pass, checked on every start', () => {
    const fn = app.slice(app.indexOf('async function ownEntryOr404'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('if (row.managed && !(await q.activeLivePass(user.id))) return null;');
  });

  test('a managed list gives up its address to nobody', () => {
    expect(routeBody("app.get('/my/channels/:channelId/playlist.m3u'")).toContain(
      'if (!ch || ch.managed) return c.notFound();',
    );
    expect(routeBody("app.get('/events/:id/playlist.m3u'")).toContain(
      'if (await q.playlistIsManaged(user.id)) return c.redirect(',
    );
    expect(routeBody("app.get('/api/playlist/source'")).toContain(
      'if (await q.playlistIsManaged(user.id)) {',
    );
    expect(routeBody("app.post('/api/playlist/share'")).toContain(
      'if (await q.playlistIsManaged(user.id)) {',
    );
    expect(routeBody("app.post('/api/playlist/share/grant'")).toContain(
      'if (allowed && (await q.playlistIsManaged(user.id))) {',
    );
  });

  test('removing a managed list gives back the one it replaced', () => {
    const body = routeBody("app.post('/api/playlist/delete'");
    expect(body).toContain('existing.stashed_source_url');
    expect(body).toContain('await importPlaylist({ userId: user.id, url: stashed');
  });

  test('the title pages offer a pass only to a reader with no list', () => {
    const body = routeBody("app.get('/events/:id'");
    expect(body).toContain('config.live.enabled && !ownChannels.hasList');
    expect(body).toContain('ownChannels.managed = await q.playlistIsManaged(user.id)');
    // The subject page sells it too: a back-catalogue title is exactly the case
    // where "nothing scheduled" used to be the whole answer.
    expect(src.split('config.live.enabled && !ownChannels.hasList').length - 1).toBe(2);
  });

  test('the nav links to it whenever passes are on sale', () => {
    expect(read('../apps/web/src/views/Layout.jsx')).toContain(
      '{config.live.enabled ? <a href="/live">Live TV</a> : null}',
    );
  });
});

describe('the schema', () => {
  const sql = read('../packages/db/migrations/0019_live_pass.sql');

  test('a pass has a term, a plan and one payment', () => {
    expect(sql).toContain('payment_id  bigint unique references payments(id)');
    expect(sql).toContain("plan        text not null check (plan in ('week', 'month', 'year'))");
    expect(sql).toContain('expires_at  timestamptz not null');
    expect(sql).toContain('constraint live_passes_term_forwards check (expires_at > started_at)');
  });

  test('one line per reader, and a flag plus a stash on the list', () => {
    expect(sql).toContain('user_id         uuid primary key references users(id)');
    expect(sql).toContain('line_id         bigint not null unique');
    expect(sql).toContain('add column if not exists managed boolean not null default false');
    expect(sql).toContain('add column if not exists stashed_source_url text');
  });
});
