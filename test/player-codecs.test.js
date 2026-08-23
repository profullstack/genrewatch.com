import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { codecName, unplayableReason } from '../apps/web/src/client/codecs.js';

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
    expect(entry).toContain('unplayableReason(info');
  });

  test('the failure detail is no longer dropped on the floor', () => {
    // It is the only thing separating "this browser will not decode Dolby" from
    // "the stream is malformed", and it was being discarded.
    // A regex, not a string literal: writing the placeholder as text trips the
    // lint rule that looks for accidental template interpolation.
    expect(entry).toMatch(/That stream could not be played here \(\$\{detail\}\)/);
  });
});
