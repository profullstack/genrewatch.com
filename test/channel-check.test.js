import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Checking an entry before offering it. Ported from tipoffwatch.com, where the
 * same list, the same probe and the same bug all live.
 *
 * A provider playlist is mostly aspirational: the slot exists, the title matches,
 * and a large share of them answer with an HTML error page instead of video. The
 * page listed every title that matched and let the reader find out by opening
 * one, so being handed a dead link was a routine outcome of using the feature
 * exactly as intended. The .m3u route has probed since it was written; the page
 * had no way to.
 *
 * The assertions are on the RENDERED row rather than the source that produces it.
 * Three tiers rendered near-identical markup three times and are now one
 * component, and a test that reads source has to be rewritten every time that
 * changes, whether or not the guarantee did.
 */
const { ChannelRow } = await import('../apps/web/src/views/pages.jsx');

const event = { id: 428 };
const render = (props) => ChannelRow(props).toString();

describe('the row a reader is offered', () => {
  test('carries the check route, not the stream', () => {
    // The provider URL belongs in the VLC href, where an app that holds no session
    // with us needs it -- and nowhere else. In a data attribute it would sit in
    // the DOM for any extension to read.
    const html = render({ event, ch: { title: 'Horror HD', url: 'http://line/1' }, index: 2 });
    expect(html).toContain('data-check="/events/428/channel-check?n=2"');
    expect(html).not.toContain('data-check="http://line/1"');
  });

  test('each tier checks its own list', () => {
    /*
     * Three lists, three different claims -- "you already have this file", "this
     * carries your show", "this carries the genre" -- indexed separately. A check
     * that dropped the tier would verify one entry and offer another, which is
     * worse than not checking at all.
     */
    const vod = render({ event, ch: { title: 'X', url: 'u' }, index: 0, tier: 'vod' });
    expect(vod).toContain('data-check="/events/428/channel-check?tier=vod&amp;n=0"');

    const genre = render({ event, ch: { title: 'X', url: 'u' }, index: 3, tier: 'genre' });
    expect(genre).toContain('data-check="/events/428/channel-check?tier=genre&amp;n=3"');
  });

  test('the check and the download agree on which entry they mean', () => {
    // They are built from one query string for exactly this reason.
    const html = render({ event, ch: { title: 'X', url: 'u' }, index: 4, tier: 'genre' });
    expect(html).toContain('/events/428/playlist.m3u?tier=genre&amp;n=4');
    expect(html).toContain('channel-check?tier=genre&amp;n=4');
  });

  test('nothing has vouched for it yet, so it says so in the markup', () => {
    const html = render({ event, ch: { title: 'X', url: 'u' }, index: 0 });
    expect(html).toContain('own-channel-state');
    expect(html).not.toContain('data-verified');
  });

  test('a verdict the server already holds is carried, so the page does not re-probe', () => {
    // These lines cap concurrent connections. Opening a page twice must not cost
    // two probes of the same slot.
    const html = render({ event, ch: { title: 'X', url: 'u', verified: true }, index: 0 });
    expect(html).toContain('data-verified="1"');
  });

  test('the app hand-offs are still there', () => {
    // VLC and Infuse are the point of the feature on a phone: they open an app
    // that can demux TS, which Safari cannot.
    const html = render({ event, ch: { title: 'X', url: 'http://line/1' }, index: 0 });
    expect(html).toContain('vlc-x-callback://x-callback-url/stream?url=');
    expect(html).toContain('infuse://x-callback-url/play?url=');
  });
});

describe('how the sweep behaves', () => {
  const client = readFileSync(
    new URL('../apps/web/public/app.js', import.meta.url).pathname,
    'utf8',
  );
  const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');

  test('one entry at a time, never the whole list at once', () => {
    // One subscriber's own connections on a line that caps them. Five checks at
    // once is how an account gets flagged.
    expect(client).toContain('for (const li of pending) {');
    expect(client).not.toMatch(/Promise\.all\([^)]*dataset\.check/);
  });

  test('a dead entry is removed rather than greyed out', () => {
    // Greying one out leaves the reader deciding whether to try it anyway, and
    // the answer is no.
    expect(client).toContain('li.remove();');
  });

  test('an emptied list takes its heading with it', () => {
    // Three lists, each with a heading above it. A heading left behind names a
    // list that is no longer there.
    expect(client).toContain("label?.matches?.('h3, p.muted')");
  });

  test('the sweep runs again after a client-side navigation', () => {
    // <main> is replaced wholesale, so a page reached by a link had never been
    // checked at all -- and, as it turns out, had never had the phone hand-off
    // treatment either. The sweep is started by initInlinePlayer rather than
    // called directly: pressing Play has to be able to abort it, which means one
    // thing has to own both.
    const nav = client.slice(client.indexOf('initPasskeys();'));
    expect(nav.slice(0, 700)).toContain('initInlinePlayer();');
  });

  test('the check and the download share one tier picker', () => {
    // Duplicating it is how the two drift into disagreeing about which entry ?n=0
    // means.
    expect(app).toContain('function pickOwnChannel(c, own)');
    // Its definition plus three call sites: the check, the download, and the
    // in-page player. All three reach for a channel by index, and a picker they
    // did not share is how a probe clears one entry and the player opens another.
    expect(app.match(/pickOwnChannel\(c, own\)/g).length).toBe(4);
  });

  test('the verdict is written back for the next reader', () => {
    // The 30-minute filter in playlistChannels, the .m3u route and the next page
    // view all inherit what one check learned.
    const route = app.slice(app.indexOf("app.get('/events/:id/channel-check'"));
    expect(route.slice(0, 2000)).toContain('markChannelChecked');
  });

  test('the probe stops when the reader who asked for it leaves', () => {
    const probe = readFileSync(
      new URL('../packages/playlists/src/probe.js', import.meta.url).pathname,
      'utf8',
    );
    expect(probe).toContain('export async function probeStream(url, { signal } = {})');
    expect(probe).toContain("signal?.addEventListener('abort', abort, { once: true })");
  });
});
