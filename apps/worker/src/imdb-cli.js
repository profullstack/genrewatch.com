/**
 * Run the IMDb backfill by hand.
 *
 * `bun run imdb` walks the dump from wherever the last pass stopped and writes
 * until its deadline; `--deadline=60` gives it sixty seconds instead of the
 * configured fifteen minutes, which is how you watch it work without waiting for
 * a quarter of an hour. `--restart` clears the cursor and starts from the top.
 *
 * Used to seed a fresh database, and to reproduce an ingestion problem without
 * waiting for the nightly tick. It is safe to run against production: every write
 * is an upsert keyed on (provider, provider_key), and a pass that is killed
 * halfway leaves a cursor rather than a mess.
 */
import { syncImdb } from '@genre/catalog';
import { close } from '@genre/db';
import { migrate } from '@genre/db/migrate';
import * as q from '@genre/db/queries';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

await migrate();

if (process.argv.includes('--restart')) {
  await q.finishImdbPass({
    cursor: null,
    completed: false,
    seen: 0,
    linked: 0,
    created: 0,
    note: 'restarted by hand',
  });
  console.log('[imdb] cursor cleared; the next pass starts from the top');
}

const seconds = Number(arg('deadline'));
const result = await syncImdb(
  Number.isFinite(seconds) && seconds > 0 ? { deadlineMs: seconds * 1000 } : {},
);
console.log(result);

const progress = await q.imdbProgress();
if (progress?.cursor) {
  console.log(`[imdb] more to do; the next pass resumes after ${progress.cursor}`);
}

await close();
