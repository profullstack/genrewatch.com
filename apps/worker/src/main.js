/**
 * Workers on their own, for when one instance stops being enough.
 *
 * The default deployment runs web and workers in a single container via apps/web;
 * this entry exists so that splitting them is a Railway variable change and a
 * different start command, with no code to rewrite.
 */
import { close as closeDb } from '@genre/db';
import { migrate } from '@genre/db/migrate';
import { closeQueues, installSchedules } from '@genre/queue';
import { startWorkers } from '@genre/queue/workers';

await migrate();
await installSchedules();
const workers = startWorkers();

async function shutdown(signal) {
  console.log(`[worker] ${signal}, draining`);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([closeQueues(), closeDb()]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
