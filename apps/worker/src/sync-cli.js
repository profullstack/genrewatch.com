/**
 * Manual fixture sync. `bun run sync` for the whole catalogue, `--catalogue` to
 * refresh only the league list. Used to seed a fresh database before the first
 * scheduled run, and to reproduce an ingestion bug without waiting six hours.
 */
import { close } from '@genre/db';
import { migrate } from '@genre/db/migrate';
import { syncAll, syncCatalogue } from '@genre/catalog';

await migrate();
if (process.argv.includes('--catalogue')) await syncCatalogue();
else {
  await syncCatalogue();
  await syncAll();
}
await close();
