import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url).pathname;

/**
 * Every workspace must be copied into the deps stage.
 *
 * Bun's isolated linker gives each workspace its own node_modules rather than
 * hoisting to the root, so the Dockerfile copies each package.json individually
 * before installing. That list is hand-maintained, which means adding a package and
 * forgetting the COPY line is a one-character-invisible mistake that passes every
 * local check and fails only in the image build:
 *
 *   error: Workspace dependency "@genre/playlists" not found
 *
 * Ported from tipoffwatch, where it happened once and cost four consecutive failed
 * deploys while the site stayed up on the previous container and nothing looked
 * wrong locally. Adding packages/playlists here would have repeated it exactly --
 * the COPY line was in fact missing until this test was written.
 */
describe('the Dockerfile deps stage', () => {
  const workspaceDirs = async () => {
    const dirs = [];
    for (const group of ['packages', 'apps']) {
      for (const entry of await readdir(`${root}${group}`, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${group}/${entry.name}`);
      }
    }
    return dirs;
  };

  test('copies a package.json for every workspace in the repo', async () => {
    const dockerfile = await readFile(`${root}Dockerfile`, 'utf8');
    const dirs = await workspaceDirs();
    expect(dirs.length).toBeGreaterThan(0);

    const missing = dirs.filter((d) => !dockerfile.includes(`COPY ${d}/package.json`));
    expect(missing).toEqual([]);
  });

  test('does not copy a workspace that no longer exists', async () => {
    const dockerfile = await readFile(`${root}Dockerfile`, 'utf8');
    const copied = [
      ...dockerfile.matchAll(/^COPY ((?:packages|apps)\/[\w.-]+)\/package\.json/gm),
    ].map((m) => m[1]);
    expect(copied.length).toBeGreaterThan(0);
    for (const d of copied) {
      // A stale COPY fails the build just as loudly as a missing one.
      expect(await Bun.file(`${root}${d}/package.json`).exists()).toBe(true);
    }
  });

  test('every workspace dependency names a workspace that exists', async () => {
    const dirs = await workspaceDirs();
    const pkgs = new Map();
    for (const d of dirs) {
      pkgs.set(d, JSON.parse(await readFile(`${root}${d}/package.json`, 'utf8')));
    }
    const names = new Set([...pkgs.values()].map((p) => p.name));

    for (const [d, pkg] of pkgs) {
      for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
        if (typeof range === 'string' && range.startsWith('workspace:')) {
          expect({ from: d, dep, exists: names.has(dep) }).toEqual({ from: d, dep, exists: true });
        }
      }
    }
  });
});
