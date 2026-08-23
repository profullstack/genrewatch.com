/**
 * The in-page player, bundled as a global.
 *
 * Bundled rather than pulled from a CDN, for the same reason the WebAuthn helper
 * is: no third-party origin in the path of something the page depends on, and
 * nothing to allow through a strict CSP later.
 *
 * Loaded on DEMAND, though, and that is the difference from vendor-webauthn.js.
 * This library is a few hundred kilobytes -- it contains a full MPEG-2 transport
 * stream demuxer -- and almost nobody on an event page is about to press play.
 * app.js injects the tag when the button is actually used, so the page weight is
 * paid by the reader who wanted it.
 *
 * What it does: a browser has no TS demuxer for <video> and never will, so the
 * bytes are demuxed here, remuxed into fragmented MP4 and pushed into Media Source
 * Extensions. That is why this runs on the client rather than the server -- the
 * alternative is ffmpeg per viewer, which is a fleet rather than a feature.
 */

import mpegts from 'mpegts.js';
import { unplayableReason } from './codecs.js';

/**
 * Can this browser play at all?
 *
 * The honest question is not "is this Safari" but "is there a MediaSource to push
 * fragments into", and the library answers it directly. iPhone Safari says no --
 * it has no MSE, only the newer ManagedMediaSource this version does not use --
 * which is exactly why the app buttons stay on the page rather than being
 * replaced by this.
 */
function supported() {
  try {
    return Boolean(mpegts.getFeatureList().mseLivePlayback);
  } catch {
    return false;
  }
}

/**
 * Attach a stream to a <video> and start it.
 *
 * @param {HTMLVideoElement} video
 * @param {string} url the same-origin proxy route; never the provider's own URL
 * @param {(message: string) => void} onError told in words a reader can act on
 * @returns {() => void} tears the player down AND drops the connection
 */
function attach(video, url, onError) {
  const player = mpegts.createPlayer(
    { type: 'mpegts', isLive: true, url, withCredentials: true },
    {
      /*
       * Live settings, and each one is load-bearing.
       *
       * The stash is a read-ahead buffer that exists to smooth a seekable file;
       * on a live stream it is pure added latency, so it is off and the initial
       * chunk is small. Latency chasing skips the player forward when it drifts
       * behind -- without it a stall is never recovered from and the
       * stream just plays permanently late.
       */
      enableStashBuffer: false,
      stashInitialSize: 128,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 6,
      liveBufferLatencyMinRemain: 1,
      // lazyLoad pauses the download once enough is buffered, which for a live
      // stream means dropping the connection mid-match and reconnecting.
      lazyLoad: false,
      /*
       * Drop what has already been watched.
       *
       * A film is two hours. Without this the source buffer keeps every
       * second of it in memory and the tab is killed somewhere in the third act --
       * on a Fire TV, considerably sooner than that.
       */
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 10,
    },
  );

  /*
   * Turn a loader failure back into the sentence the route meant.
   *
   * The proxy answers a failure with a status and a JSON reason, and the reader
   * sees neither: the request belongs to the library, which reports a category
   * and a status code. Reading the body instead would mean issuing the request
   * twice, and the second one is a second connection on a line that counts them.
   * So the code is mapped here, and each of these corresponds to a branch of the
   * route.
   */
  /*
   * The codec check, which has to happen here and not before pressing Play.
   *
   * Nothing about the channel says what is inside it until the demuxer has read
   * the stream: the playlist gives a name and a URL, the response gives
   * video/mp2t, and a transport stream carries whatever the broadcaster put in
   * it. So the first honest moment is media info -- and it arrives before the
   * source buffer MSE is about to refuse, which means the reader gets the reason
   * instead of a black rectangle that stops.
   */
  player.on(mpegts.Events.MEDIA_INFO, (info) => {
    const reason = unplayableReason(info, (t) => window.MediaSource?.isTypeSupported?.(t) ?? false);
    if (reason) onError(reason);
  });

  player.on(mpegts.Events.ERROR, (type, detail, info) => {
    const code = info?.code;
    // 429 is no longer a thing this route says -- starting a second channel now
    // takes the line over rather than being refused. Kept because something in
    // front of the app (a proxy, a WAF) can still say it, and "try again" is the
    // right advice for that, where "stop the other one" never was.
    if (code === 429) return onError('The line was busy. Try that again.');
    if (code === 404) return onError('That channel is no longer on your list.');
    if (code === 415) return onError('That channel needs a different player. Try VLC.');
    if (code === 502 || code === 504) {
      return onError('Your provider did not send a stream for that channel.');
    }
    if (type === mpegts.ErrorTypes.NETWORK_ERROR) {
      return onError(
        'The stream stopped. Your provider may have dropped it, or you started another channel somewhere else.',
      );
    }
    // Everything else is a demux or MSE failure, and the detail is the only thing
    // that distinguishes "this browser will not decode Dolby" from "the stream is
    // malformed". It was being dropped on the floor, which is how a channel that
    // fails for a nameable reason came to read as the player being broken.
    onError(
      detail
        ? `That stream could not be played here (${detail}). Try VLC.`
        : 'That stream could not be played here. Try VLC.',
    );
  });

  player.attachMediaElement(video);
  player.load();
  // A play() rejection is not an error worth reporting: it is nearly always an
  // autoplay policy, and the reader can press the control themselves.
  player.play()?.catch(() => {});

  return () => {
    try {
      player.destroy();
    } catch {}
    // destroy() releases the media element; this releases the socket, which is
    // the one the reader's subscription counts.
    video.removeAttribute('src');
    video.load();
  };
}

window.__genrePlayer = { supported, attach };
