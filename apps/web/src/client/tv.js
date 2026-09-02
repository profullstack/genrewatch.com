/**
 * Is this a television?
 *
 * Asked for one reason: a Fire TV stick and a laptop want opposite things from
 * the same live stream, and the player has been tuned for the laptop.
 *
 * On a desktop the connection is fast and steady, so reading ahead is wasted
 * latency and chasing the live edge keeps a match from drifting minutes behind.
 * On a stick behind household wifi, decoding a transport stream on a CPU an order
 * of magnitude slower, both of those choices are actively harmful: with no
 * read-ahead buffer every jitter spike is a stall, and latency chasing answers a
 * stall by seeking forward, which is a stall the reader can see. The stream stops
 * and starts until it is abandoned, which is what "it does not play on Silk"
 * looks like from the sofa.
 *
 * So the buffering profile is picked per screen. There is no feature to detect
 * here -- the difference is the device, not the API surface -- so this is a user
 * agent test, which is exactly the kind of thing that ages badly and is therefore
 * kept to one list in one file with a test beside it.
 *
 * The patterns are the same set media-streamer uses, and deliberately so: these
 * two players face the same devices and a device that is a television in one and
 * a desktop in the other is a bug waiting in whichever was not looked at.
 */

/**
 * Ordered most specific first, so a Fire TV is a Fire TV rather than a generic
 * Android with the Silk browser on it.
 */
const TV_PATTERNS = [
  // Amazon Fire TV -- the model string, which is the only reliable marker: some
  // Fire TV builds report a plain Chrome user agent with no "Silk" in it.
  [/\bAFT[A-Z0-9]+\b/i, 'firetv'],
  // Kindle Fire tablets.
  [/\bKF[A-Z]+\b/, 'silk'],
  // The Silk browser anywhere else.
  [/\bSilk\b/i, 'silk'],
  [/\bAndroid TV\b/i, 'androidtv'],
  [/\bGoogleTV\b/i, 'googletv'],
  [/\bTizen\b/i, 'tizen'],
  [/\bWeb0S\b/i, 'webos'],
  [/\bRoku\b/i, 'roku'],
  [/AppleTV/i, 'appletv'],
  [/\bCrKey\b/i, 'chromecast'],
  [/\bSMART-TV\b/i, 'smarttv'],
  [/\bSmartTV\b/i, 'smarttv'],
];

/**
 * Which television, or null for anything else.
 *
 * @param {string} userAgent
 * @returns {string|null}
 */
export function tvBrowserType(userAgent) {
  if (!userAgent) return null;
  for (const [re, type] of TV_PATTERNS) if (re.test(userAgent)) return type;
  return null;
}

/**
 * @param {string} userAgent
 * @returns {boolean}
 */
export function isTvBrowser(userAgent) {
  return tvBrowserType(userAgent) !== null;
}

/**
 * mpegts.js settings for one screen or the other.
 *
 * Everything here except the two buffering decisions is the same on both, and the
 * comments on those live with the values rather than in the caller, because the
 * reason a value differs is the only interesting thing about it.
 *
 * Neither screen chases the live edge any more. That was the one setting that
 * genuinely differed in kind rather than in degree, and it was the desktop's
 * stutter; see below.
 *
 * @param {boolean} isTv
 */
export function playerConfig(isTv) {
  const shared = {
    // lazyLoad pauses the download once enough is buffered, which for a live
    // stream means dropping the connection mid-match and reconnecting.
    lazyLoad: false,
    /*
     * Drop what has already been watched.
     *
     * A film is two hours. Without this the source buffer keeps every second of
     * it in memory and the tab is killed somewhere in the third act -- on a Fire
     * TV, considerably sooner than that.
     */
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 30,
    autoCleanupMinBackwardDuration: 10,
  };

  if (isTv) {
    return {
      ...shared,
      /*
       * Read ahead, and do not chase.
       *
       * The stash is a read-ahead buffer. On a desktop it is pure added latency;
       * on a stick going through the proxy it is the only thing standing between
       * a wifi hiccup and a stall, so it is on and generously sized. 384KB is
       * mpegts.js's own default and roughly a second of a broadcast bitrate.
       *
       * Latency chasing is off for the same reason it is on below. Its answer to
       * drift is to seek the media element forward; on a link that drifts because
       * it is struggling, that is a seek every few seconds, and a seek during a
       * live stream is a rebuffer. Being ten seconds behind is not a complaint
       * anybody makes about a film. Stopping every ten seconds is.
       */
      enableStashBuffer: true,
      stashInitialSize: 384 * 1024,
      liveBufferLatencyChasing: false,
      liveBufferLatencyMaxLatency: 12,
      liveBufferLatencyMinRemain: 2,
    };
  }

  return {
    ...shared,
    /*
     * A desktop wants a SMALLER version of what the television gets, not the
     * opposite of it. It was given the opposite, and both halves were wrong.
     *
     * The stash was off, on the reasoning that read-ahead is pure added latency
     * on a real connection. But the latency being smoothed is not the reader's
     * bandwidth, it is the PROVIDER's pacing: a transport stream arrives in
     * bursts, and with nothing buffered every gap between bursts is an underrun
     * however fast the link. 384KB is mpegts.js's own default, roughly a second.
     *
     * Latency chasing was on, to skip forward when the stream drifts behind.
     * mpegts.js implements that by assigning to `currentTime` -- a hard seek, on
     * every appended fragment, and MSE rebuilds the decode pipeline for each one.
     * It leaves only `MinRemain` seconds of buffer behind, which was one: a
     * single jitter spike from an underrun, the underrun refills past the
     * ceiling, and it seeks again. That sawtooth was most of the desktop stutter,
     * and each hitch was also a chance to spend a restart -- which is how a
     * stutter became a stream that ended.
     *
     * Both screens now read ahead and neither seeks. They differ in how much they
     * hold and how close they sit to the edge, which is the only thing the device
     * should have been deciding. The two bounds are inert while chasing is off,
     * and are kept as the bound anyone re-enabling it would want.
     */
    enableStashBuffer: true,
    stashInitialSize: 384 * 1024,
    liveBufferLatencyChasing: false,
    liveBufferLatencyMaxLatency: 5,
    liveBufferLatencyMinRemain: 1,
  };
}
