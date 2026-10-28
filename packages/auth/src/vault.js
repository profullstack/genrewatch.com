import { hkdfSync } from 'node:crypto';
import {
  base64ToBytes,
  createSealer,
  isSealRecord,
  parseTtl,
  UNLOCK_DEFAULT_TTL_SECONDS,
  UnlockStore,
  wipe,
} from '@profullstack/sealed-secrets';

/**
 * The reader's key vault for their provider logins.
 *
 * A playlist address carries the reader's provider username and password. It used
 * to be sealed under PLAYLIST_SECRET, which fell back to DATABASE_URL: a key the
 * server holds around the clock, so anyone with the box had every login. Now each
 * reader sets a passphrase in the browser (PBKDF2 600k -> HKDF -> AES-256-GCM,
 * @profullstack/sealed-secrets, plus a recovery key shown once). The server keeps
 * the sealed record and nothing that opens it.
 *
 * To play, refresh or probe, the browser sends the derived data key (never the
 * passphrase). From it this process derives the reader's playlist key and keeps
 * only that, in memory, for the time they chose (8h default, 7 days at most). A
 * restart forgets it: their lists wait, saying so, until they unlock again.
 */

export const VAULT_APP = 'genrewatch';
export const sealer = createSealer({ app: VAULT_APP, scope: 'playlists' });
export const LOST_PASSPHRASE =
  'If you lose both your passphrase and your recovery key, your stored playlist addresses are gone for good: nobody here can open them, and you would add your lists again.';

const STORE = Symbol.for(`${VAULT_APP}.vault.unlockStore`);
export function unlockStore() {
  if (!globalThis[STORE]) globalThis[STORE] = new UnlockStore();
  return globalThis[STORE];
}
export function resetUnlockStoreForTests() {
  globalThis[STORE]?.lockAll();
  delete globalThis[STORE];
}

const MESSAGES = {
  vault_missing:
    'Set up your key vault first (Settings, Key vault). Playlist addresses are sealed with a passphrase only you know.',
  vault_locked: 'Your key vault is locked. Unlock it in Settings to play and refresh your lists.',
  legacy_unmigrated:
    'This list was saved before the key vault existed. Unlock your vault in Settings once to re-seal it.',
};

export class VaultLockedError extends Error {
  constructor(code = 'vault_locked', message) {
    super(message || MESSAGES[code] || MESSAGES.vault_locked);
    this.name = 'VaultLockedError';
    this.code = code;
    this.status = 423;
  }
}
export const isVaultLocked = (err) =>
  err instanceof VaultLockedError || err?.name === 'VaultLockedError';

/** The reader's playlist key: derived from their data key, bound to them. */
export function derivePlaylistKey(dek, userId) {
  return Buffer.from(
    hkdfSync('sha256', dek, Buffer.from(String(userId)), `${VAULT_APP}/playlist/v2`, 32),
  );
}

/** The reader's playlist key while unlocked, else null. Never store it anywhere. */
export function playlistKeyFor(userId) {
  return userId ? unlockStore().get(String(userId)) : null;
}

export function ttlSeconds(value) {
  if (value === undefined || value === null || value === '') return UNLOCK_DEFAULT_TTL_SECONDS;
  return parseTtl(String(value));
}

/**
 * Check a data key from the browser against the stored seal, then keep only the
 * derived playlist key. The data key itself is wiped before this returns.
 */
export async function unlockWithDataKey(userId, seal, dekBase64, ttl) {
  if (!isSealRecord(seal)) throw new VaultLockedError('vault_missing');
  const dek = base64ToBytes(String(dekBase64 || ''));
  try {
    if (dek.length !== 32 || !(await sealer.verifyDataKey(dek, seal, String(userId)))) {
      throw Object.assign(new Error('That passphrase does not open your vault.'), { status: 403 });
    }
    const key = derivePlaylistKey(dek, userId);
    const status = unlockStore().unlock(String(userId), key, ttl);
    key.fill(0);
    return status;
  } finally {
    wipe(dek);
  }
}

/** A worker process adopting a key the web process handed it for one job. */
export function adoptPlaylistKey(userId, keyBytes, ttlSecondsLeft) {
  unlockStore().unlock(
    String(userId),
    keyBytes,
    Math.max(60, Math.min(ttlSecondsLeft || 600, 600)),
  );
}

export function legacyMigrationEnabled(env = process.env) {
  return (
    String(env.LEGACY_KEY_MIGRATION ?? 'on')
      .trim()
      .toLowerCase() !== 'off'
  );
}

/**
 * Split deployments: the worker process refreshes lists but the unlock lives in
 * the web process. Before a job it asks the web process, over the private
 * network, for that reader's playlist key (only while they are unlocked) and
 * keeps it for at most ten minutes. Nothing is asked for a locked reader.
 */
export async function ensurePlaylistKey(userId, env = process.env) {
  if (playlistKeyFor(userId)) return true;
  const base = env.VAULT_INTERNAL_URL;
  const token = env.VAULT_INTERNAL_TOKEN;
  if (!base || !token) return false;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/internal/vault/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify({ userId: String(userId) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const { key, ttl } = await res.json();
    const bytes = Buffer.from(String(key), 'base64');
    if (bytes.length !== 32) return false;
    adoptPlaylistKey(userId, bytes, Number(ttl) || 600);
    bytes.fill(0);
    return true;
  } catch {
    return false;
  }
}

export { isSealRecord as isSealRecordValue } from '@profullstack/sealed-secrets';

/** Passphrase change: the data key must open the old record and the new one. */
export async function verifyRewrap(userId, current, next, dekBase64) {
  const dek = base64ToBytes(String(dekBase64 || ''));
  try {
    return (
      dek.length === 32 &&
      (await sealer.verifyDataKey(dek, current, String(userId))) &&
      (await sealer.verifyDataKey(dek, next, String(userId)))
    );
  } finally {
    wipe(dek);
  }
}
export { bytesToBase64 } from '@profullstack/sealed-secrets';
