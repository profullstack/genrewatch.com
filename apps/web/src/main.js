import { config } from '@genre/config';
import { close as closeDb, healthcheck } from '@genre/db';
import { migrate } from '@genre/db/migrate';
import { closeQueues, installSchedules } from '@genre/queue';
import { startWorkers } from '@genre/queue/workers';
import { app } from './app.js';

/**
 * One process, one container, one Railway service.
 *
 * ROLES decides what this instance actually runs. It defaults to "web,worker" so a
 * single service does everything; splitting the workers onto their own instance
 * later is a variable change rather than a rebuild.
 */

// Fail at boot rather than at checkout if the CoinPay credential is the wrong family.

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
if (config.roles.includes('web')) {
  // Railway injects PORT. Never hardcode it: a fixed port leaves the edge proxy
  // forwarding to a closed socket and every request 404s while the container
  // still reports healthy.
  server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 30 });
  console.log(`[web] listening on :${server.port} as ${config.roles.join('+')}`);
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
