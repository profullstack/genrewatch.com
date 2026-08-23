import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  _resetStreamSlots,
  claimStreamSlot,
  openStream,
  streamSlotsOpen,
} from '../packages/playlists/src/proxy.js';

/**
 * Playing an entry in the page, for a device with no app to hand it to.
 *
 * A television has a browser and nothing else: no VLC to deep link into, no
 * Infuse, no filesystem for an .m3u. The bytes therefore come through the server
 * for that one case, and the risks are all in the edges rather than the happy
 * path -- a dead slot that answers 200 with a web page, a reader who closes the
 * tab, a second tab opening a second connection on a line that permits one.
 *
 * A local server stands in for the provider, so none of this touches anybody's
 * subscription.
 */

/** A server that answers each path with a fixed shape. */
function serve(routes) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const r = routes[pathname];
      if (!r) return new Response('nope', { status: 404 });
      if (r.hang) return new Promise(() => {});
      return new Response(r.body ?? 'x', {
        status: r.status ?? 200,
        headers: r.type ? { 'content-type': r.type } : {},
      });
    },
  });
}

describe('opening a channel for the browser', () => {
  test('a transport stream comes back with its body intact', async () => {
    const s = serve({ '/ts': { type: 'video/mp2t', body: 'GG' } });
    const got = await openStream(`http://localhost:${s.port}/ts`);
    expect(got.ok).toBe(true);
    // The body has to be the actual stream, not a buffered copy or a summary:
    // this route exists to pass bytes through.
    expect(await new Response(got.body).text()).toBe('GG');
    s.stop(true);
  });

  test('a dead slot answering 200 with a web page is refused, in its own words', async () => {
    // The common failure on these panels, and the reason a status code is not
    // enough on its own. Handing this to the player produces a decoder error,
    // which reads as "your player is broken" rather than "that slot is empty".
    const s = serve({ '/dead': { type: 'text/html; charset=UTF-8', body: '<html>gone' } });
    const got = await openStream(`http://localhost:${s.port}/dead`);
    expect(got.ok).toBe(false);
    expect(got.status).toBe(502);
    expect(got.note).toContain('web page');
    s.stop(true);
  });

  test('an HLS playlist is refused as needing a different player, not as broken', async () => {
    // Playable, but not by this page: the transmuxer reads transport stream. The
    // distinction matters because the honest answer is "open it in VLC", and a
    // generic failure would not say that.
    const s = serve({ '/hls': { type: 'application/vnd.apple.mpegurl' } });
    const got = await openStream(`http://localhost:${s.port}/hls`);
    expect(got.ok).toBe(false);
    expect(got.status).toBe(415);
    expect(got.note).toContain('HLS');
    s.stop(true);
  });

  test('an error status names the status, so the reader knows it was the provider', async () => {
    const s = serve({ '/err': { status: 503, type: 'video/mp2t' } });
    const got = await openStream(`http://localhost:${s.port}/err`);
    expect(got.ok).toBe(false);
    expect(got.note).toContain('503');
    s.stop(true);
  });

  test('a provider that never answers gives up, rather than holding the request open', async () => {
    const s = serve({ '/hang': { hang: true } });
    const got = await openStream(`http://localhost:${s.port}/hang`, { connectTimeoutMs: 150 });
    expect(got.ok).toBe(false);
    expect(got.note).toBe('timed out');
    s.stop(true);
  });

  test('a reader who left is not recorded as a broken channel', async () => {
    /*
     * The distinction this exists for. Closing the tab aborts the request, and
     * treating that as a verdict would mark a perfectly good channel dead --
     * after which the page stops offering it, and the reader concludes the
     * feature is broken because they closed a tab.
     */
    const s = serve({ '/hang': { hang: true } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const got = await openStream(`http://localhost:${s.port}/hang`, { signal: ac.signal });
    expect(got.ok).toBe(false);
    expect(got.silent).toBe(true);
    s.stop(true);
  });

  test('something that is not a URL is refused without a fetch', async () => {
    const got = await openStream('not-a-url');
    expect(got.ok).toBe(false);
    expect(got.note).toContain('url');
  });
});

describe('one connection per account, newest wins', () => {
  /*
   * The ceiling is not our capacity: it is the reader's. A provider line permits
   * a small number of simultaneous connections, often exactly one, and exceeding
   * it is what gets a subscription suspended.
   *
   * Which stream gives way is a separate decision from whether one has to, and
   * refusing the new one was the wrong answer. The page tears the old player down
   * before it asks for the next channel, so by the time "you are already watching
   * a channel" appeared, the reader usually was not -- the server had simply not
   * yet noticed a socket it had stopped reading. Pressing Play twice quickly was
   * the reliable way to be told no.
   */

  test('a second stream takes the line over instead of being refused', () => {
    _resetStreamSlots();
    expect(claimStreamSlot('u1')).toBeTruthy();
    expect(claimStreamSlot('u1')).toBeTruthy();
  });

  test('taking over ends the stream that was there, rather than adding to it', () => {
    _resetStreamSlots();
    let evicted = 0;
    claimStreamSlot('u1', { evict: () => (evicted += 1) });
    expect(evicted).toBe(0);
    claimStreamSlot('u1', { evict: () => {} });
    // The eviction is what aborts the upstream fetch. Counting the slot back
    // without it would leave the provider connection open with nobody reading it,
    // which is the exact state the ceiling exists to prevent.
    expect(evicted).toBe(1);
    expect(streamSlotsOpen('u1')).toBe(1);
  });

  test('an evicted stream releasing later does not drop the one that replaced it', () => {
    /*
     * The order is always this: the new claim evicts, the abort travels, and the
     * old request's own teardown fires afterwards. If that late release were
     * counted against the account rather than against the entry it belongs to,
     * the replacement's slot would be handed back while it was still playing.
     */
    _resetStreamSlots();
    const first = claimStreamSlot('u1', { evict: () => {} });
    claimStreamSlot('u1', { evict: () => {} });
    first();
    expect(streamSlotsOpen('u1')).toBe(1);
  });

  test('another account is unaffected', () => {
    _resetStreamSlots();
    claimStreamSlot('u1');
    claimStreamSlot('u2');
    expect(streamSlotsOpen('u1')).toBe(1);
    expect(streamSlotsOpen('u2')).toBe(1);
  });

  test('an evict that throws does not keep the slot', () => {
    // A fetch aborted twice throws, and it arrives here as the eviction of a
    // stream that has already gone. Losing the slot to that would be permanent.
    _resetStreamSlots();
    claimStreamSlot('u1', {
      evict: () => {
        throw new Error('already gone');
      },
    });
    expect(() => claimStreamSlot('u1', { evict: () => {} })).not.toThrow();
    expect(streamSlotsOpen('u1')).toBe(1);
  });

  test('releasing frees the line', () => {
    _resetStreamSlots();
    const release = claimStreamSlot('u1');
    release();
    expect(streamSlotsOpen('u1')).toBe(0);
  });

  test('releasing twice does not walk the count below what is open', () => {
    /*
     * Teardown fires on both cancel and error for the same viewer, so a double
     * release is the normal case rather than a rare one. Counting it twice walks
     * the number below zero and the ceiling silently stops applying -- which is
     * the shape of bug that only shows up as a suspended subscription.
     */
    _resetStreamSlots();
    const release = claimStreamSlot('u1');
    release();
    release();
    claimStreamSlot('u1');
    claimStreamSlot('u1');
    expect(streamSlotsOpen('u1')).toBe(1);
  });

  test('the ceiling is configurable, for a line that permits more', () => {
    _resetStreamSlots();
    claimStreamSlot('u1', { max: 2 });
    claimStreamSlot('u1', { max: 2 });
    expect(streamSlotsOpen('u1')).toBe(2);
    claimStreamSlot('u1', { max: 2 });
    expect(streamSlotsOpen('u1')).toBe(2);
  });

  test('a lowered ceiling sheds every stream above it, not one', () => {
    // max can fall under a running account when a deploy changes the knob. One
    // eviction per claim would leave it permanently over the line's limit.
    _resetStreamSlots();
    claimStreamSlot('u1', { max: 3 });
    claimStreamSlot('u1', { max: 3 });
    claimStreamSlot('u1', { max: 3 });
    claimStreamSlot('u1', { max: 1 });
    expect(streamSlotsOpen('u1')).toBe(1);
  });

  test('a line that permits nothing hands out no slot at all', () => {
    _resetStreamSlots();
    expect(claimStreamSlot('u1', { max: 0 })).toBeNull();
    expect(streamSlotsOpen('u1')).toBe(0);
  });
});

describe('what the page offers, and to whom', () => {
  const view = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );
  const client = readFileSync(
    new URL('../apps/web/public/app.js', import.meta.url).pathname,
    'utf8',
  );

  test('Play here is offered on every tier the page offers', () => {
    /*
     * Three lists here where the sibling site has two -- on demand, the matches,
     * and the genre channels -- and they all render one component, so what matters
     * is that each reaches it and that the tier travels with it. A tier that did
     * not travel would mean ?n=0 selecting a row from the wrong list.
     */
    expect(view).toContain('<ChannelRow event={event} ch={ch} index={i} tier="vod" />');
    expect(view).toContain('<ChannelRow event={event} ch={ch} index={i} />');
    expect(view).toContain('<ChannelRow event={event} ch={ch} index={i} tier="genre" />');
    expect(view).toContain('<PlayButton eventId={event.id} query={query} />');
    expect(view).toMatch(/stream\.ts\?\$\{query\}/);
  });

  test('the button ships disabled, so a browser that cannot play never shows a live one', () => {
    expect(view).toMatch(/class="ghost small-btn play-btn"\s*\n\s*disabled/);
  });

  test('the button carries the proxy route and never the provider URL', () => {
    // The credential is in the VLC href because an external app holds no session
    // with us. The page does, so nothing here needs it -- and a URL in a
    // data-attribute would additionally sit in the DOM for any extension to read.
    expect(view).toMatch(/data-play=\{`\/events\/\$\{eventId\}\/stream\.ts/);
    expect(view).not.toMatch(/data-play=\{playerLinks/);
  });

  test('a press that is no longer the newest abandons itself', () => {
    /*
     * Starting a player is not instant -- the bundle arrives on the first press --
     * and a second press during that wait ran the whole handler again. Both
     * reached `stop = player.attach(...)`, the later overwrote the earlier handle,
     * and the earlier player kept running with nothing left able to destroy it:
     * two <video> elements and two connections on a line that permits one.
     */
    expect(client).toContain('const mine = generation;');
    expect(client).toContain('if (mine !== generation) {');
  });

  test('starting a channel takes the old one out of the page first', () => {
    // The teardown is what removes the <video> and drops the connection. Leaving
    // it to the server's eviction would strand a dead player on the page.
    expect(client).toMatch(/teardown\(\);\n\s*for \(const b of buttons\)/);
  });

  test('a browser with no Media Source Extensions loses the button entirely', () => {
    // iPhone Safari. A "Play here" that silently fails would pull people away
    // from VLC, which is the button that actually works there.
    // The condition grew a second arm -- a section with no buttons at all -- but
    // the guarantee is the same one: no Media Source Extensions, no Play button.
    expect(client).toContain('if (!canTransmux()');
    expect(client).toContain('for (const b of buttons) b.remove();');
  });

  test('the demuxer is fetched on demand, not linked from the Layout', () => {
    // A quarter of a megabyte on every event page, for the few who press play.
    const layout = readFileSync(
      new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(layout).not.toContain('vendor-mpegts.js');
    expect(view).toContain("data-player-src={assetUrl('vendor-mpegts.js')}");
  });

  test('navigating away stops the stream rather than orphaning it', () => {
    /*
     * The client-side navigation replaces <main> wholesale. A player whose
     * <video> has left the document keeps pulling the stream and holding the
     * account's one connection, so the next channel is refused with "you are
     * already watching" on a page showing no player at all.
     */
    expect(client).toContain('window.__genreStopPlayer?.();');
    expect(client).toContain("window.addEventListener('pagehide', teardown)");
  });
});
