import { syncAll } from '@genre/catalog';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { sendEmail, sendPush } from '@genre/notify';
import { Worker } from 'bullmq';
import { connection, QUEUES, queues } from './index.js';

const log = (...a) => console.log('[worker]', ...a);

/* -------------------------------------------------------------------- scan -- */

/**
 * Every 30 seconds: which events just crossed a reminder threshold?
 *
 * Run TWICE, once per reminder class. An event with a real clock time is measured
 * against offsets_minutes (60, 1); one that only has a date is measured against
 * date_offsets_minutes (1440, 0). Scanning them together with one offset list is
 * the bug this split exists to prevent -- it would fire the "starts in 1 minute"
 * reminder for every album and film at 11:59 UTC, sixty seconds before a noon
 * anchor that nobody chose and that means nothing to the reader.
 *
 * One job is enqueued per (event, offset) with a deterministic id, so a scan that
 * runs twice -- two workers, a retry, a clock nudge -- produces the same job
 * rather than a second fan-out.
 */
async function runScan() {
  let matched = 0;

  for (const timed of [true, false]) {
    const defaults = timed ? config.reminders.defaultOffsets : config.reminders.dateOffsets;
    const offsets = await q.distinctReminderOffsets(defaults, { timed });

    for (const offsetMinutes of offsets) {
      // The lookback must exceed the scan interval or a tick that runs late leaves
      // a gap no later tick will ever revisit.
      const events = await q.eventsDueForReminder({
        offsetMinutes,
        lookbackSeconds: Math.max(config.reminders.maxLatenessSeconds, 120),
        timed,
      });

      for (const e of events) {
        // The deterministic job id is doing the deduplication here. An event stays
        // inside the lookback window for several minutes, so it matches on ten
        // consecutive ticks; BullMQ returns the existing job for a known id rather
        // than creating a second fan-out, and completed jobs are retained long
        // enough (removeOnComplete.age) to outlive the window.
        await queues.fanout.add(
          'fanout',
          { eventId: e.id, offsetMinutes, startsAt: e.starts_at, timed },
          { jobId: `fo-${e.id}-${offsetMinutes}` },
        );
        matched++;
      }
    }
  }

  // Says "matched", not "queued": most of these are the same events re-matching on
  // a later tick and being deduplicated away. Logging them as queued work makes a
  // quiet scanner look like a busy one.
  if (matched) log(`scan matched ${matched} due (event, offset) pair(s)`);
  return matched;
}

/* ------------------------------------------------------------------ fanout -- */

/**
 * Turn one event into pages of recipients.
 *
 * NB: no ':' in any job id. BullMQ reserves that character for its own
 * repeatable-job keys and throws "Custom Id cannot contain :" for anything that
 * does not split into exactly three parts -- so a four-part id here crashed the
 * fan-out outright, and a two-part id elsewhere killed the container on boot.
 *
 * This is the part that has to survive going viral. The queue never holds one job
 * per follower -- it holds one job per *page* of followers, so a premiere with two
 * million followers enqueues four thousand jobs, not two million. Paging is keyset
 * on user_id, which stays flat as the offset grows and cannot skip or repeat a row
 * when someone follows the show mid-fan-out.
 */
async function runFanout(job) {
  const { eventId, offsetMinutes, startsAt, timed = true } = job.data;

  const dueAt = new Date(startsAt).getTime() - offsetMinutes * 60_000;
  const lateBy = (Date.now() - dueAt) / 1000;
  if (lateBy > config.reminders.maxLatenessSeconds) {
    // Telling someone something starts in an hour, an hour after it started, is
    // worse than silence. A backlog is dropped rather than delivered wrong.
    log(`fanout ${eventId}/${offsetMinutes} dropped, ${Math.round(lateBy)}s late`);
    return { dropped: true };
  }

  let after = '00000000-0000-0000-0000-000000000000';
  let pages = 0;
  let users = 0;

  for (;;) {
    const rows = await q.followersOfEventPage({
      eventId,
      after,
      limit: config.reminders.batchSize,
    });
    if (rows.length === 0) break;

    const userIds = rows.map((r) => r.user_id);
    await queues.batch.add(
      'batch',
      { eventId, offsetMinutes, userIds, timed },
      { jobId: `bt-${eventId}-${offsetMinutes}-${after}` },
    );

    after = userIds[userIds.length - 1];
    pages++;
    users += userIds.length;
    if (rows.length < config.reminders.batchSize) break;
  }

  if (pages) log(`fanout ${eventId}/${offsetMinutes}: ${users} followers in ${pages} page(s)`);
  return { pages, users };
}

/* ------------------------------------------------------------------- batch -- */

/**
 * Deliver one page. Claim first, then send.
 *
 * The claim is an insert whose primary key is (event, user, offset, channel); a
 * duplicate or retried job gets an empty set back and sends nothing. Claiming
 * before sending means the worst case is a dropped notification, not a duplicate
 * one -- the right way round for something that buzzes a phone.
 */
async function runBatch(job) {
  const { eventId, offsetMinutes, userIds, timed = true } = job.data;
  const event = await q.getEvent(eventId);
  if (!event) return { skipped: 'event-gone' };

  const targets = await q.deliveryTargets(userIds);
  const claims = [];

  for (const t of targets) {
    /*
     * A user only wants the offsets they asked for, from the right list.
     *
     * The scan is global, so this is where a 60-minute reminder is withheld from
     * someone who only wants 1 minute -- and reading the WRONG list here would
     * silently deliver nothing at all, because 1440 is never in offsets_minutes
     * and 60 is never in date_offsets_minutes.
     */
    const wanted = timed ? t.offsets_minutes : t.date_offsets_minutes;
    if (!wanted.includes(offsetMinutes)) continue;

    for (const channel of t.channels) {
      if (channel === 'webpush' && t.push_subscriptions.length === 0) continue;
      if (channel === 'email' && !t.email) continue;
      claims.push({
        event_id: eventId,
        user_id: t.user_id,
        offset_minutes: offsetMinutes,
        channel,
      });
    }
  }

  const won = await q.claimDeliveries(claims);
  if (won.length === 0) return { sent: 0, deduped: claims.length };

  const byUser = new Map(targets.map((t) => [t.user_id, t]));
  const wonByChannel = { webpush: [], email: [] };
  for (const c of won) wonByChannel[c.channel]?.push(c);

  let sent = 0;
  let failed = 0;

  const settle = async (rows, send) => {
    const results = await Promise.allSettled(rows.map((c) => send(byUser.get(c.user_id), c)));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') sent++;
      else {
        failed++;
        await q.markDeliveryFailed({
          eventId,
          userId: rows[i].user_id,
          offsetMinutes,
          channel: rows[i].channel,
        });
      }
    }
  };

  await settle(wonByChannel.webpush, (t) => sendPush(t, { event, offsetMinutes }));
  await settle(wonByChannel.email, (t) => sendEmail(t, { event, offsetMinutes }));

  log(
    `batch ${eventId}/${offsetMinutes}: sent ${sent}, failed ${failed}, ` +
      `deduped ${claims.length - won.length}`,
  );
  return { sent, failed };
}

/* --------------------------------------------------------- cache eviction -- */

/**
 * Throw away the rendered pages a sync just invalidated.
 *
 * Read pages are cached in Redis for 60-900 seconds and served byte-identical to
 * every signed-out visitor. That is fine while the catalogue is steady and wrong
 * immediately after a sync: the pass that first seeded this site wrote 2,276
 * events and the genre index went on serving "0 genres across 0 categories" --
 * rendered seconds earlier against an empty database -- until its TTL ran out.
 * A first-time visitor in that window sees an empty site.
 *
 * SCAN rather than KEYS: KEYS blocks the server for the length of the keyspace,
 * and this Redis is shared with the queues, so a stall here stalls delivery.
 * Failing is harmless -- the TTL is still there as a backstop -- so a Redis blip
 * must not fail the sync job that has already done its real work.
 */
async function dropPageCache(results) {
  const wrote = (results ?? []).some((r) => (r?.events ?? 0) > 0);
  if (!wrote) return 0;

  let cursor = '0';
  let dropped = 0;
  try {
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', 'page:*', 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        await connection.del(...keys);
        dropped += keys.length;
      }
    } while (cursor !== '0');
  } catch (err) {
    log(`cache eviction skipped: ${err.message}`);
    return dropped;
  }
  if (dropped) log(`evicted ${dropped} cached page(s) after sync`);
  return dropped;
}

/* ------------------------------------------------------------------- boot --- */

export function startWorkers({ concurrency = {} } = {}) {
  const workers = [
    new Worker(QUEUES.scan, runScan, { connection, concurrency: 1 }),

    /*
     * Concurrency 1, always.
     *
     * The sync worker walks five providers in sequence and several of them are
     * rate limited to the point where a second concurrent pass would not just be
     * wasteful but actively harmful -- TheSpaceDevs allows fifteen requests an
     * hour across the whole deployment, so two overlapping passes exhaust the
     * budget and both fail.
     */
    new Worker(
      QUEUES.sync,
      async (job) => {
        const results = await syncAll({ force: Boolean(job.data?.force) });
        await dropPageCache(results);
        return results;
      },
      { connection, concurrency: 1 },
    ),

    new Worker(QUEUES.fanout, runFanout, {
      connection,
      concurrency: concurrency.fanout ?? 4,
    }),

    // The delivery tier is the one that scales horizontally. Raising this is the
    // first lever if reminders start landing late under load.
    new Worker(QUEUES.batch, runBatch, {
      connection,
      concurrency: concurrency.batch ?? 16,
    }),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) =>
      console.error(`[worker] ${w.name} job ${job?.id} failed:`, err?.message),
    );
  }
  log(`started ${workers.length} workers`);
  return workers;
}
