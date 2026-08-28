import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Dropping the .m3u download on a phone.
 *
 * The download is right on a desktop and a trap on iOS, where Safari either
 * offers to save the playlist or follows it and offers to save a .ts. Neither
 * plays: these providers serve MPEG-2 Transport Stream and Safari has no demuxer
 * for it. Both endings were reported before this existed.
 *
 * app.js is a classic script that runs its bootstrap on load, so the one function
 * is sliced out and evaluated against a small fake DOM. Chrome's --touch-events
 * flag does NOT set the `pointer: coarse` media feature, so driving a real
 * browser proves nothing here; the media query has to be controlled directly.
 */

const SRC = readFileSync(new URL('../apps/web/public/app.js', import.meta.url).pathname, 'utf8');

/** Just the function under test, with no bootstrap. */
function loadFn() {
  const start = SRC.indexOf('function initOwnChannelActions');
  expect(start).toBeGreaterThan(-1);
  return SRC.slice(start);
}

/** Enough DOM for this function and nothing more. */
function fakeDom({ links }) {
  const made = [];
  const appended = [];

  const actions = {
    dataset: {},
    querySelectorAll: (sel) => {
      if (sel.includes('playlist.m3u')) return links.filter((l) => l.href.includes('playlist.m3u'));
      if (sel.includes('vlc-x-callback')) {
        return links.filter((l) => /^(vlc-x-callback|infuse):/.test(l.href));
      }
      return [];
    },
    closest: () => section,
  };
  const section = {
    querySelector: (sel) => (sel === '.player-hint' ? section._hint : null),
    append: (...nodes) => {
      section._hint = nodes[0];
      appended.push(...nodes);
    },
    _hint: null,
  };

  const document = {
    querySelectorAll: (sel) => (sel === '.own-channel-actions' ? [actions] : []),
    createElement: (tag) => {
      const el = {
        tag,
        className: '',
        textContent: '',
        href: '',
        rel: '',
        children: [],
        append: (...n) => el.children.push(...n),
      };
      made.push(el);
      return el;
    },
  };

  return { document, actions, section, made, appended, links };
}

function run(matches, dom) {
  const window = { matchMedia: () => ({ matches }) };
  const fn = new Function('window', 'document', `${loadFn()}\n;return initOwnChannelActions;`)(
    window,
    dom.document,
  );
  fn(dom.document);
}

const linkSet = () => {
  const removed = [];
  return {
    removed,
    links: [
      { href: '/events/190/playlist.m3u?n=0', remove: () => removed.push('m3u') },
      { href: 'vlc-x-callback://x-callback-url/stream?url=x', remove: () => removed.push('vlc') },
      { href: 'infuse://x-callback-url/play?url=x', remove: () => removed.push('infuse') },
    ],
  };
};

describe('on a phone', () => {
  test('the .m3u download is removed', () => {
    const { links, removed } = linkSet();
    run(true, fakeDom({ links }));
    expect(removed).toEqual(['m3u']);
  });

  test('the player deep link survives', () => {
    const { links, removed } = linkSet();
    run(true, fakeDom({ links }));
    // Removing this would leave nothing that can play at all.
    expect(removed).not.toContain('vlc');
  });

  test('a hint says where to get a player, because a missing app fails silently', () => {
    // iOS ignores an unregistered scheme without any error, which reads exactly
    // like a broken button.
    const { links } = linkSet();
    const dom = fakeDom({ links });
    run(true, dom);
    const hint = dom.made.find((e) => e.className.includes('player-hint'));
    expect(hint).toBeDefined();
    expect(dom.made.some((e) => e.tag === 'a' && e.href.includes('videolan.org'))).toBe(true);
  });

  test('the hint is added once, not once per channel', () => {
    const { links } = linkSet();
    const dom = fakeDom({ links });
    run(true, dom);
    run(true, dom);
    expect(dom.made.filter((e) => e.className.includes('player-hint'))).toHaveLength(1);
  });
});

/**
 * The mirror image, and the half that was missing.
 *
 * `vlc-x-callback://` and `infuse://` are the schemes the iOS and Android apps
 * register. A desktop has no meaning for them: the app opens, is handed the whole
 * scheme string as its MRL, and reports that it cannot open it -- so the button
 * looked like it worked and then failed, next to a .m3u that plays fine.
 */
describe('on a desktop', () => {
  test('the .m3u download survives, because it is the one that works there', () => {
    const { links, removed } = linkSet();
    run(false, fakeDom({ links }));
    expect(removed).not.toContain('m3u');
  });

  test('the app deep links are removed', () => {
    const { links, removed } = linkSet();
    run(false, fakeDom({ links }));
    expect(removed).toEqual(['vlc', 'infuse']);
  });

  test('no phone hint is added', () => {
    // "Get VLC if nothing happens when you tap" is advice for a phone.
    const { links } = linkSet();
    const dom = fakeDom({ links });
    run(false, dom);
    expect(dom.made).toHaveLength(0);
  });

  test('a second pass over the same row does nothing twice', () => {
    const { links, removed } = linkSet();
    const dom = fakeDom({ links });
    run(false, dom);
    run(false, dom);
    expect(removed).toEqual(['vlc', 'infuse']);
  });
});
