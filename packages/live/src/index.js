import { open, seal } from '@genre/auth';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { importPlaylist } from '@genre/playlists';
import * as provider from './provider.js';

/**
 * Live TV passes: selling a line of our own.
 *
 * The bring-your-own rail plays a list the reader already pays somebody else
 * for. This is the other rail: a pass buys time on a line we hold with a
 * reseller account, and the line is dropped into `user_playlists` as a MANAGED
 * list -- so the event page, the probes, Play, Multiview and the connection cap
 * all work on it unchanged. What differs is what a managed list withholds: the
 * address is never revealed, nothing is handed to VLC or a .m3u, and it cannot
 * be shared. Each of those would hand our reseller credential to somebody who
 * did not pay for it.
 *
 * Two clocks, deliberately separate. The PASS is what we sold and is what gates
 * access; the LINE is what the provider issued and outlives a weekly pass by
 * three weeks because the provider sells nothing shorter than a month. When the
 * pass lapses the managed list is taken down and the line is left alone -- the
 * reader who buys again gets the same line back, extended, rather than a second
 * one on our balance.
 *
 * Provisioning is explicit, never a background guess. It runs after a settled
 * payment and when the reader presses "set up my channels"; the scheduled tick
 * only ever takes lapsed lists DOWN. The alternative -- a tick that provisions
 * whenever a pass holder has no managed list -- fights a reader who chose to use
 * their own list while their pass runs, replacing it every fifteen minutes.
 */

/** The metadata tag that tells the webhook this payment bought a pass. */
export const LIVE_PASS_KIND = 'live_pass';

/** The three terms for sale, in the order they are shown. */
export const PLAN_KEYS = ['week', 'month', 'year'];

const TERM_DAYS = { week: 7, month: 30, year: 365 };

/**
 * What is for sale right now, priced from configuration. Never a number the
 * page could disagree with the webhook about: both read this.
 */
export function plansForSale() {
  const { weekCents, monthCents, yearCents, currency } = config.live;
  const cents = { week: weekCents, month: monthCents, year: yearCents };
  return PLAN_KEYS.map((key) => ({
    key,
    days: TERM_DAYS[key],
    priceCents: cents[key],
    currency,
    // What a month works out to, so a year can be sold as "$4 a month".
    perMonthCents: key === 'year' ? Math.round(cents.year / 12) : null,
  }));
}

export function planFor(key) {
  return plansForSale().find((p) => p.key === key) ?? null;
}

/**
 * Add one paid term to somebody's pass, inside the caller's transaction.
 *
 * Same SQL shape as grantMembership and for the same reasons: a renewal STACKS
 * onto the end of what is held, the start is computed in the statement so two
 * concurrent webhooks cannot both read the same one, and `payment_id` is unique
 * so a retried webhook inserts nothing.
 *
 * @param {Function} tx
 * @param {{userId: string, paymentId: number|null, plan: string, priceCents: number, currency: string}} args
 */
export async function grantLivePass(tx, { userId, paymentId, plan, priceCents, currency }) {
  if (!userId) throw new Error('a pass needs a holder');
  const days = TERM_DAYS[plan];
  if (!days) throw new Error(`unknown plan ${plan}`);
  if (!Number.isFinite(priceCents) || priceCents < 0) throw new Error('bad price');

  const [row] = await tx`
    insert into live_passes (user_id, payment_id, plan, started_at, expires_at, price_cents, currency)
    select ${userId}::uuid,
           ${paymentId ?? null},
           ${plan},
           s.start_at,
           s.start_at + make_interval(days => ${days}::int),
           ${Math.trunc(priceCents)}::int,
           ${currency ?? 'USD'}
    from (
      select greatest(now(), coalesce(max(expires_at), now())) as start_at
      from live_passes
      where user_id = ${userId}::uuid and status = 'active'
    ) s
    on conflict (payment_id) do nothing
    returning id, started_at, expires_at, plan
  `;
  return row ? { kind: LIVE_PASS_KIND, ...row } : null;
}

/** The pass this reader holds right now, or null. A plain read. */
export function activeLivePass(userId) {
  return q.activeLivePass(userId);
}

/**
 * Make the reader's pass usable: a line that covers it, imported as their
 * managed list.
 *
 * Idempotent, and safe to call again after a failure at any step: a line that
 * exists is reused, one that runs out before the pass is extended, and a list
 * that is already ours is left alone. Returns what was done, for a log line and
 * for the page's "set up" button.
 *
 * @param {string} userId
 * @param {{log?: Function}} [opts]
 */
export async function ensureLine(userId, { log = console.log } = {}) {
  if (!config.live.enabled) throw new Error('live passes are not switched on');
  const pass = await q.activeLivePass(userId);
  if (!pass) return { ok: false, reason: 'no active pass' };

  const done = [];
  let line = await q.providerLine(userId);

  if (!line) {
    const created = await provider.createLine({
      packageId: packageCovering(new Date(), pass.expires_at),
      connections: config.live.connections,
    });
    line = await q.saveProviderLine({
      userId,
      lineId: created.id,
      // Column names carry no "password": the schema guard keeps that word to
      // users alone, and these are sealed opaque strings either way.
      lineUser: seal(created.username),
      lineSecret: seal(created.password),
      sourceUrl: seal(created.m3u),
      expiresAt: created.expiresAt,
      maxConnections: null,
    });
    done.push('created line');
    log(`[live] line ${created.id} opened for ${userId}`);
  } else if (line.expires_at && new Date(line.expires_at) < new Date(pass.expires_at)) {
    /*
     * The line runs out before the pass does. Extend it by whichever package
     * covers the gap, then read the line back: the panel answers an extension
     * with counts, not a date, and its arithmetic is the one that matters.
     */
    await provider.extendLine({
      lineId: line.line_id,
      packageId: packageCovering(new Date(line.expires_at), pass.expires_at),
    });
    const fresh = await provider.getLine({ lineId: line.line_id }).catch(() => null);
    line = await q.touchProviderLine({
      userId,
      expiresAt: fresh?.expiresAt ?? null,
      maxConnections: fresh?.maxConnections ?? null,
    });
    done.push('extended line');
    log(`[live] line ${line.line_id} extended for ${userId}`);
  }

  /*
   * Our line goes in BESIDE whatever they already have.
   *
   * This used to take their row: park their address in a stash column, overwrite
   * the row with our line, and hand it back when the pass lapsed. That was forced
   * by one-list-per-account and nothing else, and it meant paying us cost a reader
   * access to their own subscription for the length of the pass.
   *
   * Now it is an add. Their lists are not read, not moved and not touched, and the
   * only row this owns is the one it creates.
   */
  const existing = await q.managedPlaylistFor(userId);
  if (!existing) {
    const m3u = open(line.source_url);
    if (!m3u) throw new Error('the stored line could not be read');

    const result = await importPlaylist({ userId, url: m3u, label: 'GenreWatch Live TV' });
    // Marked by id, against the row the import just wrote. Without the id this
    // falls back to the reader's FIRST list, which is very likely one of theirs --
    // and marking that managed would hide their own address behind our pass rules.
    await q.setPlaylistManaged({ userId, playlistId: result?.playlistId ?? null, managed: true });
    done.push('imported list');
  }

  return { ok: true, done, lineId: line.line_id, expiresAt: pass.expires_at };
}

/**
 * Take down every managed list whose pass lapsed past the grace window. Runs on
 * the worker's tick.
 *
 * One delete, and nothing to give back. The restore half of this is gone with the
 * stash: a lapse removes the row our pass added and leaves every other list the
 * reader has untouched, because those were never taken in the first place. That
 * also removes the failure mode where restoring somebody's own address depended on
 * a network fetch succeeding inside a cleanup tick.
 *
 * Down only, never up -- see the module note. The provider is not told; the line
 * keeps to its own expiry and is reused if they buy again.
 */
export async function reconcileLapsed({ log = console.log } = {}) {
  const lapsed = await q.managedPlaylistsLapsed({ graceHours: config.live.graceHours });
  let removed = 0;
  for (const row of lapsed) {
    // By id. `deletePlaylist(userId)` with no id still means "every list they
    // have", which here would delete the reader's own subscriptions along with
    // our lapsed line.
    await q.deletePlaylist(row.user_id, row.playlist_id);
    removed += 1;
  }
  if (lapsed.length) log(`[live] ${removed} lapsed managed list(s) removed`);
  return { removed };
}

/**
 * Which package to buy so a line lasts from `from` until at least `until`.
 * A month covers a week or a month; anything longer is a year.
 */
function packageCovering(from, until) {
  const days = (new Date(until).getTime() - new Date(from).getTime()) / 86_400_000;
  return days > 31 ? config.live.provider.packageYear : config.live.provider.packageMonth;
}
