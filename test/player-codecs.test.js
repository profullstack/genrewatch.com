import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { codecName, effectiveCodec, unplayableReason } from '../apps/web/src/client/codecs.js';
import { isTvBrowser, playerConfig, tvBrowserType } from '../apps/web/src/client/tv.js';

/**
 * Why a channel that connects, transfers and then dies says so.
 *
 * "That stream could not be played here. Try VLC." was true and useless. The
 * cause is nearly always the same one and it is nameable: the demuxer handles
 * H.265, AC-3 and E-AC-3 quite happily, repackages them into fMP4, and Media
 * Source Extensions then declines to decode them. A desktop browser has no Dolby
 * licence and often no HEVC path, and it refuses at the source buffer rather than
 * while playing -- so nothing is wrong with the stream, the provider, the line or
 * the proxy, and every one of those got blamed in turn.
 */

/** A browser like desktop Chrome: H.264 and AAC, and nothing more exotic. */
const plainBrowser = (type) => /avc1|mp4a\.40/.test(type);

/**
 * Chromium, answering exactly as it really does.
 *
 * The difference from `plainBrowser` is the whole of the Silk bug: Chromium takes
 * AAC object types 2, 5 and 29 and refuses every other one, including 1 (Main).
 * Verified against Chrome 152 rather than assumed --
 * `MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.1"')` is false, and
 * Amazon Silk is Chromium.
 */
const chromium = (type) => /avc1|mp4a\.40\.(2|5|29)\b/.test(type);

describe('naming a codec', () => {
  test('the names are the ones a person would recognise', () => {
    expect(codecName('hvc1.1.6.L93.B0')).toBe('H.265');
    expect(codecName('ec-3')).toBe('Dolby Digital Plus audio');
    expect(codecName('ac-3')).toBe('Dolby Digital audio');
  });

  test('profile and level suffixes do not leak into the sentence', () => {
    // These vary per channel and mean nothing to a reader.
    expect(codecName('hev1.2.4.L120.90')).toBe('H.265');
  });

  test('an unknown codec is passed through rather than guessed at', () => {
    // Better a mime string the reader can search for than a wrong friendly name.
    expect(codecName('mp4a.something')).toBe('mp4a.something');
    expect(codecName(null)).toBeNull();
  });
});

describe('what this browser can actually decode', () => {
  test('H.264 with AAC is fine and says nothing', () => {
    const reason = unplayableReason(
      { videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.2' },
      plainBrowser,
    );
    expect(reason).toBeNull();
  });

  test('H.265 video is named', () => {
    const reason = unplayableReason(
      { videoCodec: 'hvc1.1.6.L93.B0', audioCodec: 'mp4a.40.2' },
      plainBrowser,
    );
    expect(reason).toContain('H.265');
    expect(reason).toContain('VLC');
  });

  test('Dolby audio on an otherwise playable stream is named', () => {
    // The common one, and the most confusing: the picture would have worked.
    const reason = unplayableReason(
      { videoCodec: 'avc1.64001f', audioCodec: 'ac-3' },
      plainBrowser,
    );
    expect(reason).toContain('Dolby Digital audio');
  });

  test('both halves unplayable reads as one sentence', () => {
    const reason = unplayableReason(
      { videoCodec: 'hvc1.1.6.L93.B0', audioCodec: 'ec-3' },
      plainBrowser,
    );
    expect(reason).toContain('H.265 and Dolby Digital Plus audio');
    // Not two sentences: the reader is going to VLC either way.
    expect(reason.match(/VLC/g).length).toBe(1);
  });

  test('a browser that does support them is not lectured', () => {
    // A Fire TV or an Android TV box has the platform decoders a laptop lacks,
    // and those are exactly the screens this player exists for.
    const tv = () => true;
    expect(unplayableReason({ videoCodec: 'hvc1.1.6.L93.B0', audioCodec: 'ec-3' }, tv)).toBeNull();
  });

  test('a missing half is not reported as unplayable', () => {
    // A radio channel has no video track; a silent feed has no audio one.
    expect(unplayableReason({ videoCodec: 'avc1.64001f' }, plainBrowser)).toBeNull();
    expect(unplayableReason({ audioCodec: 'mp4a.40.2' }, plainBrowser)).toBeNull();
  });

  test('a browser that throws on a codec string is taken as a no', () => {
    const throws = () => {
      throw new TypeError('bad codec');
    };
    expect(unplayableReason({ videoCodec: 'hvc1.1' }, throws)).toContain('H.265');
  });

  test('nothing to go on means nothing to say', () => {
    expect(unplayableReason(null, plainBrowser)).toBeNull();
    expect(unplayableReason({}, plainBrowser)).toBeNull();
  });
});

/**
 * The bug this file existed to prevent, committed by this file's own check.
 *
 * A reader on a Fire TV pressed Play, the channel connected, bytes moved, and the
 * player then tore itself down and said the browser could not decode it. It could.
 * mpegts.js had already rewritten the audio to LC before anything reached Media
 * Source Extensions; the check was asking MSE about the codec the provider's
 * transport stream DECLARED, which is a string MSE is never handed.
 */
describe('the declared codec is not the one MSE gets', () => {
  test('every AAC object type is asked about as LC', () => {
    // The remuxer emits 2 or 5 depending on platform and sampling rate. It never
    // emits what the ADTS header said.
    expect(effectiveCodec('mp4a.40.1')).toBe('mp4a.40.2');
    expect(effectiveCodec('mp4a.40.2')).toBe('mp4a.40.2');
    expect(effectiveCodec('mp4a.40.5')).toBe('mp4a.40.2');
    expect(effectiveCodec('mp4a.40.29')).toBe('mp4a.40.2');
  });

  test('codecs the remuxer passes through are left exactly alone', () => {
    // ts-demuxer sets originalCodec equal to codec for all of these, and video is
    // never rewritten, so the declared string IS the effective one.
    expect(effectiveCodec('ac-3')).toBe('ac-3');
    expect(effectiveCodec('ec-3')).toBe('ec-3');
    expect(effectiveCodec('opus')).toBe('opus');
    expect(effectiveCodec('mp3')).toBe('mp3');
    expect(effectiveCodec('hvc1.1.6.L93.B0')).toBe('hvc1.1.6.L93.B0');
    expect(effectiveCodec('avc1.64001f')).toBe('avc1.64001f');
    expect(effectiveCodec(null)).toBeNull();
  });

  test('AAC Main plays on Silk instead of being refused', () => {
    // The regression. A provider signalling mp4a.40.1 over ordinary LC payload is
    // the commonest thing in an IPTV playlist, and this said no to all of it.
    const reason = unplayableReason(
      { videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.1' },
      chromium,
    );
    expect(reason).toBeNull();
  });

  test('the other unplayable AAC object types go with it', () => {
    for (const audioCodec of ['mp4a.40.3', 'mp4a.40.4']) {
      expect(unplayableReason({ videoCodec: 'avc1.64001f', audioCodec }, chromium)).toBeNull();
    }
  });

  test('a browser with no AAC at all is still told so, and in words', () => {
    // The check is not being disabled, it is being pointed at the right question.
    const noAac = (type) => /avc1/.test(type);
    const reason = unplayableReason({ videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.1' }, noAac);
    expect(reason).toContain('AAC audio');
    // Not the raw mime string, which is what a reader used to be shown.
    expect(reason).not.toContain('mp4a.40.1');
  });

  test('H.265 and Dolby are unaffected by any of this', () => {
    // They are passed through the remuxer untouched, so the veto still stands and
    // is still the only thing that stops a black rectangle with no explanation.
    expect(unplayableReason({ videoCodec: 'hvc1.1.6.L93.B0' }, chromium)).toContain('H.265');
    expect(unplayableReason({ audioCodec: 'ec-3' }, chromium)).toContain('Dolby');
  });

  test('MP2 audio is still named MP2 rather than swept up as AAC', () => {
    // mp4a.69 and mp4a.6b are MPEG-2 layer II. They share a prefix with AAC and
    // nothing else, so the order of the name table is load-bearing.
    expect(codecName('mp4a.69')).toBe('MP2 audio');
    expect(codecName('mp4a.6b')).toBe('MP2 audio');
    expect(codecName('mp4a.40.2')).toBe('AAC audio');
    expect(codecName('mp3')).toBe('MP3 audio');
  });
});

/**
 * The other half of "it does not play on Silk", which was never a codec at all.
 *
 * The player was tuned for a laptop: no read-ahead buffer, and latency chasing on.
 * On a stick behind household wifi that pair turns every jitter spike into a
 * visible stall and then answers the stall with a forward seek, which is another
 * stall. The settings are picked per screen now.
 */
describe('the buffering profile follows the screen', () => {
  const FIRE_TV =
    'Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7233; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/70.0.3538.110 Safari/537.36';
  const FIRE_TABLET =
    'Mozilla/5.0 (Linux; Android 9; KFMAWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/107.3.1 like Chrome/107.0.5304.141 Safari/537.36';
  const DESKTOP =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  const PHONE =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

  test('a Fire TV is recognised by its model, not by the word Silk', () => {
    // Some Fire TV builds send a plain Chrome user agent with no "Silk" in it at
    // all, so the AFT model string is the marker that actually holds.
    expect(tvBrowserType(FIRE_TV)).toBe('firetv');
    expect(tvBrowserType(FIRE_TABLET)).toBe('silk');
  });

  test('a laptop and an Android phone are not televisions', () => {
    expect(isTvBrowser(DESKTOP)).toBe(false);
    expect(isTvBrowser(PHONE)).toBe(false);
    expect(isTvBrowser('')).toBe(false);
    expect(isTvBrowser(undefined)).toBe(false);
  });

  test('a television reads ahead and does not chase the live edge', () => {
    const tv = playerConfig(true);
    expect(tv.enableStashBuffer).toBe(true);
    expect(tv.stashInitialSize).toBeGreaterThan(100 * 1024);
    expect(tv.liveBufferLatencyChasing).toBe(false);
  });

  test('everything else keeps the settings it already had', () => {
    // Changing the desktop profile was not the point and would be a regression.
    const desktop = playerConfig(false);
    expect(desktop.enableStashBuffer).toBe(false);
    expect(desktop.liveBufferLatencyChasing).toBe(true);
    expect(desktop.liveBufferLatencyMaxLatency).toBe(6);
  });

  test('both profiles still drop what has been watched', () => {
    // Without this a three hour match fills the source buffer and the tab is
    // killed -- soonest on exactly the device this is all for.
    for (const config of [playerConfig(true), playerConfig(false)]) {
      expect(config.autoCleanupSourceBuffer).toBe(true);
      expect(config.lazyLoad).toBe(false);
    }
  });
});

describe('the player asks at the right moment', () => {
  const entry = readFileSync(
    new URL('../apps/web/src/client/player-entry.js', import.meta.url).pathname,
    'utf8',
  );

  test('the check hangs off media info, not off the button', () => {
    // Nothing about a channel says what is inside it until the demuxer has read
    // the stream: the playlist gives a name and a URL, the response gives
    // video/mp2t, and a transport stream carries whatever was put in it.
    expect(entry).toContain('mpegts.Events.MEDIA_INFO');
    expect(entry).toMatch(/unplayableReason\(\s*info\b/);
  });

  test('the failure detail is no longer dropped on the floor', () => {
    // It is the only thing separating "this browser will not decode Dolby" from
    // "the stream is malformed", and it was being discarded.
    // A regex, not a string literal: writing the placeholder as text trips the
    // lint rule that looks for accidental template interpolation.
    expect(entry).toMatch(/That stream could not be played here \(\$\{detail\}\)/);
  });

  test('the profile is chosen from the user agent, not baked in', () => {
    // The settings used to be a literal in the createPlayer call, which is how a
    // laptop's tuning came to be what a Fire TV got.
    expect(entry).toContain('playerConfig(isTvBrowser(navigator.userAgent))');
  });
});
