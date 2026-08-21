import { config } from '@genre/config';
import { sql } from '@genre/db';
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
  /** Fixture ingestion from the sports providers. */
  sync: 'sync',
  /** Ticks every 30s and asks "what crosses a reminder threshold right now?" */
  scan: 'reminder-scan',
  /** One job per (event, offset). Pages followers into batch jobs. */
  fanout: 'reminder-fanout',
  /** One job per page of followers. Claims and sends. */
  batch: 'reminder-batch',
  /** Refreshes scores for whatever is being played right now. */
  live: 'live-scores',
  /** Pulls play-by-play for games in progress. */
  plays: 'live-plays',
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
  for (const q of [queues.scan, queues.sync, queues.live, queues.plays]) {
    for (const r of await q.getRepeatableJobs()) await q.removeRepeatableByKey(r.key);
  }

  // A 1-minute reminder needs sub-minute resolution to land on time.
  await queues.scan.add('scan', {}, { repeat: { every: 30_000 }, jobId: 'scan' });

  // Scores. Only leagues with a game actually in progress are fetched, so this is
  // a handful of requests a minute rather than a sweep -- without it a live score
  // is as stale as the last full sync, which was measured at 69 minutes.
  await queues.live.add('live-scores', {}, { repeat: { every: 60_000 }, jobId: 'live' });

  // Slower than scores on purpose: a summary is ~500KB against a scoreboard's few
  // KB, and every one goes through the metered proxy.
  await queues.plays.add('live-plays', {}, { repeat: { every: 120_000 }, jobId: 'plays' });

  // Tonight and tomorrow, for the leagues that actually have a game then. Measured
  // 2026-08-21: 74 of 359 leagues, one request each without the roster -- about a
  // tenth of a full sweep, so it can run often enough to catch a postponement or a
  // late broadcast assignment hours before kickoff rather than at the next sweep.
  await queues.sync.add('sync-near', { kind: 'near' }, { repeat: { every: 3 * 3600_000 } });

  // The whole catalogue and the full horizon, once a day. This is the expensive one
  // -- two requests per league across 359 leagues -- and what it uniquely covers
  // (rosters, display names, fixtures beyond the near window) moves on a scale of
  // days, not hours. It ran every 6h before the near pass existed to carry the
  // freshness that was really being paid for.
  await queues.sync.add('sync-all', { kind: 'all' }, { repeat: { every: 24 * 3600_000 } });
  await queues.sync.add(
    'sync-catalogue',
    { kind: 'catalogue' },
    { repeat: { every: 24 * 3600_000 } },
  );

  // Two problems solved by the same check.
  //
  // First, a repeatable job runs one interval from NOW, not immediately -- so a
  // fresh database would serve an empty calendar for a full day.
  //
  // Second, and less obvious: clearing and re-adding the repeatables above resets
  // their timers, so on a day of frequent deploys the six-hour sync is pushed six
  // hours into the future every time and never actually fires.
  //
  // So the trigger is data staleness rather than a fresh timer, which is
  // self-correcting in both cases and idles harmlessly when the data is current.
  const [cat] = await sql`
    select count(*)::int as leagues,
           max(created_at) as newest
    from leagues
  `;
  // NOT events.updated_at, which was the obvious choice and is useless: the
  // live-scores tick writes that column every 60 seconds, so "when were the events
  // last touched" is always about a minute ago and the sweep is never stale. Between
  // that and the repeatable's timer restarting on every boot, the full fixture sweep
  // stopped running altogether on a day of frequent deploys -- the exact failure the
  // staleness check was added to prevent, reached from a different direction.
  //
  // rosters_synced_at is stamped only at the end of a full sync of that league, so
  // it means what this check needs it to mean.
  const [ev] = await sql`select max(rosters_synced_at) as synced from leagues where active`;

  const staleBy = (ts, ms) => !ts || Date.now() - new Date(ts).getTime() > ms;

  if (staleBy(cat.newest, 24 * 3600_000) || cat.leagues === 0) {
    log('[queue] catalogue stale, refreshing now');
    await queues.sync.add(
      'sync-catalogue',
      { kind: 'catalogue' },
      { jobId: `seed-cat-${dayStamp()}` },
    );
  }
  // Display names only arrive with a fixture sweep, so a catalogue that has never
  // been swept shows raw slugs however fresh its fixtures are.
  const unnamed = await q.leaguesMissingRealName();
  // Rosters arrived after the first sweeps, so an existing catalogue has fixtures
  // but only the clubs that happened to be playing. One backfill, then never again.
  const rosterless = await q.leaguesMissingRosters();

  const stale = staleBy(ev.synced, config.sync.staleHours * 3600_000);
  const forced = config.sync.onBoot;

  if (stale || forced || unnamed > 0 || rosterless > 0) {
    /**
     * The job id has to describe WHY we are syncing, not just when.
     *
     * An hour bucket alone deduplicates against any sync already run in that hour
     * -- including one that ran before the code which created the new backfill
     * need. That is exactly what happened with rosters: the boot logged "syncing
     * now, rosterless: 354", BullMQ matched the id of the completed fixtures-only
     * sync from earlier the same hour, and the backfill silently never ran.
     *
     * Including the outstanding counts means a genuinely new backfill gets a new
     * id, while several instances booting together still collapse onto one job --
     * which is all the bucket was ever for. The counts shrink to zero as the work
     * lands, so this settles rather than looping.
     */
    /**
     * Backfills bucket by MINUTE, not by their outstanding counts.
     *
     * Keying on the counts looked like it described the need, but successive
     * backfills reset the same leagues and so produced a byte-identical id --
     * `u0-r354` twice running. BullMQ matched the completed job and skipped the
     * second: the same silent no-op the hour bucket caused, reached from a
     * different direction. Twice now, so the lesson is that a job id must not be
     * derived from state the work itself resets.
     *
     * A minute bucket still collapses a boot storm across instances, which is all
     * the deduplication was ever for, and can never block a later backfill. The
     * routine sweep keeps its hour bucket: that one genuinely is periodic.
     */
    // A forced sweep buckets by minute like a backfill does: its whole purpose is to
    // run now, and an hour bucket would match a sweep already done this hour and
    // silently skip the one that was asked for.
    const reason =
      forced || rosterless > 0 || unnamed > 0
        ? `backfill-${minuteStamp()}`
        : `seed-all-${hourStamp()}`;

    log(
      `[queue] syncing now (stale: ${stale}, forced: ${forced}, unnamed: ${unnamed}, rosterless: ${rosterless})`,
    );
    await queues.sync.add('sync-all', { kind: 'all' }, { jobId: reason, delay: 20_000 });
  }

  // The near window always gets one pass on boot, for the same reason the sweep has
  // a staleness check: a repeatable first fires one interval from NOW, so without
  // this every deploy leaves tonight's fixtures unrefreshed for three hours. It is
  // unconditional because it is cheap -- one request for each league with a game in
  // the next two days, measured at 74 -- and because "was it recently enough" is
  // exactly the reasoning that let the sweep stop running twice already. Bucketed
  // by hour so a boot storm collapses onto one job.
  await queues.sync.add(
    'sync-near',
    { kind: 'near' },
    { jobId: `seed-near-${hourStamp()}`, delay: 30_000 },
  );

  log('[queue] schedules installed');
}

/* Job ids are bucketed by time so that several instances booting together -- or one
   instance restarting twice in a minute -- enqueue the same job rather than one each.
   Separated by '-' and never ':' -- see the note on job ids in workers.js. */
const dayStamp = () => new Date().toISOString().slice(0, 10);
const hourStamp = () => new Date().toISOString().slice(0, 13);
const minuteStamp = () => new Date().toISOString().slice(0, 16).replace(':', '-');

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await connection.quit();
}
