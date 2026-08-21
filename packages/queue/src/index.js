import { anythingStale } from '@genre/catalog';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on, or
 * a blocking read that outlives the retry budget kills the worker. Sharing one
 * connection object across queues keeps the socket count flat as queues are added.
 */
export const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const QUEUES = {
  /** Catalogue ingestion from the five genre providers. */
  sync: 'sync',
  /** Ticks every 30s and asks "what crosses a reminder threshold right now?" */
  scan: 'reminder-scan',
  /** One job per (event, offset). Pages followers into batch jobs. */
  fanout: 'reminder-fanout',
  /** One job per page of followers. Claims and sends. */
  batch: 'reminder-batch',
};

const defaults = {
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 86400 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
};

export const queues = Object.fromEntries(
  Object.entries(QUEUES).map(([k, name]) => [
    k,
    new Queue(name, { connection, defaultJobOptions: defaults }),
  ]),
);

/**
 * Repeatable jobs are declared, not accumulated.
 *
 * BullMQ keys a repeatable by its pattern, so changing an interval leaves the old
 * schedule running forever unless the previous one is removed. Clearing them on
 * every boot makes the code the single source of truth for what is scheduled.
 */
export async function installSchedules({ log = console.log } = {}) {
  for (const queue of [queues.scan, queues.sync]) {
    for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
  }

  // A 1-minute reminder needs sub-minute resolution to land on time.
  await queues.scan.add('scan', {}, { repeat: { every: 30_000 }, jobId: 'scan' });

  /*
   * One repeatable for all five providers, hourly.
   *
   * The per-provider cadence is NOT expressed here. Each adapter declares its own
   * minimum interval and the orchestrator checks it against the last completed
   * pass, so this tick is just "consider syncing" -- TV accepts every third call,
   * spaceflight every one, music every twelfth. Encoding the cadences as five
   * repeatables instead would put the same numbers in two places and reset all of
   * them on every deploy, which is the trap below.
   */
  await queues.sync.add('sync-tick', { kind: 'tick' }, { repeat: { every: 3600_000 } });

  /*
   * Enrichment gets its own clock, because it is a different job.
   *
   * It used to run only at the tail of a catalogue pass, which meant it
   * inherited that pass's cadence AND its fragility: a repeatable fires one
   * interval from now, so a day of frequent deploys pushes the hourly tick
   * forever into the future and the detail pass simply never happens. That is
   * the trap this file already warns about, reached through a job that was
   * bolted onto the end of another one.
   *
   * It is also much cheaper -- a bounded number of requests against a provider
   * that tolerates fifty a second -- so there is no reason for it to wait on a
   * sweep that is deliberately slow.
   */
  await queues.sync.add('detail', { kind: 'detail' }, { repeat: { every: 30 * 60_000 } });

  /*
   * A repeatable first fires one interval from NOW, not immediately.
   *
   * Two problems, one check. A fresh database would serve an empty calendar for
   * an hour; and clearing and re-adding the repeatable above resets its timer, so
   * on a day of frequent deploys the hourly sync is pushed an hour into the
   * future every time and may never actually fire.
   *
   * So the trigger is data staleness rather than a fresh timer. It is
   * self-correcting in both cases and idles harmlessly when the data is current.
   * `anythingStale` reads synced_at, which only a COMPLETED pass writes -- never
   * events.updated_at, which every sync touches and would therefore always look
   * a minute old.
   */
  const stale = await anythingStale();
  const empty = (await q.catalogueStats()).upcoming === 0;

  /*
   * And one on boot, unconditionally.
   *
   * Unlike a catalogue sweep this is safe to run every time: it is budgeted, it
   * stamps what it touches, and it is a no-op once nothing is pending. Making it
   * conditional is what left it never running at all.
   */
  await queues.sync.add(
    'detail',
    { kind: 'detail' },
    { jobId: `detail-${minuteStamp()}`, delay: 25_000 },
  );

  if (stale || empty || config.sync.onBoot) {
    log(`[queue] syncing now (stale: ${stale}, empty: ${empty}, forced: ${config.sync.onBoot})`);
    /*
     * Bucketed by MINUTE, and never by anything the work itself resets.
     *
     * An hour bucket deduplicates against a sync already run this hour, including
     * one that ran before the code creating the new need -- which is how a
     * backfill can log "syncing now" and then silently match a completed job and
     * do nothing. A minute bucket still collapses a boot storm across instances,
     * which is all the deduplication was ever for, and can never block a later
     * pass.
     *
     * Separated by '-' and never ':' -- a BullMQ job id containing a colon is
     * parsed as a structured key and crashes at runtime, not at deploy.
     */
    await queues.sync.add(
      'sync-tick',
      { kind: 'tick', force: config.sync.onBoot },
      { jobId: `seed-${minuteStamp()}`, delay: 15_000 },
    );
  }

  log('[queue] schedules installed');
}

/* Job ids are bucketed by time so that several instances booting together -- or one
   instance restarting twice in a minute -- enqueue the same job rather than one each.
   Separated by '-' and never ':' -- see the note above. */
const minuteStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await connection.quit();
}
