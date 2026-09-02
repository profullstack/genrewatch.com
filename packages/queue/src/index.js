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
  /** Re-fetches readers' own channel lists from their providers. */
  playlists: 'playlist-refresh',
  /**
   * Walks IMDb's daily dumps and fills in what the five providers never mentioned.
   *
   * Its own queue rather than a job kind on `sync`, because it is long, bounded by
   * wall clock, and must not sit in front of a catalogue sweep that has a
   * rate-limited provider waiting behind it.
   */
  imdb: 'imdb-backfill',
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
  for (const queue of [queues.scan, queues.sync, queues.playlists, queues.imdb]) {
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
   * Home-release dates, four-hourly.
   *
   * Slower than detail on purpose. A studio announces a digital date on the scale
   * of weeks, and the pass re-asks each film only once its stamp has gone stale,
   * so running it more often would find the same nulls and spend a budget that
   * buys nothing. Four hours is frequent enough that a date announced this morning
   * is on the site today, which is the only deadline that matters.
   */
  await queues.sync.add('digital', { kind: 'digital' }, { repeat: { every: 4 * 3600_000 } });

  /*
   * Artwork for the IMDb rows, every twenty minutes.
   *
   * The most frequent of the three because it has the largest backlog and the
   * most visible symptom: about a thousand upcoming titles showing a name and a
   * year. At 120 a pass it drains in a few hours and then idles, because a title
   * is stamped whether or not TMDB had anything.
   */
  await queues.sync.add('imdb-meta', { kind: 'imdb-meta' }, { repeat: { every: 20 * 60_000 } });

  /*
   * Readers' own channel lists, on their own clock.
   *
   * Not folded into the sync tick: this polls other people's subscriptions rather
   * than our providers, it runs far more often, and the interval is an env var
   * precisely so it can be raised without a deploy if a provider objects. The
   * per-list schedule lives in the database (refresh_after), so this tick only
   * asks "is anything due" -- which is why re-adding it on every boot is harmless
   * here in a way the trap below describes for the catalogue sweep.
   */
  await queues.playlists.add(
    'playlists',
    {},
    { repeat: { every: config.playlists.refreshMinutes * 60_000 }, jobId: 'playlists' },
  );

  /*
   * The IMDb backfill, nightly, on its own clock.
   *
   * A different kind of job from the sync tick and it must not ride on one. The
   * dumps are rebuilt once a day, so asking more often than that is pure transfer
   * for no new rows; and a pass is bounded by a wall-clock deadline and resumable
   * from a cursor, so "nightly" means "another slice each night" until the first
   * full walk is done rather than "the whole thing or nothing".
   *
   * Six-hourly rather than daily on the repeatable, and deliberately: a repeatable
   * fires one interval from NOW and is reset by every deploy (the trap below), so a
   * daily one on a busy week may never fire at all. The pass itself is what
   * enforces the cadence -- it reads its own progress row and returns immediately
   * if a pass completed within the day.
   */
  await queues.imdb.add('imdb', {}, { repeat: { every: 6 * 3600_000 }, jobId: 'imdb' });

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

  // And one home-release pass on boot, for the same reason and behind detail, so
  // the two budgeted passes do not open on the same second.
  await queues.sync.add(
    'digital',
    { kind: 'digital' },
    { jobId: `digital-${minuteStamp()}`, delay: 40_000 },
  );

  // And the IMDb artwork pass, last of the three, for the same reason.
  await queues.sync.add(
    'imdb-meta',
    { kind: 'imdb-meta' },
    { jobId: `imdbmeta-${minuteStamp()}`, delay: 55_000 },
  );

  /*
   * And one IMDb pass on boot, for the same reason.
   *
   * A repeatable first fires one interval from NOW, so without this a fresh
   * deployment waits six hours before the backfill starts -- and on a day of
   * frequent deploys it is pushed forward every time and may never run at all.
   * That is trap 4 from the sibling repo, reached from the other direction.
   *
   * Safe to enqueue unconditionally because the WORKER decides whether to do
   * anything: it reads the progress row and returns immediately when a full pass
   * completed within the day. The delay lets the web role finish booting first --
   * the pass streams a couple of hundred megabytes and there is no reason for it
   * to compete with the first requests after a deploy.
   */
  await queues.imdb.add('imdb', {}, { jobId: `imdb-${minuteStamp()}`, delay: 90_000 });

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
