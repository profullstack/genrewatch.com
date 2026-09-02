import { assertCoinpayMerchantKey, config } from '@genre/config';
import { close as closeDb, healthcheck, sql } from '@genre/db';
import { migrate } from '@genre/db/migrate';
import { configurePayments } from '@genre/payments';
import { closeQueues, connection, installSchedules } from '@genre/queue';
import { startWorkers } from '@genre/queue/workers';
import { app } from './app.js';

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

/**
 * One process, one container, one Railway service.
 *
 * ROLES decides what this instance actually runs. It defaults to "web,worker" so a
 * single service does everything; splitting the workers onto their own instance
 * later is a variable change rather than a rebuild.
 */

// Fail at boot rather than at checkout if the CoinPay credential is the wrong family.
// The comment came across with the clone and the call did not, so for the whole
// life of this repo it asserted nothing.
assertCoinpayMerchantKey();

/**
 * Turn an infrastructure failure into a sentence someone can act on.
 *
 * A container that cannot reach Postgres dies with `ERR_POSTGRES_CONNECTION_CLOSED`
 * and a stack trace inside Bun's driver. That is indistinguishable from a bug in
 * this app, and the actual cause is nearly always a variable that was never set on
 * the service — which the deploy log should say outright rather than making someone
 * infer it from a driver internal.
 */
async function preflight(what, fn) {
  try {
    return await fn();
  } catch (err) {
    const target = what === 'postgres' ? config.databaseUrl : config.redisUrl;
    // Host only — a connection string carries the password.
    let host = 'unparseable';
    try {
      host = new URL(target).host;
    } catch {}
    console.error(
      `[boot] cannot reach ${what} at ${host}: ${err?.message ?? err}\n` +
        `[boot] check the ${what === 'postgres' ? 'DATABASE_URL' : 'REDIS_URL'} variable on this service ` +
        `(Railway does not share variables between services — a datastore in another project is not reachable).`,
    );
    throw err;
  }
}

// Migrations apply themselves. An advisory lock inside makes this safe when the web
// and worker roles boot at the same moment.
await preflight('postgres', () => migrate());

if (!(await healthcheck())) throw new Error('database healthcheck failed at boot');

let workers = [];
if (config.roles.includes('worker')) {
  await preflight('redis', () => installSchedules());
  workers = startWorkers();
}

let server;
/**
 * Drop the rendered page cache on boot.
 *
 * Read pages are cached in Redis for 60-900 seconds and served byte-identical to
 * every signed-out visitor -- which means a deploy that changes MARKUP keeps
 * serving the old markup until each key expires. Shipping a new header and then
 * watching the old one come back on the feeds page for a quarter of an hour is
 * indistinguishable from the deploy not having worked.
 *
 * The sync worker already evicts after it writes; this is the same fix for the
 * other way pages go stale. SCAN rather than KEYS, because this Redis also carries
 * the delivery queues and KEYS blocks the server for the length of the keyspace.
 * Failing is harmless -- the TTL is still there as a backstop -- so a Redis blip
 * must not stop the container from booting.
 */
async function dropPageCache() {
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
    console.warn(`[boot] page cache not cleared: ${err?.message ?? err}`);
    return;
  }
  if (dropped) console.log(`[boot] cleared ${dropped} cached page(s)`);
}

if (config.roles.includes('web')) {
  await dropPageCache();

  // Railway injects PORT. Never hardcode it: a fixed port leaves the edge proxy
  // forwarding to a closed socket and every request 404s while the container
  // still reports healthy.
  server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 30 });
  console.log(`[web] listening on :${server.port} as ${config.roles.join('+')}`);
} else {
  /*
   * A worker-only service still has to answer the healthcheck.
   *
   * `railway.json` sets `healthcheckPath: /healthz` for every service built from
   * this repo, and Railway's config-as-code wins over anything set per service.
   * So a container running ROLES=worker with no listener never answers, the
   * deploy waits out its timeout and is marked failed -- and the split that was
   * supposed to be "a variable change, not a code change" cannot be made at all.
   *
   * This is not the web app: no routes, no page cache, no database work on the
   * path. It answers /healthz and nothing else, which is exactly what the probe
   * asks and gives the worker the liveness signal it otherwise has none of.
   */
  server = Bun.serve({
    port: config.port,
    idleTimeout: 30,
    fetch: (req) =>
      new URL(req.url).pathname === '/healthz'
        ? new Response('ok')
        : new Response('not found', { status: 404 }),
  });
  console.log(`[worker] healthcheck on :${server.port} as ${config.roles.join('+')}`);
}

async function shutdown(signal) {
  console.log(`[main] ${signal}, draining`);
  // Stop taking new work before closing the pool, so an in-flight fan-out finishes
  // its claim rather than half-sending a batch.
  await Promise.allSettled([server?.stop(true), ...workers.map((w) => w.close())]);
  await Promise.allSettled([closeQueues(), closeDb()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
