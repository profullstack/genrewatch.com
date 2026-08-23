import { config } from '@genre/config';
/**
 * Workers on their own, for when one instance stops being enough.
 *
 * The default deployment runs web and workers in a single container via apps/web;
 * this entry exists so that splitting them is a Railway variable change and a
 * different start command, with no code to rewrite.
 */
import { close as closeDb, sql } from '@genre/db';
import { migrate } from '@genre/db/migrate';
import { configurePayments } from '@genre/payments';
import { closeQueues, installSchedules } from '@genre/queue';
import { startWorkers } from '@genre/queue/workers';

/*
 * Hand the payments package its database handle and settings.
 *
 * It imports nothing from this brand -- that is what lets the same file live in
 * both siblings unchanged -- so it has to be given `sql` and the CoinPay block
 * once, here, before anything can take money. The coinpay object is passed whole
 * rather than unpacked: its keys are getters that read the environment on every
 * access, and snapshotting them is the bug their comment in config warns about.
 */
configurePayments({ sql, coinpay: config.coinpay, siteUrl: config.siteUrl });

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
