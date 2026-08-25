import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Settings } from '../apps/web/src/views/pages.jsx';

/**
 * "I'm not seeing it in settings, the option to share."
 *
 * Reported twice, and both times the code was already there: every piece of
 * playlist sharing is present on this site -- setPlaylistShared, /shared,
 * sharedChannelsFor, the proxy play route, the whole thing. What was missing was
 * any way to find out it existed.
 *
 * The switch rendered only for an account that already had a channel list. There
 * are none on this site, so the section rendered for nobody, while the paragraph
 * directly above it promised the list "stays private to your account unless you
 * choose otherwise below" and pointed at nothing at all.
 *
 * A feature that appears only once you have already done the prerequisite cannot
 * be discovered by anybody who has not, which is indistinguishable from it not
 * being built.
 */

const render = async (playlist) => {
  const node = Settings({
    user: { id: 'u1', email: 'a@b.c', handle: 'chovy', display_name: 'Anthony' },
    prefs: { offsets_minutes: [60], date_offsets_minutes: [1440], channels: ['email'] },
    passkeys: [],
    passwordMinLength: 10,
    playlist,
  });
  return String(await node.toString());
};

describe('finding the sharing switch', () => {
  test('the section is there before you have a list', async () => {
    const html = await render(null);
    expect(html).toContain('Share your list');
  });

  test('and says what it needs first, rather than just appearing empty', async () => {
    const html = await render(null);
    expect(html).toContain('Once you have added a list');
  });

  /* Nothing to submit yet -- a switch that posts is worse than a sentence. */
  test('but offers no form until there is something to share', async () => {
    expect(await render(null)).not.toContain('/api/playlist/share');
  });

  test('the real switch appears as soon as there is a list', async () => {
    const html = await render({ id: 1, label: 'my line', channel_count: 7060, shared: false });
    expect(html).toContain('/api/playlist/share');
    expect(html).toContain('Share my list');
  });

  test('and turns into the way back out once it is open', async () => {
    const html = await render({ id: 1, label: 'my line', channel_count: 7060, shared: true });
    expect(html).toContain('Your list is open to everyone signed in');
    expect(html).toContain('Stop sharing');
  });

  test('every state points at who else is sharing', async () => {
    for (const p of [null, { id: 1, label: 'x', channel_count: 1, shared: true }]) {
      expect(await render(p)).toContain('href="/shared"');
    }
  });
});

describe('the promise made just above it', () => {
  const pages = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );

  /*
   * This sentence is what made the absence a broken promise rather than merely a
   * missing feature: it tells the reader to look below for a control that was
   * not being rendered.
   */
  test('"unless you choose otherwise below" now has something below it', () => {
    // Whitespace-collapsed: the sentence is identical on both brands but wraps
    // at a different word, so matching the raw source pins the prettier output
    // rather than the promise.
    const flat = pages.replace(/\s+/g, ' ');
    expect(flat).toContain('unless you choose otherwise below');
    const at = flat.indexOf('unless you choose otherwise below');
    expect(flat.indexOf('Share your list', at)).toBeGreaterThan(at);
  });
});
