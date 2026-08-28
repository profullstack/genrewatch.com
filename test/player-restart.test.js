import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Rebuilding the player instead of giving up on it.
 *
 * The reported symptom was "That stream could not be played here (MediaMSEError).
 * Try VLC." on a channel that was streaming perfectly well, and the cause is not
 * in this repo: mpegts.js configures one source buffer per track from the first
 * init segment and has no `changeType()` call anywhere in it. A live transport
 * stream is under no obligation to keep the same shape -- an ad break or a
 * regional opt-out changes the audio configuration -- so the library eventually
 * appends an init segment its own source buffer will not take, Media Source
 * Extensions throws, and the player is dead with the stream still fine.
 *
 * A new player built at that moment starts from the stream's current shape and
 * works. So the error is a reason to reconnect, not a reason to stop, and this
 * file is about which errors are which -- because reconnecting to the wrong one
 * means three more connections on a line that suspends accounts for concurrency.
 *
 * Both clocks are driven by hand. Real timers would make a test of a backoff
 * schedule take eleven seconds and still be flaky.
 */

/** A clock whose timers only fire when this test says so. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + (ms || 0), every: null });
      return id;
    },
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + (ms || 0), every: ms || 1 });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    now: () => now,
    /** Run every timer due in the next `ms`, in the order they come due. */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= until && (due === null || t.at < timers.get(due).at)) due = id;
        }
        if (due === null) break;
        const t = timers.get(due);
        now = t.at;
        if (t.every) t.at = now + t.every;
        else timers.delete(due);
        t.fn();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

/** Every player mpegts.js was asked to build, newest last. */
const built = [];

const EVENTS = { MEDIA_INFO: 'media_info', ERROR: 'error', LOADING_COMPLETE: 'loading_complete' };
const ERROR_TYPES = { NETWORK_ERROR: 'NetworkError', MEDIA_ERROR: 'MediaError' };

mock.module('mpegts.js', () => ({
  default: {
    Events: EVENTS,
    ErrorTypes: ERROR_TYPES,
    getFeatureList: () => ({ mseLivePlayback: true }),
    createPlayer(source, config) {
      const player = {
        source,
        config,
        destroyed: false,
        handlers: {},
        on(event, fn) {
          player.handlers[event] = fn;
        },
        attachMediaElement() {},
        load() {},
        play: () => undefined,
        destroy() {
          player.destroyed = true;
        },
        emit(event, ...args) {
          player.handlers[event]?.(...args);
        },
      };
      built.push(player);
      return player;
    },
  },
}));

/** Enough of a <video> for the player to drive. */
function fakeVideo() {
  const listeners = {};
  return {
    currentTime: 0,
    paused: false,
    ended: false,
    seeking: false,
    listeners,
    addEventListener: (name, fn) => {
      listeners[name] = [...(listeners[name] ?? []), fn];
    },
    removeEventListener: (name, fn) => {
      listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn);
    },
    fire: (name) => {
      for (const fn of listeners[name] ?? []) fn();
    },
    removeAttribute: () => {},
    load: () => {},
  };
}

const DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/*
 * A browser is faked here, and it MUST be put back.
 *
 * bun:test runs every file in one runtime, so a `window` left on globalThis is
 * not this file's business alone: PGlite feature-detects a browser that way and
 * goes looking for `window.location.pathname`, which took nine unrelated database
 * tests down the first time this was written without the restore.
 */
const REAL = { window: globalThis.window, navigator: globalThis.navigator };

function restoreGlobals() {
  for (const key of ['window', 'navigator']) {
    if (REAL[key] === undefined) {
      try {
        delete globalThis[key];
      } catch {
        globalThis[key] = undefined;
      }
    } else {
      globalThis[key] = REAL[key];
    }
  }
}

/** Chromium's real answers, so the codec check behaves as it does in a browser. */
function fakeGlobals() {
  globalThis.window = {
    MediaSource: { isTypeSupported: (t) => /avc1|mp4a\.40\.(2|5|29)\b/.test(t) },
  };
  globalThis.navigator = { userAgent: DESKTOP };
}

/**
 * Imported once, on purpose.
 *
 * player-entry.js is a bundle entry point, not a module with exports: it hangs
 * `attach` off `window` as a side effect of being evaluated, and ES modules
 * evaluate once per process. So the handle is taken here and each test replaces
 * the globals underneath it -- which is how the real thing works anyway, since
 * everything it touches is read at call time rather than captured.
 */
fakeGlobals();
await import('../apps/web/src/client/player-entry.js');
const attach = globalThis.window.__genrePlayer.attach;
restoreGlobals();

let clock;
let saved;

beforeEach(() => {
  clock = fakeClock();
  saved = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
    dateNow: Date.now,
  };

  globalThis.setTimeout = clock.setTimeout;
  globalThis.setInterval = clock.setInterval;
  globalThis.clearTimeout = clock.clear;
  globalThis.clearInterval = clock.clear;
  Date.now = clock.now;

  fakeGlobals();
  built.length = 0;
});

afterEach(() => {
  globalThis.setTimeout = saved.setTimeout;
  globalThis.setInterval = saved.setInterval;
  globalThis.clearTimeout = saved.clearTimeout;
  globalThis.clearInterval = saved.clearInterval;
  Date.now = saved.dateNow;
  restoreGlobals();
});

/** Start a player and hand back everything a test needs to poke at it. */
function play() {
  const video = fakeVideo();
  const errors = [];
  const notices = [];
  const stop = attach(
    video,
    '/my/channels/7/stream.ts',
    (m) => errors.push(m),
    (m) => notices.push(m),
  );
  return { video, errors, notices, stop, latest: () => built[built.length - 1] };
}

describe('an MSE failure is a reason to reconnect', () => {
  test('the first one rebuilds the player rather than reporting', () => {
    const { errors, notices, latest } = play();
    const first = latest();

    first.emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});

    expect(errors).toEqual([]);
    expect(notices.at(-1)).toContain('Reconnecting');
    expect(first.destroyed).toBe(true);

    // Nothing reconnects instantly: that is a second connection on a line that
    // counts them, and the first has to be seen to close.
    expect(built).toHaveLength(1);
    clock.advance(1500);
    expect(built).toHaveLength(2);
    expect(latest().destroyed).toBe(false);
  });

  test('the waits double, and the whole sequence is over in about eleven seconds', () => {
    const { errors, latest } = play();

    latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
    clock.advance(1500);
    latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
    clock.advance(3000);
    latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
    clock.advance(6000);

    expect(built).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  test('a fourth failure is the reader being told, in the original words', () => {
    const { errors, latest } = play();

    for (const wait of [0, 1500, 3000, 6000]) {
      clock.advance(wait);
      latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('MediaMSEError');
    expect(errors[0]).toContain('VLC');
    // And it stops trying.
    expect(latest().destroyed).toBe(true);
    const count = built.length;
    clock.advance(60_000);
    expect(built).toHaveLength(count);
  });

  test('a dropped connection reconnects too', () => {
    const { errors, latest } = play();
    latest().emit(EVENTS.ERROR, ERROR_TYPES.NETWORK_ERROR, 'Exception', {});
    clock.advance(1500);
    expect(built).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});

describe('what must never be reconnected', () => {
  /*
   * Each of these is the server having decided something. Three more attempts
   * gets the same answer three more times, and in the 409 case those are three
   * more concurrent connections on somebody else's line -- which is the exact
   * thing a provider suspends an account for.
   */
  const terminal = [
    [409, 'Somebody else is watching'],
    [404, 'no longer on your list'],
    [415, 'needs a different player'],
    [429, 'line was busy'],
    [502, 'did not send a stream'],
    [504, 'did not send a stream'],
  ];

  for (const [code, expected] of terminal) {
    test(`${code} is reported once and never retried`, () => {
      const { errors, latest } = play();
      latest().emit(EVENTS.ERROR, ERROR_TYPES.NETWORK_ERROR, 'Exception', { code });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(expected);
      clock.advance(60_000);
      expect(built).toHaveLength(1);
    });
  }

  test('a codec this browser cannot decode is terminal, not retried', () => {
    // A browser without an HEVC decoder will not have grown one by the second
    // attempt. Reconnecting three times to fail the same way wastes the line.
    const { errors, latest } = play();
    latest().emit(EVENTS.MEDIA_INFO, { videoCodec: 'hvc1.1.6.L93.B0', audioCodec: 'mp4a.40.2' });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('H.265');
    clock.advance(60_000);
    expect(built).toHaveLength(1);
  });

  test('AAC Main is not an error at all any more', () => {
    // The Silk bug: mpegts.js rewrites this to LC before MSE ever sees it.
    const { errors, notices, latest } = play();
    latest().emit(EVENTS.MEDIA_INFO, { videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.1' });
    expect(errors).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('a stream that stops sending without ever erroring', () => {
  test('fifteen seconds of a frozen clock is treated as the failure it is', () => {
    // The picture stops, the socket stays open, and mpegts.js reports nothing
    // because nothing failed. On a stick this is how an evening usually ends.
    const { video, notices } = play();

    // Playing normally, and then the clock stops moving.
    video.currentTime = 12;
    clock.advance(5000);

    clock.advance(5000);
    clock.advance(5000);
    // Two readings of a frozen clock is a buffer, not a dead stream.
    expect(notices).toEqual([]);

    clock.advance(5000);
    expect(notices.at(-1)).toContain('Reconnecting');
  });

  test('a clock that is still moving is left alone', () => {
    const { video, notices, errors } = play();
    for (let i = 0; i < 10; i += 1) {
      video.currentTime += 5;
      clock.advance(5000);
    }
    expect(notices.filter(Boolean)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a paused video is not a stalled one', () => {
    const { video, notices } = play();
    video.paused = true;
    clock.advance(60_000);
    expect(notices.filter(Boolean)).toEqual([]);
  });
});

describe('the reconnect budget', () => {
  test('half a minute of real playback earns it back', () => {
    // Otherwise a channel that hiccups once an hour spends its three restarts
    // over an afternoon and then fails for good on a stream that is basically
    // healthy.
    const { video, latest, errors } = play();

    latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
    clock.advance(1500);
    expect(built).toHaveLength(2);

    for (let i = 0; i < 8; i += 1) {
      video.currentTime += 5;
      clock.advance(5000);
    }

    // Budget restored, so this is a reconnect and not the reader being told.
    latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
    clock.advance(1500);
    expect(built).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  test('a second of playback between two failures does not', () => {
    const { video, latest, errors } = play();
    for (let i = 0; i < 4; i += 1) {
      latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
      clock.advance(1500 * 2 ** i);
      video.currentTime += 1;
      clock.advance(5000);
    }
    expect(errors).toHaveLength(1);
  });

  test('the notice comes off the page as soon as there is a picture', () => {
    const { video, notices, latest } = play();
    latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
    clock.advance(1500);
    expect(notices.at(-1)).toContain('Reconnecting');

    video.fire('playing');
    expect(notices.at(-1)).toBeNull();
  });
});

describe('stopping means stopping', () => {
  test('a pending reconnect is cancelled, not left to fire into a dead page', () => {
    // The teardown path runs on Stop, on a client-side navigation that replaces
    // <main>, and on pagehide. A timer surviving any of those opens a connection
    // on the reader's line for a player that is no longer on screen.
    const { stop, latest } = play();
    latest().emit(EVENTS.ERROR, ERROR_TYPES.MEDIA_ERROR, 'MediaMSEError', {});
    stop();

    clock.advance(60_000);
    expect(built).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  test('the stall watcher stops with it', () => {
    const { video, stop, notices } = play();
    video.currentTime = 3;
    stop();
    clock.advance(60_000);
    expect(notices.filter(Boolean)).toEqual([]);
  });

  test('the player is destroyed, which is what releases the socket', () => {
    const { stop, latest } = play();
    const player = latest();
    stop();
    expect(player.destroyed).toBe(true);
  });
});
