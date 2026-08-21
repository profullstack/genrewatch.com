import { config } from '@genre/config';
import { SQL } from 'bun';

/**
 * One pool per process. Bun's native Postgres client is used directly rather than
 * `pg` so the container ships one runtime and no native addons.
 *
 * `max` matters more than it looks: every BullMQ worker concurrency slot can hold a
 * connection, so the pool ceiling and the worker concurrency have to be chosen
 * together or the workers starve each other mid-fan-out.
 */
export const sql = new SQL({
  url: config.databaseUrl,
  max: Number(process.env.DB_POOL_MAX ?? 12),
  idleTimeout: 30,
  connectionTimeout: 15,
  // Railway's Postgres proxy terminates TLS but presents a cert for its own host.
  tls: config.databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});

export async function healthcheck() {
  const [row] = await sql`select 1 as ok`;
  return row?.ok === 1;
}

export async function close() {
  await sql.end();
}
