/**
 * Bundles the browser helpers into public/ as globals.
 *
 * Bundled rather than pulled from a CDN: the page must keep working under a strict
 * CSP and with no third-party origin in the critical path of signing in.
 *
 * Two bundles rather than one, and deliberately so. The WebAuthn helper is small
 * and loads on every page; the player carries a whole MPEG-2 transport stream
 * demuxer and loads only when somebody presses play. Merging them would put a few
 * hundred kilobytes on every page view to serve the handful that watch.
 */
const BUNDLES = [
  ['webauthn-entry.js', 'vendor-webauthn.js'],
  ['player-entry.js', 'vendor-mpegts.js'],
];

for (const [entry, name] of BUNDLES) {
  const out = await Bun.build({
    entrypoints: [new URL(`./src/client/${entry}`, import.meta.url).pathname],
    outdir: new URL('./public', import.meta.url).pathname,
    naming: name,
    minify: true,
    target: 'browser',
  });
  if (!out.success) {
    for (const l of out.logs) console.error(l);
    process.exit(1);
  }
  console.log(`[build] ${name}`);
}
