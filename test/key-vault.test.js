import { describe, expect, test } from 'bun:test';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

/*
 * Provider logins are sealed under each reader's own key vault, and nothing the
 * server holds at rest opens them (packages/auth/src/vault.js, secretbox.js).
 */

const ROOT = new URL('../', import.meta.url).pathname;
const { isLegacySealed, open, openLegacy, openOrLocked, seal } = await import(
  `${ROOT}packages/auth/src/secretbox.js`
);
const vault = await import(`${ROOT}packages/auth/src/vault.js`);
const { bytesToBase64 } = vault;

const legacySeal = (plain, secret) => {
  const key = createHash('sha256').update(`genrewatch/playlist/v1:${secret}`).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
};

describe('sealing under the reader key', () => {
  test('locked: sealing and opening refuse, with a 423', () => {
    vault.resetUnlockStoreForTests();
    expect(() => seal('http://x/get.php?username=a&password=b', 'u1')).toThrow(
      vault.VaultLockedError,
    );
    expect(openOrLocked('v2.a.b.c', 'u1')).toEqual({
      value: null,
      locked: true,
      code: 'vault_locked',
    });
  });

  test('unlocked: round trip, bound to the owner, never plaintext', async () => {
    vault.resetUnlockStoreForTests();
    const { dek, seal: record } = await vault.sealer.createSeal('correct horse battery', 'u1');
    await vault.unlockWithDataKey('u1', record, bytesToBase64(dek), 3600);
    const sealed = seal('http://line/get.php?username=me&password=pw', 'u1');
    expect(sealed.startsWith('v2.')).toBe(true);
    expect(sealed).not.toContain('password=pw');
    expect(open(sealed, 'u1')).toBe('http://line/get.php?username=me&password=pw');
    // Another reader, even unlocked with the same key bytes, cannot open it.
    vault.unlockStore().unlock('u2', vault.playlistKeyFor('u1'), 3600);
    expect(open(sealed, 'u2')).toBeNull();
  });

  test('a wrong data key does not unlock', async () => {
    vault.resetUnlockStoreForTests();
    const { seal: record } = await vault.sealer.createSeal('correct horse battery', 'u3');
    await expect(
      vault.unlockWithDataKey('u3', record, bytesToBase64(randomBytes(32)), 60),
    ).rejects.toThrow(/does not open/);
    expect(vault.playlistKeyFor('u3')).toBeNull();
  });

  test('lock and restart forget the key; TTL defaults to 8h and caps at 7d', () => {
    vault.resetUnlockStoreForTests();
    vault.unlockStore().unlock('u4', randomBytes(32), 3600);
    expect(vault.playlistKeyFor('u4')).not.toBeNull();
    vault.unlockStore().lock('u4');
    expect(vault.playlistKeyFor('u4')).toBeNull();
    vault.unlockStore().unlock('u4', randomBytes(32), 3600);
    vault.resetUnlockStoreForTests(); // what a restart does
    expect(vault.playlistKeyFor('u4')).toBeNull();
    expect(vault.ttlSeconds(undefined)).toBe(8 * 3600);
    expect(vault.ttlSeconds('30d')).toBe(7 * 86400);
  });
});

describe('the old server key', () => {
  test('v1 values never open at runtime, even with PLAYLIST_SECRET set', () => {
    vault.resetUnlockStoreForTests();
    vault.unlockStore().unlock('u5', randomBytes(32), 3600);
    const old = legacySeal('http://old/line', 'the-old-secret');
    expect(isLegacySealed(old)).toBe(true);
    expect(() => open(old, 'u5')).toThrow(/re-seal/);
  });

  test('only the migration reads them, and not after the cutoff', () => {
    const old = legacySeal('http://old/line', 'the-old-secret');
    expect(openLegacy(old, { PLAYLIST_SECRET: 'the-old-secret' })).toBe('http://old/line');
    expect(
      openLegacy(old, { PLAYLIST_SECRET: 'the-old-secret', LEGACY_KEY_MIGRATION: 'off' }),
    ).toBeNull();
  });

  test('no DATABASE_URL fallback: without PLAYLIST_SECRET nothing old opens', () => {
    const old = legacySeal('http://old/line', 'postgres://user:pass@db/x');
    expect(openLegacy(old, { DATABASE_URL: 'postgres://user:pass@db/x' })).toBeNull();
    const cfg = Bun.file(`${ROOT}packages/config/src/index.js`);
    return cfg.text().then((text) => {
      expect(text).not.toContain("opt('PLAYLIST_SECRET') || opt('DATABASE_URL')");
    });
  });
});

describe('the worker', () => {
  test('a locked reader is not refreshed and is not marked as an error', async () => {
    const src = await Bun.file(`${ROOT}packages/playlists/src/index.js`).text();
    const loop = src.slice(src.indexOf('export async function refreshDuePlaylists'));
    expect(loop.indexOf('ensurePlaylistKey(row.user_id)')).toBeLessThan(
      loop.indexOf('refreshPlaylist(row.user_id'),
    );
    expect(loop).toContain('postponePlaylistRefresh');
  });

  test('without the internal URL and token, it asks nobody and stays locked', async () => {
    vault.resetUnlockStoreForTests();
    expect(await vault.ensurePlaylistKey('u6', {})).toBe(false);
  });
});
