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
      // A route that wants to see the request itself -- what Range arrived, and
      // whether one arrived at all, which is the whole question for a file.
      if (r.handler) return r.handler(req);
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

  test('a file may be seeked: the Range goes upstream and the 206 comes back whole', async () => {
    /*
     * The second half of the on-demand bug, and the one that would have bitten
     * immediately after the first was fixed.
     *
     * An MP4 whose moov atom sits at the end of the file -- which is most of what
     * these panels serve, since nothing has been run through faststart -- cannot
     * BEGIN playing until the player can fetch that end. The route swallowed every
     * Range and answered `accept-ranges: none`, so such a film was a spinner that
     * never resolved rather than a film that could not be seeked.
     */
    let seen = null;
    const s = serve({
      '/movie.mp4': {
        handler: (req) => {
          seen = req.headers.get('range');
          return new Response('DE', {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'accept-ranges': 'bytes',
              'content-range': 'bytes 8-9/10',
            },
          });
        },
      },
    });

    const got = await openStream(`http://localhost:${s.port}/movie.mp4`, { range: 'bytes=8-9' });
    expect(seen).toBe('bytes=8-9');
    expect(got.ok).toBe(true);
    // A 206 flattened into a 200 would be read as the whole file, and the player
    // would place the last two bytes at the start of the timeline.
    expect(got.status).toBe(206);
    expect(got.contentRange).toBe('bytes 8-9/10');
    expect(got.acceptRanges).toBe('bytes');
    s.stop(true);
  });

  test('a live channel is never asked for a range', async () => {
    // The default, and it stays the default: a live slot has no end to seek
    // within, and asking one for a byte range is a good way to be handed an error
    // page instead of video.
    let seen = 'unset';
    const s = serve({
      '/live': {
        handler: (req) => {
          seen = req.headers.get('range');
          return new Response('GG', { headers: { 'content-type': 'video/mp2t' } });
        },
      },
    });
    await openStream(`http://localhost:${s.port}/live`);
    expect(seen).toBeNull();
    s.stop(true);
  });

  test('a seek past the end is passed through as itself, not as a dead line', async () => {
    // 416 is the reader's player being wrong about the length. Mapped to 502 it
    // would read as "your provider did not send a stream", and the next seek would
    // work -- which is how a working film comes to look broken.
    const s = serve({ '/eof': { status: 416, type: 'video/mp4' } });
    const got = await openStream(`http://localhost:${s.port}/eof`, { range: 'bytes=99-' });
    expect(got.ok).toBe(false);
    expect(got.status).toBe(416);
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

  test('Play here is offered on every tier, from one shared section', () => {
    /*
     * Three lists -- on demand, the matches, the genre channels -- rendered by one
     * component, which is now shared with the SUBJECT page. That sharing is the
     * point: the matcher only ever ran on event pages, so a film with no upcoming
     * event was never checked against a reader's list at all.
     *
     * The tier no longer travels with the row because it no longer needs to: rows
     * are addressed by row id, so which list a row was ranked into cannot change
     * what its links resolve to.
     */
    expect(view).toContain('own.onDemand.map((ch) => (');
    expect(view).toContain('own.matches.map((ch) => (');
    expect(view).toContain('own.genre.map((ch) => (');
    // The kind travels with the row, because the button is the only place the
    // script can learn it: `data-play` is the same route for a live channel and
    // for a film, and the provider URL -- the other thing that would say which --
    // is deliberately not rendered.
    expect(view).toContain('<PlayButton channelId={mine} kind={ch.kind} />');
    expect(view).toMatch(/\/my\/channels\/\$\{channelId\}\/stream\.ts/);
  });

  test('the button ships disabled, so a browser that cannot play never shows a live one', () => {
    expect(view).toMatch(/class="ghost small-btn play-btn"\s*\n\s*disabled/);
  });

  test('the button carries the proxy route and never the provider URL', () => {
    // The credential is in the VLC href because an external app holds no session
    // with us. The page does, so nothing here needs it -- and a URL in a
    // data-attribute would additionally sit in the DOM for any extension to read.
    expect(view).toMatch(/data-play=\{`\/my\/channels\/\$\{channelId\}\/stream\.ts`\}/);
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

  test('a browser with no Media Source Extensions loses the LIVE buttons only', () => {
    /*
     * iPhone Safari, and the guarantee is narrower than it was.
     *
     * It still cannot transmux a transport stream -- there is nothing to push
     * fragments into -- so a live "Play here" that silently failed would pull
     * people away from VLC, the button that works there. But it plays an MP4
     * natively and always could, and the old rule removed every button in the
     * section: an iPhone was sent to find VLC for a film it could play on the
     * page. So the filter is by kind rather than by browser.
     */
    expect(client).toContain('const buttons = canTransmux() ? offered : offered.filter(isVod);');
    expect(client).toContain('for (const b of offered) if (!buttons.includes(b)) b.remove();');
  });

  test('a file is played natively, and never handed to the transport-stream demuxer', () => {
    /*
     * The bug this whole branch exists for.
     *
     * Every press went to `mpegts.createPlayer({type: 'mpegts'})`, and an MP4 is
     * not a transport stream: no sync bytes, no PAT, so the demuxer failed and the
     * reader was told to try VLC for a file the browser plays by itself. The kind
     * decides, the bundle is fetched only for a channel, and a film costs no
     * quarter-megabyte demuxer to watch.
     */
    expect(client).toContain('const vod = isVod(button);');
    expect(client).toMatch(
      /stop = vod\s*\n?\s*\? attachNative\(video, button\.dataset\.play, fail\)/,
    );
    // The bundle load sits behind the same test, so a file never waits for it.
    expect(client).toMatch(
      /if \(!vod\) \{\s*\n\s*try \{\s*\n\s*player = await loadPlayerBundle\(src\);/,
    );
  });

  test('a native failure is explained, rather than reported as a broken player', () => {
    // <video> is handed no status code -- only MEDIA_ERR_SRC_NOT_SUPPORTED -- so
    // "your provider did not send a stream" and "somebody else is watching that
    // line" would otherwise arrive as the same shrug.
    expect(client).toContain('explainStreamFailure(url).then(onError)');
    expect(client).toContain("if (status === 409) return 'Somebody else is watching");
    // And an abort is us pressing Stop, not something to put on the page.
    expect(client).toContain('if (video.error?.code === 1) return;');
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

/**
 * What the three stream routes do with a file, as opposed to a channel.
 *
 * Read from the source, the way the rest of this file reads the client: app.js
 * builds a whole application at import time -- config, database, migrations -- and
 * these are properties of the wiring rather than of a response that could be
 * fetched without all of it.
 */
describe('the routes tell a file from a channel', () => {
  const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');

  test('the kind decides, and series counts as a file', () => {
    // A provider's series entry is an episode sitting on disk, not a stream, so it
    // takes the same path as a film. Leaving it out would fix films and leave
    // every episode still failing.
    expect(app).toContain("const isVodKind = (kind) => kind === 'vod' || kind === 'series';");
  });

  test('every stream route passes the Range through for a file and withholds it for a channel', () => {
    // Three routes -- the reader's own, a shared one, and the event page's -- and
    // all three carried the same blanket `accept-ranges: none`. Fixing one would
    // have left an on-demand entry playable from one page and not another.
    const forwarded = app.match(/range: vod \? \(c\.req\.header\('range'\) \?\? null\) : null,/g);
    expect(forwarded?.length).toBe(3);

    const responses = app.match(/return streamResponse\(result, body, \{ vod, url: /g);
    expect(responses?.length).toBe(3);
  });

  test('a live channel still refuses ranges, and a file mirrors what the line said', () => {
    /*
     * Mirrored rather than asserted. Claiming `bytes` over a line that ignores
     * Range is worse than admitting it: the player would seek, be handed the start
     * of the file, and play the opening scene believing it was an hour in.
     */
    expect(app).toContain("headers['accept-ranges'] = 'none';");
    expect(app).toContain("headers['accept-ranges'] = result.acceptRanges || 'bytes';");
    expect(app).toContain('status: result.status === 206 ? 206 : 200,');
  });

  test('a file the provider would not name is not announced as a transport stream', () => {
    /*
     * These panels answer `application/octet-stream` for a great deal. The
     * demuxing path ignores the header and reads the bytes; native playback does
     * the opposite and refuses an MP4 announced as video/mp2t before decoding any
     * of it. The extension is what the kind was derived from, so it is a sound
     * fallback here.
     */
    expect(app).toContain("[/\\.(mp4|m4v)(\\?|$)/i, 'video/mp4']");
    expect(app).toMatch(/vod \? \(VOD_TYPE\.find/);
  });

  test('a shared file is playable too, which means its kind has to reach the page', () => {
    // sharedChannelById selected everything the row needed except the one column
    // that decides how to play it, so a shared film went to the demuxer even after
    // the reader's own stopped doing so.
    const queries = readFileSync(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    expect(queries).toContain('select c.id, c.title, c.group_title, c.kind, c.stream_url,');

    const view = readFileSync(
      new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(view).toContain('data-kind={ch.kind ?? null}');
  });
});
