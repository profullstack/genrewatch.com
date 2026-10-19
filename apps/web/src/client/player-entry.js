/**
 * The in-page player, bundled as a global.
 *
 * Bundled rather than pulled from a CDN, for the same reason the WebAuthn helper
 * is: no third-party origin in the path of something the page depends on, and
 * nothing to allow through a strict CSP later.
 *
 * Loaded on DEMAND, though, and that is the difference from vendor-webauthn.js.
 * The house player's transport stream engine carries a full MPEG-2 demuxer, a
 * few hundred kilobytes, and most readers never press play on a live channel. app.js injects the tag when the button is actually used, so the page
 * weight is paid by the reader who wanted it.
 *
 * What it does: a browser has no TS demuxer for <video> and never will, so the
 * bytes are demuxed client side, remuxed into fragmented MP4 and pushed into
 * Media Source Extensions. That is why this runs on the client rather than the
 * server -- the alternative is ffmpeg per viewer, which is a fleet rather than a
 * feature.
 *
 * The delivery is @profullstack/player's `attachSource`, the same engine every
 * fleet site plays through: the rebuild-on-MSE-error ladder, the frozen-clock
 * watcher, the budget that refills on `playing`, the codec check on media info
 * and the buffering profile all live there, and were ported FROM this file. What
 * stays here is what only this site knows: the <video> and its controls (owned
 * by app.js), the advice next to a codec failure, and
 * what each status from our own proxy means (stream-errors.js).
 */

import { attachSource, isTvBrowser } from '@profullstack/player';
import { ADVICE } from './codecs.js';
import { classifyStreamError } from './stream-errors.js';

/**
 * Can this browser play at all?
 *
 * The honest question is not "is this Safari" but "is there a Media Source to
 * push H.264 and AAC fragments into" -- the same test the demuxer makes for
 * itself, asked here first so the page can keep its VLC buttons rather than
 * draw a player that will only apologise. Either kind counts: the demuxer feeds
 * ManagedMediaSource too, which is how an iPhone on iOS 17.1 or later plays.
 */
const AVC_AAC = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
function supported() {
  try {
    return [window.MediaSource, window.ManagedMediaSource].some(
      (source) => typeof source?.isTypeSupported === 'function' && source.isTypeSupported(AVC_AAC),
    );
  } catch {
    return false;
  }
}

/**
 * Attach a stream to a <video> and start it.
 *
 * Synchronous on purpose, though the engine arrives asynchronously: app.js
 * holds the returned function as the one handle that
 * drops the connection, and a teardown that lands while the engine is still
 * attaching must still win.
 *
 * @param {HTMLVideoElement} video
 * @param {string} url the same-origin proxy route; never the provider's own URL
 * @param {(message: string) => void} onError told in words a reader can act on.
 *   Terminal: whatever called this should assume playback has stopped.
 * @param {(message: string|null) => void} [onNotice] told about something the
 *   player is working through. NOT terminal -- null clears it again.
 * @returns {() => void} tears the player down AND drops the connection
 */
function attach(video, url, onError, onNotice = () => {}) {
  let stopped = false;
  let attached = null;

  attachSource(video, {
    src: url,
    // Our proxy routes do not always end in .ts, and they are always a
    // transport stream: the route refuses a playlist outright.
    kind: 'mpegts',
    live: true,
    isTv: isTvBrowser(navigator.userAgent),
    // The proxy authenticates by session cookie.
    withCredentials: true,
    unplayableAdvice: ADVICE,
    unplayableSubject: 'channel',
    onStreamError: classifyStreamError,
    onError: (message) => {
      if (!stopped) onError(message);
    },
    onNotice: (message) => {
      if (!stopped) onNotice(message);
    },
  }).then(
    (handle) => {
      if (stopped) {
        handle.destroy();
        return;
      }
      attached = handle;
      if (handle.unplayable) return; // onError has already said why
      // A play() rejection is not an error worth reporting: it is nearly always
      // an autoplay policy, and the reader can press the control themselves.
      video.play?.()?.catch?.(() => {});
    },
    () => {
      if (!stopped) onError('The player could not be loaded. Please reload the page.');
    },
  );

  return () => {
    stopped = true;
    attached?.destroy();
    attached = null;
    // destroy() releases the media element; this releases the socket, which is
    // the one the reader's subscription counts.
    video.removeAttribute('src');
    video.load();
  };
}

/*
 * Breaks are NOT attached here.
 *
 * A stored file is handed straight to the element and never loads this bundle
 * at all -- that is the whole reason the two paths exist, because an iPhone has
 * no Media Source and plays the MP4 natively. So the break machinery lives in
 * vendor-ads.js, which app.js loads on the same press for both paths.
 */

window.__genrePlayer = { supported, attach };
