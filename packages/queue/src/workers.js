import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { sendEmail, sendPush } from '@genre/notify';
import { syncAll, syncCatalogue, syncLiveScores, syncNear, syncPlays } from '@genre/catalog';
import { Worker } from 'bullmq';
import { connection, QUEUES, queues } from './index.js';

const log = (...a) => console.log('[worker]', ...a);

/* -------------------------------------------------------------------- scan -- */

/**
 * Every 30 seconds: which events just crossed a reminder threshold?
 *
 * One job is enqueued per (event, offset) with a deterministic id, so a scan that
 * runs twice -- two workers, a retry, a clock nudge -- produces the same job rather
 * than a second fan-out.
 */
async function runScan() {
  const offsets = await q.distinctReminderOffsets(config.reminders.defaultOffsets);
  let matched = 0;

  for (const offsetMinutes of offsets) {
    // The lookback must exceed the scan interval or a tick that runs late leaves a
    // gap no later tick will ever revisit.
    const events = await q.eventsDueForReminder({
      offsetMinutes,
      lookbackSeconds: Math.max(config.reminders.maxLatenessSeconds, 120),
    });

    for (const e of events) {
      // The deterministic job id is doing the deduplication here. An event stays
      // inside the lookback window for several minutes, so it matches on ten
      // consecutive ticks; BullMQ returns the existing job for a known id rather
      // than creating a second fan-out, and completed jobs are retained long
      // enough (removeOnComplete.age) to outlive the window.
      await queues.fanout.add(
        'fanout',
        { eventId: e.id, offsetMinutes, startsAt: e.startsAt },
        { jobId: `fo-${e.id}-${offsetMinutes}` },
      );
      matched++;
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
 * NB: no ':' in any job id. BullMQ reserves that character for its own repeatable-job
 * keys and throws "Custom Id cannot contain :" for anything that does not split into
 * exactly three parts -- so a four-part id here crashed the fan-out outright, and a
 * two-part id elsewhere killed the container on boot.
 *
 * This is the part that has to survive going viral. The queue never holds one job
 * per follower -- it holds one job per *page* of followers, so a fixture with two
 * million followers enqueues four thousand jobs, not two million. Paging is keyset
 * on user_id, which stays flat as the offset grows and cannot skip or repeat a row
 * when someone follows the team mid-fan-out.
 */
async function runFanout(job) {
  const { eventId, offsetMinutes, startsAt } = job.data;

  const dueAt = new Date(startsAt).getTime() - offsetMinutes * 60_000;
  const lateBy = (Date.now() - dueAt) / 1000;
  if (lateBy > config.reminders.maxLatenessSeconds) {
    // Telling someone a game starts in an hour, an hour after it started, is worse
    // than silence. A backlog is dropped rather than delivered wrong.
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
      { eventId, offsetMinutes, userIds },
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
  const { eventId, offsetMinutes, userIds } = job.data;
  const event = await q.getEvent(eventId);
  if (!event) return { skipped: 'event-gone' };

  const targets = await q.deliveryTargets(userIds);
  const claims = [];

  for (const t of targets) {
    // A user only wants the offsets they asked for. The scan is global, so this is
    // where a 60-minute reminder is withheld from someone who only wants 1 minute.
    if (!t.offsets_minutes.includes(offsetMinutes)) continue;

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
    `batch ${eventId}/${offsetMinutes}: sent ${sent}, failed ${failed}, deduped ${claims.length - won.length}`,
  );
  return { sent, failed };
}

/* ------------------------------------------------------------------- boot --- */

export function startWorkers({ concurrency = {} } = {}) {
  const workers = [
    new Worker(QUEUES.scan, runScan, { connection, concurrency: 1 }),

    new Worker(
      QUEUES.sync,
      async (job) => {
        // Explicit rather than a ternary chain: three kinds share this queue so
        // that concurrency 1 serialises them, and an unknown kind must not
        // silently fall through to the most expensive one.
        if (job.data.kind === 'catalogue') return syncCatalogue();
        if (job.data.kind === 'near') return syncNear();
        return syncAll();
      },
      {
        connection,
        concurrency: 1,
      },
    ),

    // Scores only; concurrency 1 because it already fans out internally and a
    // second overlapping tick would just refetch the same leagues.
    new Worker(QUEUES.live, () => syncLiveScores(), { connection, concurrency: 1 }),

    // Concurrency 1: these responses are large and the point is to stagger them.
    new Worker(QUEUES.plays, () => syncPlays(), { connection, concurrency: 1 }),

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
