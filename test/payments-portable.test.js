import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * The payments package must stay copyable between brands.
 *
 * `packages/payments/src/index.js` is the SAME FILE in tipoffwatch and genrewatch.
 * That is only true while it names no brand: the moment it imports `@tipoff/db` or
 * `@genre/config`, the two copies diverge and every future change has to be
 * re-applied by hand instead of copied.
 *
 * These are the rules that keep `cp` a sufficient port. They are cheap and they
 * are the only thing standing between this and the usual slow drift.
 */

const SRC = readFileSync(
  new URL('../packages/payments/src/index.js', import.meta.url).pathname,
  'utf8',
);

describe('the shared payments package', () => {
  test('imports nothing but node builtins', () => {
    const imports = [...SRC.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec.startsWith('node:')).toBe(true);
    }
  });

  test('names no brand anywhere, not even in a comment it might be copied from', () => {
    // A scope in a comment is harmless today and is how the next person learns the
    // wrong lesson about where this file may reach.
    expect(SRC).not.toContain('@tipoff/');
    expect(SRC).not.toContain('@genre/');
  });

  /*
   * The whole reason it can hold no imports: it is handed its database and its
   * settings once, at boot, by whichever app is starting.
   */
  test('takes its dependencies through configurePayments', () => {
    expect(SRC).toContain('export function configurePayments(');
    expect(SRC).toContain('configurePayments() has not been called');
  });

  /*
   * The package must not know what is being sold. The moment it does, it stops
   * being shareable -- one brand resells stream slots and the other does not, and
   * neither concept belongs in a file both of them copy.
   */
  test('knows nothing about what is for sale', () => {
    for (const domain of ['stream_offers', 'offersForEvent', 'capacity', 'sold <']) {
      expect(SRC).not.toContain(domain);
    }
  });

  test('and takes the grant as a callback instead', () => {
    expect(SRC).toContain('settleWebhook(payload, { grant }');
    expect(SRC).toContain('await grant(tx,');
  });

  /*
   * An open-ended grant is what turns a small sale into redistribution, so the
   * expiry has no default and cannot be omitted.
   */
  test('refuses to grant access that never expires', () => {
    expect(SRC).toContain('an entitlement needs an expiry');
  });
});
