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
import { isTvBrowser, playerConfig } from './tv.js';

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
 * How many times a stream is rebuilt before the reader is told it failed.
 *
 * Three, with the wait doubling, so the whole sequence is over in about eleven
 * seconds. It has to be bounded and it has to be short: every restart is a fresh
 * connection to the provider, and the line permits one.
 */
const MAX_RESTARTS = 3;
const RESTART_BASE_MS = 1500;

/** How a stall is noticed: the clock is read this often, this many times. */
const STALL_CHECK_MS = 5000;
const STALL_LIMIT = 3;

/**
 * Playback this long since the last restart means the trouble is over, and the
 * budget goes back to full. Without it a channel that breaks once an hour spends
 * its three restarts over an afternoon and then fails for good.
 */
const RECOVERED_AFTER_MS = 30_000;

/**
 * Attach a stream to a <video> and start it.
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
  const config = playerConfig(isTvBrowser(navigator.userAgent));

  let player = null;
  let stopped = false;
  let restarts = 0;
  let restartTimer = null;
  let stallTimer = null;
  let startedAt = 0;
  let lastTime = -1;
  let stalls = 0;

  const clearTimers = () => {
    if (restartTimer) clearTimeout(restartTimer);
    if (stallTimer) clearInterval(stallTimer);
    restartTimer = null;
    stallTimer = null;
  };

  const destroyPlayer = () => {
    if (!player) return;
    const dying = player;
    player = null;
    try {
      dying.destroy();
    } catch {}
  };

  /** The end of the road: nothing is playing and the reader is told why. */
  const giveUp = (message) => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    destroyPlayer();
    onError(message);
  };

  /*
   * Build it again rather than give up.
   *
   * This is the difference between this player and the one that reported
   * "That stream could not be played here (MediaMSEError). Try VLC." on a channel
   * that was streaming perfectly well.
   *
   * mpegts.js opens ONE source buffer per track and configures it from the first
   * init segment it produces. A live transport stream is under no obligation to
   * stay the same shape: an ad break, a regional opt-out or a programme junction
   * can change the audio configuration or the PMT mid-stream, and mpegts.js then
   * emits an init segment whose codec no longer matches the buffer it has. It
   * logs "mimeType changed" and appends anyway -- there is no `changeType()` call
   * in the library -- Media Source Extensions throws, and that arrives here as
   * MediaMSEError with the stream still perfectly playable.
   *
   * Nothing can be done to that source buffer from out here. What CAN be done is
   * throw the whole player away and build a new one, which starts from the
   * stream's current shape and simply works. That is a reconnect, so it is
   * bounded, spaced out, and it says so on the page rather than freezing.
   */
  const restart = (finalMessage) => {
    if (stopped) return;
    if (restarts >= MAX_RESTARTS) return giveUp(finalMessage);
    restarts += 1;
    clearTimers();
    destroyPlayer();
    onNotice(`Reconnecting… (${restarts}/${MAX_RESTARTS})`);
    restartTimer = setTimeout(
      () => {
        restartTimer = null;
        if (!stopped) start();
      },
      RESTART_BASE_MS * 2 ** (restarts - 1),
    );
  };

  /*
   * A stream that stops sending never errors -- it just stops.
   *
   * The picture freezes, the connection stays open, and mpegts.js has nothing to
   * report because nothing failed. On a Fire TV that is the ordinary way an
   * evening ends. So the media clock is watched, and fifteen seconds of a playing
   * video whose currentTime has not moved is treated as the error it is.
   */
  const watchForStalls = () => {
    if (stallTimer) clearInterval(stallTimer);
    lastTime = video.currentTime;
    stalls = 0;
    stallTimer = setInterval(() => {
      if (stopped || !player) return;
      if (video.paused || video.ended || video.seeking) {
        stalls = 0;
        lastTime = video.currentTime;
        return;
      }
      if (video.currentTime === lastTime) {
        stalls += 1;
        if (stalls >= STALL_LIMIT) {
          stalls = 0;
          restart('The stream stopped sending. Try VLC, or press Play again.');
        }
        return;
      }
      // It is moving. If it has been moving for a while, the earlier trouble is
      // over and this counts as a healthy stream again.
      lastTime = video.currentTime;
      stalls = 0;
      if (restarts > 0 && Date.now() - startedAt > RECOVERED_AFTER_MS) {
        restarts = 0;
        onNotice(null);
      }
    }, STALL_CHECK_MS);
  };

  function start() {
    startedAt = Date.now();

    /*
     * The buffering profile is picked per screen, not once for the site.
     *
     * A laptop wants the live edge and no read-ahead; a Fire TV stick on
     * household wifi wants the opposite, and giving it the laptop's settings is
     * most of what "it does not play on Silk" turns out to mean. The two sets and
     * the reasoning for each live in tv.js.
     */
    player = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url, withCredentials: true },
      config,
    );

    /*
     * The codec check, which has to happen here and not before pressing Play.
     *
     * Nothing about the channel says what is inside it until the demuxer has read
     * the stream: the playlist gives a name and a URL, the response gives
     * video/mp2t, and a transport stream carries whatever the broadcaster put in
     * it. So the first honest moment is media info -- and it arrives before the
     * source buffer MSE is about to refuse, which means the reader gets the reason
     * instead of a black rectangle that stops.
     *
     * Terminal, and deliberately: a browser with no HEVC decoder will not grow one
     * on the second attempt, so there is nothing to reconnect for.
     */
    player.on(mpegts.Events.MEDIA_INFO, (info) => {
      const reason = unplayableReason(
        info,
        (t) => window.MediaSource?.isTypeSupported?.(t) ?? false,
      );
      if (reason) giveUp(reason);
    });

    /*
     * Turn a loader failure back into the sentence the route meant.
     *
     * The proxy answers a failure with a status and a JSON reason, and the reader
     * sees neither: the request belongs to the library, which reports a category
     * and a status code. Reading the body instead would mean issuing the request
     * twice, and the second one is a second connection on a line that counts them.
     * So the code is mapped here, and each of these corresponds to a branch of the
     * route.
     *
     * Every branch that names a status is terminal, because each of them is the
     * server having decided something: reconnecting to be told the same thing
     * three times over is worse than being told once.
     */
    player.on(mpegts.Events.ERROR, (type, detail, info) => {
      const code = info?.code;
      // 429 is no longer a thing this route says -- starting a second channel now
      // takes the line over rather than being refused. Kept because something in
      // front of the app (a proxy, a WAF) can still say it, and "try again" is the
      // right advice for that, where "stop the other one" never was.
      if (code === 429) return giveUp('The line was busy. Try that again.');
      /*
       * Somebody else is watching a SHARED line.
       *
       * Only the shared route says this, and it says it rather than evicting. On a
       * reader's own line eviction is right -- pressing Play elsewhere says which
       * entry they want now. Taking a stranger's film off them because you clicked
       * something is a different act, so the shared route refuses and this is the
       * sentence that explains why.
       *
       * Reconnecting here would be worse than useless: three more attempts on a
       * line somebody else is using is exactly the concurrency the provider
       * suspends accounts for.
       */
      if (code === 409) {
        return giveUp('Somebody else is watching that line right now. Try again in a bit.');
      }
      if (code === 404) return giveUp('That channel is no longer on your list.');
      if (code === 415) return giveUp('That channel needs a different player. Try VLC.');
      if (code === 502 || code === 504) {
        return giveUp('Your provider did not send a stream for that channel.');
      }
      if (type === mpegts.ErrorTypes.NETWORK_ERROR) {
        /*
         * No status code, so this is the socket rather than the server: the line
         * dropped, wifi went, the provider hung up mid-match. All three are worth
         * one more try, and on a stick they are the common case.
         */
        return restart(
          'The stream stopped. Your provider may have dropped it, or you started another channel somewhere else.',
        );
      }
      // Everything else is a demux or MSE failure, and the detail is the only
      // thing that distinguishes "this browser will not decode Dolby" from "the
      // stream changed shape halfway through". The second is recoverable by
      // rebuilding, the first is not -- and the codec check above has already
      // taken the first out, so this rebuilds and only reports if that fails too.
      restart(
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
    watchForStalls();
  }

  /*
   * A picture is the only proof worth acting on.
   *
   * "Reconnecting…" has to come off the page the moment the stream is back, and
   * the event that means it is back is this one -- not the absence of another
   * error, which is also what a permanently frozen player looks like. The restart
   * budget is NOT cleared here: a second of playback between two failures is not
   * a recovery, and thirty are (see the stall watcher).
   */
  const onPlaying = () => onNotice(null);
  video.addEventListener('playing', onPlaying);

  start();

  return () => {
    stopped = true;
    clearTimers();
    video.removeEventListener('playing', onPlaying);
    destroyPlayer();
    // destroy() releases the media element; this releases the socket, which is
    // the one the reader's subscription counts.
    video.removeAttribute('src');
    video.load();
  };
}

window.__genrePlayer = { supported, attach };
