import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const read = (p) => readFile(new URL(p, import.meta.url).pathname, 'utf8');

const { nextAdvert } = await import('../apps/web/src/lib/ads.js');

/** A fetch that answers one body, and records what it was asked for. */
const answering = (body, { ok = true } = {}) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok, json: async () => body };
  };
  impl.calls = calls;
  return impl;
};

describe('asking the network for a creative', () => {
  /*
   * The default that matters most. A development copy, and any deployment that has
   * not sold this inventory, has no advertising relationship -- and must not spend
   * a request per break being told so.
   */
  test('no slot means no request at all', async () => {
    const fetchImpl = answering({ url: 'https://ads.example/spot.mp4' });
    expect(await nextAdvert('video', { slot: '', fetchImpl })).toEqual({ url: null });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test('a good answer comes back as a creative', async () => {
    const fetchImpl = answering({ url: 'https://ads.example/spot.mp4', kind: 'video' });
    expect(
      await nextAdvert('video', { slot: 's1', fetchImpl, origin: 'https://ads.test' }),
    ).toEqual({ url: 'https://ads.example/spot.mp4', kind: 'video' });
    expect(fetchImpl.calls[0].url).toBe('https://ads.test/api/ads/stream?slot=s1&kind=video');
  });

  /*
   * Video is the default here and audio on the radio brands, because everything
   * this site plays has a picture. A caller asking for audio still gets audio.
   */
  test('video unless audio is asked for', async () => {
    const v = answering({ url: 'https://a.example/x.mp4' });
    await nextAdvert(null, { slot: 's1', fetchImpl: v, origin: 'https://ads.test' });
    expect(v.calls[0].url).toContain('kind=video');

    const a = answering({ url: 'https://a.example/x.mp3' });
    await nextAdvert('audio', { slot: 's1', fetchImpl: a, origin: 'https://ads.test' });
    expect(a.calls[0].url).toContain('kind=audio');
  });

  /*
   * This url is handed to a media element in somebody's browser. A javascript: or
   * data: value arriving from the network must not survive being proxied.
   */
  test('only https survives', async () => {
    for (const url of ['javascript:alert(1)', 'data:video/mp4;base64,AAA', 'http://a.test/x.mp4']) {
      const fetchImpl = answering({ url });
      expect(await nextAdvert('video', { slot: 's1', fetchImpl })).toEqual({ url: null });
    }
  });

  test('a malformed url, a non-string, and a refusal are all the same answer', async () => {
    for (const body of [{ url: 'not a url' }, { url: 42 }, {}, null]) {
      expect(await nextAdvert('video', { slot: 's1', fetchImpl: answering(body) })).toEqual({
        url: null,
      });
    }
    expect(
      await nextAdvert('video', {
        slot: 's1',
        fetchImpl: answering({ url: 'https://a/x' }, { ok: false }),
      }),
    ).toEqual({ url: null });
  });

  /*
   * The kind coming back must agree with the kind that was asked for.
   *
   * This mapping was carried over from the radio properties, where audio is the
   * default at both ends. Here the request defaults to video, and the answer was
   * still being labelled audio whenever the network did not say -- so a video
   * creative was handed to the player as sound only, on a site whose every surface
   * has a picture.
   */
  test('a creative with no stated kind is the kind that was asked for', async () => {
    const got = await nextAdvert(null, {
      slot: 's1',
      fetchImpl: answering({ url: 'https://a.example/spot.mp4' }),
    });
    expect(got).toEqual({ url: 'https://a.example/spot.mp4', kind: 'video' });

    // And an explicit audio answer is still respected.
    const heard = await nextAdvert('audio', {
      slot: 's1',
      fetchImpl: answering({ url: 'https://a.example/spot.mp3', kind: 'audio' }),
    });
    expect(heard).toEqual({ url: 'https://a.example/spot.mp3', kind: 'audio' });
  });

  test('a thrown fetch is no advert, not an error the caller has to handle', async () => {
    const boom = async () => {
      throw new Error('refused');
    };
    expect(await nextAdvert('video', { slot: 's1', fetchImpl: boom })).toEqual({ url: null });
  });
});

describe('the route', () => {
  test('exists, is unauthenticated, and is never cached', async () => {
    const src = await read('../apps/web/src/app.js');
    const at = src.indexOf("app.get('/api/ads/next'");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 400);
    // A break is one impression and the network meters it. A cached answer would
    // serve one creative to everyone and report it once.
    expect(body).toContain("c.header('cache-control', 'no-store')");
    expect(body).toContain('nextAdvert(');
  });
});

describe('the player side', () => {
  test('the house break machinery is used, not a local reimplementation', async () => {
    const entry = await read('../apps/web/src/client/ads-entry.js');
    expect(entry).toContain("import { attachAds } from '@profullstack/player'");
    expect(entry).toContain("fetch('/api/ads/next'");
    expect(entry).toContain('window.__genreAds');
  });

  /*
   * A film starts and a live channel does not. A pre-roll in front of a stream the
   * reader joined midway through delays them into something that has moved on,
   * which is why this is decided per source rather than set once.
   */
  test('a film gets one in front of it and a live channel does not', async () => {
    const entry = await read('../apps/web/src/client/ads-entry.js');
    expect(entry).toContain('preroll: !opts.live');
    const client = await read('../apps/web/public/app.js');
    expect(client).toContain('startBreaks(stage, video, { live: !vod })');
  });

  /*
   * The whole reason this is a third bundle. The film path exists SO THAT it never
   * loads the transport stream demuxer -- an iPhone has no Media Source and plays
   * the MP4 natively -- so breaks must not be reachable only through that bundle.
   */
  /*
   * The gap this closes. Breaks arrived attached inside the live TV player, which
   * the film path deliberately never loads -- so the page a reader reaches from a
   * search engine, which plays a film, got no advert at all.
   */
  test('the film path gets breaks, not only the live one', async () => {
    const client = await read('../apps/web/public/app.js');
    // One attach site, reached on both paths, with the kind passed in.
    expect(client).toContain('startBreaks(stage, video, { live: !vod })');
    const player = await read('../apps/web/src/client/player-entry.js');
    expect(player).not.toContain('attachAds');
    expect(player).not.toContain('AD_EVERY_SECONDS');
  });

  test('breaks ship separately from the demuxer', async () => {
    const build = await read('../apps/web/build-client.js');
    expect(build).toContain("['ads-entry.js', 'vendor-ads.js']");
    const player = await read('../apps/web/src/client/player-entry.js');
    expect(player).not.toContain('attachAds');
    // Served, and cache-busted like every other asset.
    const src = await read('../apps/web/src/app.js');
    expect(src).toContain("['/vendor-ads.js', 'vendor-ads.js', 'text/javascript']");
    const views = await read('../apps/web/src/views/pages.jsx');
    expect(views).toContain("data-ads-src={assetUrl('vendor-ads.js')}");
  });

  /*
   * The priority that must never invert: the reader asked for the programme and did
   * not ask for the advert. A bundle that will not download, or a controller that
   * throws, costs them nothing.
   */
  test('an advert that cannot be loaded never costs the reader their programme', async () => {
    const client = await read('../apps/web/public/app.js');
    const at = client.indexOf('const ads = await loadAdsBundle(');
    expect(at).toBeGreaterThan(-1);
    expect(client.slice(at, at + 220)).toContain('} catch {');
    // And the controller is released with the stage it drew into, or a channel
    // switched twice leaves two timers running against an element nobody can see.
    expect(client).toContain('breaks?.destroy()');
  });
});
