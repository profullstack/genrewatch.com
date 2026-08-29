import { beforeAll, describe, expect, test } from 'bun:test';

/**
 * A bad address must not take the working one with it.
 *
 * The stored URL is written before the fetch, because an error has to be recorded
 * against a row and a first-time add has no row until then. The cost was quiet and
 * expensive: mistyping the address replaced a working line with a broken one, and
 * since the value is sealed there was no way to read the old one back. "Paste it
 * again" then means "keep a copy of your provider password somewhere else", which
 * is the opposite of what sealing it was for.
 *
 * The work happens in a child process (test/fixtures/playlist-rollback-probe.js).
 * Answering this needs the database module replaced, and `mock.module` registers
 * process-wide rather than per file -- inline, it handed the fake to every other
 * test file that imports the real queries and took twenty-two of them down.
 */

let out = {};

beforeAll(async () => {
  const fixture = new URL('./fixtures/playlist-rollback-probe.js', import.meta.url).pathname;
  const proc = Bun.spawn(['bun', fixture], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // The probe's own failure has to be visible, or every assertion below fails
  // with "undefined" and says nothing about why.
  expect(code, `probe exited ${code}: ${stderr}`).toBe(0);
  out = JSON.parse(stdout.trim().split('\n').at(-1));
}, 60_000);

describe('a failed import leaves the previous address in place', () => {
  test('a good import is stored', () => {
    expect(out.storedAfterGoodImport).toBe('http://line.example.test/playlist/me/secret/m3u');
    expect(out.labelAfterGoodImport).toBe('My line');
  });

  test('a typo does not overwrite the address that works', () => {
    expect(out.typoMessage).toStartWith('Could not read that list');
    expect(out.storedAfterTypo).toBe('http://line.example.test/playlist/me/secret/m3u');
    expect(out.labelAfterTypo).toBe('My line');
  });

  test('the reader is told their old address survived', () => {
    expect(out.typoMessage).toContain('previous address is still saved');
  });

  test('the failure is still recorded, so the page can show it', () => {
    expect(out.errorRecorded).toBe('the provider answered 404');
  });

  test('something that answers but is not a playlist rolls back too', () => {
    expect(out.notAPlaylistMessage).toStartWith('No channels found');
    expect(out.storedAfterNotAPlaylist).toBe('http://line.example.test/playlist/me/secret/m3u');
  });

  test('a failing refresh of the SAME address is not rolled back to itself', () => {
    expect(out.sameUrlMessage).toStartWith('Could not read that list');
    expect(out.sameUrlMessage).not.toContain('still saved');
    expect(out.storedAfterSameUrl).toBe('http://line.example.test/playlist/me/secret/m3u');
  });
});
