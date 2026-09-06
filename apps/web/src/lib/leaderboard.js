import { config } from '@genre/config';
import { sql } from '@genre/db';
import { createLeaderboard, projectionStore } from '@profullstack/leaderboard';

/**
 * The public board over the crawler paywall.
 *
 * Two sides, never in one list. An agent that paid is a customer and is ranked
 * by money; an agent that keeps hitting the wall without paying is demand, and
 * is ranked by volume. Putting them in one table would say those are the same
 * kind of fact, and the difference between them is the entire business.
 *
 * Both tables are written by the gateway hooks in app.js, so the board keeps no
 * copy of its own and cannot drift from them. Badges are the exception: they
 * are awarded rather than derived.
 */

const ms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

const badges = {
  async awardBadge(player, badge) {
    const rows = await sql`
      insert into leaderboard_badges (player, badge) values (${player}, ${badge})
      on conflict (player, badge) do nothing
      returning player`;
    return rows.length > 0;
  },
  async badges() {
    const rows = await sql`select player, badge, awarded_at from leaderboard_badges`;
    const out = {};
    for (const r of rows) {
      out[r.player] ??= {};
      out[r.player][r.badge] = ms(r.awarded_at);
    }
    return out;
  },
};

const KNOWN_AGENTS = [
  'meta-externalagent',
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'Bytespider',
  'Applebot',
  'FacebookBot',
  'Lightpanda',
  'PerplexityBot',
  'Google-Extended',
];

/**
 * The name a reader recognises. An agent that says nothing useful is grouped
 * under one honest label rather than given a row per random string, which
 * would fill the board with noise and bury the agents that matter.
 */
export function agentName(userAgent) {
  const ua = String(userAgent ?? '');
  const known = KNOWN_AGENTS.find((k) => ua.toLowerCase().includes(k.toLowerCase()));
  if (known) return known;
  // A spoofed browser is charged like a crawler, so it reaches the board. Its
  // first token is "Mozilla", which every browser string starts with and which
  // names nothing: shown raw it becomes a meaningless row that climbs. Say what
  // it actually is instead.
  const token = ua.match(/([A-Za-z][\w.-]{2,30})\/[\d.]+/)?.[1];
  if (!token || /^mozilla$/i.test(token)) return 'unidentified';
  return token;
}

const shortWallet = (p) => (p.length > 14 ? `${p.slice(0, 6)}…${p.slice(-4)}` : p);

async function events({ since }) {
  const from = new Date(since || 0);
  const [sales, demand] = await Promise.all([
    sql`select payer, user_agent, total_cents, days, created_at
        from crawl_sales where created_at >= ${from}`,
    // crawl_demand.day is a DATE. Binding a JS Date here sends Postgres the
    // full "Thu Jan 01 1970 00:00:00 GMT+0000 (…)" string, which it refuses to
    // parse as a date, and the whole board 500s. Send the day itself.
    sql`select agent, day, hits from crawl_demand where day >= ${from.toISOString().slice(0, 10)}`,
  ]);

  const out = [];
  for (const s of sales) {
    const player = s.payer || agentName(s.user_agent);
    if (!player) continue;
    const at = ms(s.created_at);
    const name = agentName(s.user_agent) ?? shortWallet(String(player));
    const each = (metric, delta) => out.push({ player: String(player), name, metric, delta, at });
    each('spent', Number(s.total_cents) || 0);
    each('passes', 1);
    each('days', Number(s.days) || 1);
  }
  for (const d of demand) {
    // A day bucket lands at noon UTC, so it falls inside the day it describes
    // no matter which way a period boundary rounds.
    const at = ms(d.day) + 12 * 3600 * 1000;
    out.push({
      player: `ua:${d.agent}`,
      name: d.agent,
      metric: 'blocked',
      delta: Number(d.hits) || 0,
      at,
    });
  }
  return out;
}

export const leaderboard = createLeaderboard({
  siteName: 'GenreWatch',
  siteUrl: config.siteUrl,
  basePath: '/leaderboard',
  store: projectionStore({ events, badges }),
  sides: { buy: 'Agents paying', use: 'Agents not paying' },
  boards: {
    spenders: {
      label: 'Biggest spenders',
      metric: 'spent',
      format: 'usd',
      unit: 'Spent',
      side: 'buy',
      actor: 'Agent',
    },
    passes: {
      label: 'Most passes bought',
      metric: 'passes',
      format: 'integer',
      unit: 'Passes',
      side: 'buy',
      actor: 'Agent',
    },
    days: {
      label: 'Most days of access',
      metric: 'days',
      format: 'integer',
      unit: 'Days',
      side: 'buy',
      actor: 'Agent',
    },
    blocked: {
      label: 'Most requests refused',
      metric: 'blocked',
      format: 'integer',
      unit: 'Refused',
      side: 'use',
      actor: 'Agent',
    },
  },
  // Nobody earns here: this site sells its own data rather than anyone else's.
  ladder: null,
  cacheMs: 60_000,
});
