import * as q from '@genre/db/queries';
import { openLegacy, seal } from './secretbox.js';
import { legacyMigrationEnabled, playlistKeyFor, setVaultOwners } from './vault.js';

/**
 * The one-shot move from the old server key (v1) to the reader's vault (v2).
 *
 * Runs right after the reader unlocks, the only time this process can seal for
 * them. Each value is opened with PLAYLIST_SECRET, sealed with their key and
 * written back over the old one, matched on the old value so a concurrent edit
 * wins. Nothing is deleted: a value that will not open stays as it is and is
 * counted. LEGACY_KEY_MIGRATION=off stops it (the cutoff).
 *
 * Addresses and lines are done before the response; channel URLs (hundreds of
 * thousands on a big catalogue) continue in batches in the background.
 */
export async function migrateLegacyFor(userId, { log = console.log } = {}) {
  const result = { migrated: 0, failed: 0, remaining: 0, channels: 'none' };
  if (!playlistKeyFor(userId)) return result;
  const { playlists, lines } = await q.legacySealedFor(userId);
  const enabled = legacyMigrationEnabled();

  for (const row of playlists) {
    const plain = enabled ? openLegacy(row.source_url) : null;
    if (plain == null) {
      result.failed += enabled ? 1 : 0;
      result.remaining++;
      continue;
    }
    await q.resealPlaylistSource({
      userId,
      playlistId: row.id,
      before: row.source_url,
      after: seal(plain, userId),
    });
    result.migrated++;
  }

  for (const line of lines) {
    const reseal = (v) => {
      if (!String(v ?? '').startsWith('v1.')) return v;
      const plain = enabled ? openLegacy(v) : null;
      if (plain == null) throw new Error('unreadable');
      return seal(plain, userId);
    };
    try {
      await q.resealProviderLine({
        userId,
        lineUser: reseal(line.line_user),
        lineSecret: reseal(line.line_secret),
        sourceUrl: reseal(line.source_url),
      });
      result.migrated++;
    } catch {
      result.failed += enabled ? 1 : 0;
      result.remaining++;
    }
  }

  if (enabled) {
    result.channels = 'started';
    migrateChannels(userId, log).catch((err) =>
      log(`[vault] channel re-seal for ${userId} stopped: ${err.message}`),
    );
  }
  return result;
}

/** Background: re-seal channel URLs in batches while the reader stays unlocked. */
export async function migrateChannels(userId, log = console.log) {
  let afterId = 0;
  let done = 0;
  for (;;) {
    if (!playlistKeyFor(userId)) break; // locked again: the next unlock resumes
    const batch = await q.legacyChannelBatch({ userId, afterId, limit: 2000 });
    if (batch.length === 0) break;
    const rows = [];
    for (const row of batch) {
      const plain = openLegacy(row.stream_url);
      if (plain != null) rows.push({ id: row.id, url: seal(plain, userId) });
    }
    await q.resealChannels(rows);
    done += rows.length;
    afterId = batch[batch.length - 1].id;
    await new Promise((r) => setTimeout(r, 25)); // let requests through
  }
  if (done) log(`[vault] re-sealed ${done} channel URLs for ${userId}`);
  return done;
}

/**
 * Keep this process's set of vault owners current (vault.js usesLegacyKey). A
 * failed read keeps the last set; a vault made in another process shows up
 * within a minute, and its owner's first unlock re-seals anything written v1.
 */
export async function startVaultOwnerSync({ everyMs = 60_000, log = console.error } = {}) {
  const load = async () => {
    try {
      setVaultOwners(await q.vaultOwnerIds());
    } catch (err) {
      log(`[vault] could not read vault owners: ${err?.message ?? err}`);
    }
  };
  await load();
  const timer = setInterval(load, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
