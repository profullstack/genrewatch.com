import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { firstLiveChannel, probeStream } from '../packages/playlists/src/probe.js';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Asking a stream whether it is there before handing anybody a file.
 *
 * The bug this closes: the route took the channel at an index, wrote its URL into
 * an .m3u and sent it, and nothing ever asked the provider whether that slot was
 * streaming. Most are not -- a provider list is aspirational, and a large share
 * answer 200 with an HTML error page where video was advertised. A status check
 * alone calls that healthy, which is why the file downloaded fine and played
 * nothing.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A provider answering with whatever headers we want to pretend it sent. */
const answering = (status, contentType) => {
  globalThis.fetch = async () =>
    new Response('x', { status, headers: contentType ? { 'content-type': contentType } : {} });
};

describe('what counts as a live stream', () => {
  test('video and audio types are live', async () => {
    answering(206, 'video/mp2t');
    expect((await probeStream('http://x/1')).live).toBe(true);
    answering(200, 'audio/aac');
    expect((await probeStream('http://x/1')).live).toBe(true);
  });

  test('MPEG-TS and HLS manifests are live', async () => {
    for (const t of ['application/octet-stream', 'application/vnd.apple.mpegurl']) {
      answering(200, t);
      expect((await probeStream('http://x/1')).live).toBe(true);
    }
  });

  test('an HTML page answering 200 is dead, and says which way', async () => {
    // The whole reason a status check is not enough. This is the common failure:
    // the slot is empty and the provider says so in HTML.
    answering(200, 'text/html; charset=UTF-8');
    const r = await probeStream('http://x/1');
    expect(r.live).toBe(false);
    expect(r.note).toBe('returned a web page, not a stream');
  });

  test('an error status is dead and carries the number', async () => {
    answering(404, 'text/html');
    const r = await probeStream('http://x/1');
    expect(r.live).toBe(false);
    expect(r.note).toContain('404');
  });

  test('a connection that fails is dead rather than throwing', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await probeStream('http://x/1');
    // Not definitive: a fact about the last six seconds rather than about the
    // entry, so it is stored as unknown and the row stays offerable.
    expect(r).toEqual({ live: false, definitive: false, note: 'could not connect' });
  });

  test('something that is not a URL is refused without a request', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('');
    };
    expect((await probeStream('not a url')).live).toBe(false);
    expect(called).toBe(false);
  });

  test('the request is ranged, so a live stream is not held open', async () => {
    let seen;
    globalThis.fetch = async (_url, init) => {
      seen = init;
      return new Response('x', { status: 206, headers: { 'content-type': 'video/mp2t' } });
    };
    await probeStream('http://x/1');
    expect(seen.headers.range).toBe('bytes=0-2047');
    expect(seen.redirect).toBe('follow');
  });
});

describe('picking the first one that answers', () => {
  test('skips dead channels and returns the first live one', async () => {
    const types = { a: 'text/html', b: 'text/html', c: 'video/mp2t' };
    globalThis.fetch = async (url) =>
      new Response('x', { status: 200, headers: { 'content-type': types[String(url).at(-1)] } });

    const { pick, tried } = await firstLiveChannel([
      { id: 1, title: 'A', url: 'http://x/a' },
      { id: 2, title: 'B', url: 'http://x/b' },
      { id: 3, title: 'C', url: 'http://x/c' },
    ]);
    expect(pick.title).toBe('C');
    expect(tried).toHaveLength(3);
  });

  test('stops after the bound rather than walking a whole list', async () => {
    // These are one subscriber's own connections; the line caps how many can be
    // open at once, so an unbounded walk is how an account gets flagged.
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('x', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i, url: `http://x/${i}` }));
    const { pick } = await firstLiveChannel(many, { max: 4 });
    expect(pick).toBeNull();
    expect(calls).toBe(4);
  });

  test('probes one at a time, not all at once', async () => {
    let open = 0;
    let maxOpen = 0;
    globalThis.fetch = async () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return new Response('x', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    await firstLiveChannel(
      Array.from({ length: 4 }, (_, i) => ({ id: i, url: `http://x/${i}` })),
      { max: 4 },
    );
    expect(maxOpen).toBe(1);
  });

  test('reports every verdict, so they can be remembered', async () => {
    answering(200, 'text/html');
    const seen = [];
    await firstLiveChannel([{ id: 7, url: 'http://x/1' }], {
      onResult: (ch, r) => seen.push([ch.id, r.live]),
    });
    expect(seen).toEqual([[7, false]]);
  });
});

describe('the phone guard', () => {
  /**
   * Evaluated against a small fake DOM on purpose. Chrome's --touch-events flag
   * does NOT set the pointer media feature, so a real headless browser reports the
   * desktop result either way and would prove nothing -- the media query has to be
   * controlled directly to exercise the branch at all.
   */
  const run = async ({ phone }) => {
    const src = await readFile(
      new URL('../apps/web/public/app.js', import.meta.url).pathname,
      'utf8',
    );
    const body = src.slice(src.indexOf('function initOwnChannelActions'));
    const fn = new Function(
      'window',
      'document',
      `${body.slice(0, body.length)}; return initOwnChannelActions;`,
    );

    const removed = [];
    const appended = [];
    // Selector-aware, because the function now asks two different questions: a
    // phone loses the file link and a desktop loses the app deep links.
    const actions = {
      dataset: {},
      querySelectorAll: (sel) => {
        if (sel.includes('playlist.m3u')) {
          return [
            { getAttribute: () => '/events/1/playlist.m3u?n=0', remove: () => removed.push('m3u') },
          ];
        }
        return [
          {
            getAttribute: () => 'vlc-x-callback://x-callback-url/stream?url=x',
            remove: () => removed.push('vlc'),
          },
        ];
      },
      closest: () => section,
    };
    const section = { querySelector: () => null, append: (el) => appended.push(el) };
    const doc = {
      querySelectorAll: () => [actions],
      createElement: () => ({ append: () => {}, set className(_) {}, set textContent(_) {} }),
    };
    fn({ matchMedia: () => ({ matches: phone }) }, doc)(doc);
    return { removed, appended };
  };

  test('a phone loses the .m3u link and gains a hint', async () => {
    const { removed, appended } = await run({ phone: true });
    expect(removed).toEqual(['m3u']);
    expect(appended).toHaveLength(1);
  });

  test('a desktop keeps the download it can actually use', async () => {
    const { removed, appended } = await run({ phone: false });
    expect(removed).not.toContain('m3u');
    // No hint either: "Get VLC if nothing happens when you tap" is phone advice.
    expect(appended).toEqual([]);
  });

  test('a desktop loses the deep links, which are phone app schemes', async () => {
    // `vlc-x-callback://` and `infuse://` mean nothing to a desktop app: it opens,
    // is handed the whole scheme string as its MRL, and fails on it -- which read
    // as the button being broken while the .m3u beside it played.
    const { removed } = await run({ phone: false });
    expect(removed).toEqual(['vlc']);
  });

  test('it is keyed on pointer, not on screen width', async () => {
    // A touchscreen laptop has a filesystem and a registered handler; a phone has
    // neither, and a width test would take the download away from the laptop.
    const src = await readFile(
      new URL('../apps/web/public/app.js', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('(hover: none) and (pointer: coarse)');
    expect(src).not.toContain('max-width: 480px)');
  });
});
