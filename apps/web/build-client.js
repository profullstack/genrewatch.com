/**
 * Bundles the WebAuthn browser helper into public/ as a global.
 *
 * Bundled rather than pulled from a CDN: the page must keep working under a strict
 * CSP and with no third-party origin in the critical path of signing in.
 */
const out = await Bun.build({
  entrypoints: [new URL('./src/client/webauthn-entry.js', import.meta.url).pathname],
  outdir: new URL('./public', import.meta.url).pathname,
  naming: 'vendor-webauthn.js',
  minify: true,
  target: 'browser',
});
if (!out.success) {
  for (const l of out.logs) console.error(l);
  process.exit(1);
}
console.log('[build] vendor-webauthn.js');
