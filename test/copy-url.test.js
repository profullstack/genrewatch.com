import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { ChannelRow, SharedChannelRow } = await import('../apps/web/src/views/pages.jsx');

/**
 * Copying the address of the thing you are watching.
 *
 * VLC and Infuse are deep links into two named apps, and app.js removes them on
 * a desktop because the schemes mean nothing there. The .m3u download is the
 * mirror image: right on a desktop, removed on a phone. So on any given device
 * one of the two ways to reach the file is gone, and neither was ever any use to
 * mpv, ffmpeg, a set-top box, or a second player on another machine. An address
 * in the clipboard works everywhere.
 *
 * The rule that shapes it is the one that already governs VLC: the address IS
 * the credential. A managed row plays here and nowhere else, and a shared row is
 * somebody else's subscription. Both keep that property below.
 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');
const render = async (node) => String(await node.toString());

const APP_JS = read('../apps/web/public/app.js');

const OWN = {
  id: 7,
  title: 'Heat (1995)',
  group: 'Crime',
  kind: 'vod',
  url: 'http://line.example.test:8080/user/pass/1234',
  verified: true,
};

describe('a row on the reader own line', () => {
  test('offers the address the VLC link beside it already carries', async () => {
    const out = await render(ChannelRow({ ch: OWN }));
    expect(out).toContain(`data-copy-url="${OWN.url}"`);
    expect(out).toContain('Copy URL');
  });

  test('the wording follows the row: a film is a file, a channel is a stream', async () => {
    expect(await render(ChannelRow({ ch: OWN }))).toContain('file');
    expect(await render(ChannelRow({ ch: { ...OWN, kind: 'live' } }))).toContain('stream');
  });

  /*
   * The whole reason this button is safe on a normal row is that the button
   * beside it already publishes the same string. Where that stops being true,
   * this has to stop with it.
   */
  test('a managed row gets none, for the reason it gets no VLC link', async () => {
    // Per-row, which here means the row knows which of the reader's lists it is
    // on: managedRow only trusts providerManaged once playlistId says so.
    const out = await render(ChannelRow({ ch: { ...OWN, playlistId: 4, providerManaged: true } }));
    expect(out).not.toContain('data-copy-url');
    expect(out).not.toContain('vlc-x-callback');
  });

  test('a managed LIST is still managed when the flag comes as a prop', async () => {
    const out = await render(ChannelRow({ ch: OWN, managed: true }));
    expect(out).not.toContain('data-copy-url');
  });

  test('somebody else list gets none: that address is their subscription', async () => {
    const out = await render(SharedChannelRow({ ch: { id: 3, title: 'Heat', ownerLabel: 'Jo' } }));
    expect(out).not.toContain('data-copy-url');
  });
});

describe('the browser half', () => {
  test('the address is copied, and made absolute first', () => {
    expect(APP_JS).toContain('function initCopyUrlButtons');
    expect(APP_JS).toContain('new URL(raw, window.location.href)');
  });

  test('armed once, at the document, so it covers rows added later', () => {
    expect(APP_JS).toContain('initCopyUrlButtons();');
  });

  /*
   * navigator.clipboard is absent outside a secure context and can be refused
   * inside one. A dead button that swallowed the address would be the worst of
   * the outcomes, so the URL goes into a field the reader can select.
   */
  test('a refused clipboard still puts the address in front of the reader', () => {
    expect(APP_JS).toContain('function revealAddress');
    expect(APP_JS).toContain('copy-url-fallback');
  });

  test('the player draws the button under the picture, from the row own address', () => {
    expect(APP_JS).toContain("copyBar.className = 'player-copy'");
    expect(APP_JS).toContain("row?.querySelector('[data-copy-url]')");
    // Torn down with the stage: it names the title that stage is carrying.
    expect(APP_JS).toContain('copyBar?.remove();');
  });
});
