import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  legacyMigrationEnabled,
  playlistKeyFor,
  usesLegacyKey,
  VaultLockedError,
} from './vault.js';

/**
 * Sealing a reader's provider logins (playlist addresses, channel URLs, live-pass
 * lines) under THEIR key vault (./vault.js).
 *
 * v2.<iv>.<tag>.<ciphertext>, AES-256-GCM under the reader's playlist key, with
 * their user id as AAD so a value copied onto another reader does not open.
 * Sealing and opening both need the owner unlocked; otherwise they throw
 * VaultLockedError (423) and whatever needed the line waits.
 *
 * v1 values (PLAYLIST_SECRET, a key the server holds 24/7) stay readable while
 * LEGACY_KEY_MIGRATION is on, and a reader with no vault yet keeps writing v1:
 * locking them out of their own lists until they made a vault broke the site.
 * Creating the vault (the first unlock) re-seals everything to v2, and from then
 * on new values are v2 only. There is no DATABASE_URL fallback any more.
 */

const V2 = 'v2';
const V1 = 'v1';

function keyOrThrow(ownerId) {
  const key = playlistKeyFor(ownerId);
  if (!key) throw new VaultLockedError('vault_locked');
  return key;
}

/** @param {string} plaintext @param {string} ownerId */
export function seal(plaintext, ownerId) {
  if (!ownerId) throw new Error('seal needs the owner');
  if (usesLegacyKey(ownerId)) return sealLegacy(plaintext);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOrThrow(ownerId), iv);
  cipher.setAAD(Buffer.from(String(ownerId)));
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [
    V2,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/**
 * @returns {string|null} null when malformed or tampered with. Throws
 *   VaultLockedError while the owner is locked, or for a v1 (legacy) value once
 *   LEGACY_KEY_MIGRATION is off.
 */
export function open(sealed, ownerId) {
  const [v, iv, tag, body] = String(sealed ?? '').split('.');
  if (v === V1) {
    if (!legacyMigrationEnabled() || !process.env.PLAYLIST_SECRET)
      throw new VaultLockedError('legacy_unmigrated');
    return openLegacy(sealed);
  }
  if (v !== V2 || !iv || !tag || !body) return null;
  const key = keyOrThrow(ownerId);
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(String(ownerId)));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Like open, but a locked owner reads as `{ locked: true }` instead of throwing. */
export function openOrLocked(sealed, ownerId) {
  try {
    return { value: open(sealed, ownerId), locked: false };
  } catch (err) {
    if (err?.name === 'VaultLockedError') return { value: null, locked: true, code: err.code };
    throw err;
  }
}

export const isLegacySealed = (sealed) => String(sealed ?? '').startsWith(`${V1}.`);

/**
 * Open a v1 value for the migration only. PLAYLIST_SECRET must be set; the old
 * DATABASE_URL fallback is gone. LEGACY_KEY_MIGRATION=off is the cutoff.
 */
const legacyKey = (secret) =>
  createHash('sha256').update(`genrewatch/playlist/v1:${secret}`).digest();

/** Seal under the legacy key: only for a reader who has no vault yet. */
function sealLegacy(plaintext, env = process.env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', legacyKey(env.PLAYLIST_SECRET), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [
    V1,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

export function openLegacy(sealed, env = process.env) {
  if (!legacyMigrationEnabled(env)) return null;
  const secret = env.PLAYLIST_SECRET;
  if (!secret) return null;
  const key = legacyKey(secret);
  try {
    const [v, iv, tag, body] = String(sealed).split('.');
    if (v !== V1 || !iv || !tag || !body) return null;
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
