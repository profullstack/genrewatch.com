/*
 * The key vault, in the browser (Settings): the house controller from
 * @profullstack/sealed-secrets, which mounts the card KeyVaultCard draws.
 * Every bit of cryptography happens there; the passphrase and the recovery key
 * never leave the page. Bundled as an IIFE (build-client.js).
 */
import '@profullstack/sealed-secrets/vault-ui/auto';
