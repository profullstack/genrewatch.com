import { bytesToBase64, createSealer, wipe } from '@profullstack/sealed-secrets';

/*
 * The key vault, in the browser (Settings).
 *
 * Every bit of cryptography happens here: the passphrase and the recovery key
 * never leave the page. The server gets the sealed record and, on unlock, only
 * the derived data key, which it keeps in memory for the time chosen.
 *
 * The app name must match packages/auth/src/vault.js. It is read from the
 * element so the three watch sites can share this file unchanged.
 */

const root = document.getElementById('key-vault');
if (root) {
  const sealer = createSealer({ app: root.dataset.app, scope: 'playlists' });
  const userId = root.dataset.user;
  const status = root.querySelector('[data-vault-status]');
  const say = (text, bad = false) => {
    status.textContent = text;
    status.className = bad ? 'error' : 'notice';
  };
  const api = async (path, body, method = 'POST') => {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'That did not work.');
    return out;
  };
  const value = (name) => root.querySelector(`[name="${name}"]`)?.value ?? '';
  const ttl = () => value('ttl') || '8h';
  const sendUnlock = async (dek) => {
    try {
      const out = await api('/my/vault/unlock', { dek: bytesToBase64(dek), ttl: ttl() });
      const moved = out.migration?.migrated || 0;
      return moved ? `Unlocked. ${moved} older item(s) re-sealed with your vault.` : 'Unlocked.';
    } finally {
      wipe(dek);
    }
  };
  const run = (fn) => async (event) => {
    event.preventDefault();
    for (const b of root.querySelectorAll('button')) b.disabled = true;
    try {
      say(await fn());
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      say(err.message || 'That did not work.', true);
    } finally {
      for (const b of root.querySelectorAll('button')) b.disabled = false;
    }
  };
  const currentSeal = async () => (await api('/my/vault', null, 'GET')).seal;
  const openDek = async (seal) =>
    root.querySelector('[name="recovery"]')?.checked
      ? sealer.unlockSealWithRecovery(seal, value('passphrase').trim(), userId)
      : sealer.unlockSeal(seal, value('passphrase'), userId);

  root.querySelector('[data-vault-create]')?.addEventListener(
    'click',
    run(async () => {
      if (value('passphrase') !== value('confirm'))
        throw new Error('The two passphrases are different.');
      const made = await sealer.createSeal(value('passphrase'), userId);
      try {
        await api('/my/vault', { seal: made.seal });
      } catch (err) {
        wipe(made.dek);
        throw err;
      }
      // Shown once, and blocking on purpose: it is the only way back in.
      window.prompt(
        'Your recovery key. Save it now (a password manager is ideal); it is shown only once:',
        made.recoveryKey,
      );
      return sendUnlock(made.dek);
    }),
  );
  root.querySelector('[data-vault-unlock]')?.addEventListener(
    'click',
    run(async () => sendUnlock(await openDek(await currentSeal()))),
  );
  root.querySelector('[data-vault-lock]')?.addEventListener(
    'click',
    run(async () => {
      await api('/my/vault/lock');
      return 'Locked. Your lists wait until you unlock again.';
    }),
  );
  root.querySelector('[data-vault-rewrap]')?.addEventListener(
    'click',
    run(async () => {
      const seal = await currentSeal();
      const dek = await openDek(seal);
      try {
        const next = await sealer.rewrapSeal(dek, seal, value('new_passphrase'), userId);
        await api('/my/vault', { seal: next, dek: bytesToBase64(dek) }, 'PUT');
      } finally {
        wipe(dek);
      }
      return 'Passphrase changed. Your recovery key still works.';
    }),
  );
}
