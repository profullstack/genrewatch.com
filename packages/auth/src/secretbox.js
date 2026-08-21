import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '@genre/config';

/**
 * Symmetric encryption for values we must store but must never be able to leak
 * casually -- currently a user's own playlist URL, which carries their provider
 * credentials in its path.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than returning
 * plausible garbage. The nonce is random per value and stored alongside; reusing a
 * nonce under one key is the mistake that breaks GCM outright, so it is never
 * derived from the plaintext or a counter.
 *
 * This is encryption at rest, not a password scheme. It protects against a database
 * dump, a log line and a backup -- not against someone who already has the running
 * process's environment, who by definition has the key too.
 */

const VERSION = 'v1';

/**
 * The key is hashed rather than used raw so any length of secret works.
 *
 * Read on use rather than at import, matching the CoinPay keys: snapshotting made
 * the value depend on which module imported config first.
 */
function key() {
  const secret = config.playlists.secret;
  if (!secret) throw new Error('PLAYLIST_SECRET is not set');
  return createHash('sha256').update(secret).digest();
}

/** @param {string} plaintext @returns {string} `v1.<iv>.<tag>.<ciphertext>`, base64url */
export function seal(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/**
 * @param {string} sealed
 * @returns {string|null} null when the value is malformed, from another key, or
 *   tampered with -- callers treat that as "this credential is gone", which is the
 *   only safe reading and is exactly what happens if PLAYLIST_SECRET is rotated.
 */
export function open(sealed) {
  try {
    const [v, iv, tag, body] = String(sealed).split('.');
    if (v !== VERSION || !iv || !tag || !body) return null;
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
