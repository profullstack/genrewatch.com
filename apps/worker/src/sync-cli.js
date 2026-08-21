/**
 * Manual catalogue sync.
 *
 * `bun run sync` walks every enabled provider, respecting each one's minimum
 * interval; `--force` ignores those intervals, and `--only=tvmaze` (or a category
 * name) runs one adapter. Used to seed a fresh database before the first scheduled
 * pass, and to reproduce an ingestion bug without waiting for the tick.
 *
 * --force is not a no-op convenience flag. TheSpaceDevs allows fifteen requests an
 * hour for the whole deployment, so forcing that adapter repeatedly is how you get
 * the space category rate limited for the rest of the hour.
 */
import { syncAll } from '@genre/catalog';
import { close } from '@genre/db';
import { migrate } from '@genre/db/migrate';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

await migrate();
await syncAll({ force: process.argv.includes('--force'), only: arg('only') });
await close();
