/**
 * Whether this browser can actually decode what the demuxer just unwrapped.
 *
 * These two things are not the same question, and conflating them is what made
 * "That stream could not be played here" the site's least useful sentence.
 * mpegts.js demuxes H.265, AC-3 and E-AC-3 perfectly well -- it repackages them
 * into fMP4 and hands them to Media Source Extensions. MSE is where it stops: a
 * desktop browser will not decode Dolby audio it has no licence for, or HEVC it
 * has no hardware path to, and it refuses at `addSourceBuffer` rather than while
 * playing. The reader sees a stream that connected, transferred, and then died
 * for no stated reason.
 *
 * So the codecs are checked as soon as the demuxer reports them, against the same
 * MSE that is about to refuse them, and the failure is named. It is still VLC's
 * job -- there is no transcoder here and adding one would change what this
 * feature costs by an order of magnitude -- but "your provider sends this channel
 * as H.265, which this browser cannot decode" is an answer, and the generic
 * sentence was not.
 *
 * The check has to ask about the right THING, though, and twice now it did not.
 * See mseCandidates() below: what the transport stream declares and what the
 * remuxer hands to MSE are different for AAC (a different codec string) and for
 * MP3 (a different container entirely), and asking about the declared form
 * refused channels that would have played.
 */

/**
 * Codec mime prefixes to the name a person would recognise.
 *
 * Ordered, and matched by prefix: the strings carry profile and level suffixes
 * ("hvc1.1.6.L93.B0", "mp4a.40.2") that vary per channel and say nothing to a
 * reader.
 */
const NAMES = [
  [/^(hvc1|hev1)/i, 'H.265'],
  [/^(av01)/i, 'AV1'],
  [/^(vp09|vp9)/i, 'VP9'],
  [/^(ec-3|ec3)/i, 'Dolby Digital Plus audio'],
  [/^(ac-3|ac3)/i, 'Dolby Digital audio'],
  [/^(dts)/i, 'DTS audio'],
  [/^(mp4a\.69|mp4a\.6b)/i, 'MP2 audio'],
  [/^mp3$/i, 'MP3 audio'],
  // Last of the mp4a rules on purpose: 69 and 6b are MPEG-2 layer II, not AAC at
  // all, so they have to be matched before this catches the rest.
  [/^mp4a\.40\./i, 'AAC audio'],
];

/** What to call a codec string in a sentence. */
export function codecName(codec) {
  if (!codec) return null;
  for (const [re, name] of NAMES) if (re.test(codec)) return name;
  return codec;
}

/**
 * The mime types MSE is actually going to be asked to take.
 *
 * MEDIA_INFO reports what the TRANSPORT STREAM declared. The source buffer is
 * opened with what the REMUXER emits, and those are not the same thing -- which
 * is the mistake this function exists to stop being made a third time. Both known
 * cases refused channels that play perfectly well:
 *
 * AAC is a different CODEC STRING. mpegts.js rewrites every AudioSpecificConfig
 * before it builds the init segment -- LC on Android, HE-AAC elsewhere, never the
 * object type the ADTS header carried -- so a channel announcing mp4a.40.1 is
 * handed to MSE as mp4a.40.2 and plays. Chrome accepts object types 2, 5 and 29
 * and nothing else, and Amazon Silk is Chromium, so asking about the declared
 * mp4a.40.1 tore down a connected stream on exactly the screen this player is
 * for. AAC Main in the header over ordinary LC payload is the single most common
 * thing an IPTV provider mis-signals.
 *
 * MP3 is a different CONTAINER, which is the subtler one and was missed on the
 * first pass. `mp4-remuxer.js` sets `_mp3UseMpegAudio = !Browser.firefox`, and on
 * every other browser it emits `container: 'audio/mpeg'` with the codec field
 * cleared -- so the source buffer is opened as bare `audio/mpeg`, never
 * `audio/mp4; codecs="mp3"`. Chrome says yes to the first and no to the second,
 * so the codec-shaped question refused every MP3 channel.
 *
 * Several candidates rather than one, because for two of these mpegts.js picks
 * per browser and this decides nothing: whichever form THIS browser will be
 * handed is the one that has to pass, and only that one is ever true here anyway.
 * That also means the check survives mpegts.js changing which it prefers.
 *
 * @returns {string[]} empty when there is nothing to ask about.
 */
export function mseCandidates(kind, codec) {
  if (!codec || !kind) return [];

  if (kind === 'audio') {
    /*
     * Any AAC object type collapses to LC.
     *
     * The remuxer picks 2 or 5 by platform and sampling rate, and both are
     * supported everywhere AAC is supported at all -- so LC is the honest thing
     * to ask. A browser that says no to it has no AAC decoder, which is worth
     * telling a reader; a browser that says no only to Main is answering about a
     * string it will never be shown.
     */
    if (/^mp4a\.40\./i.test(codec)) return ['audio/mp4; codecs="mp4a.40.2"'];
    // Firefox is the one that takes MP3 inside MP4; everything else gets the raw
    // elementary stream, which is what mpegts.js hands it.
    if (/^mp3$/i.test(codec)) return ['audio/mpeg', 'audio/mp4; codecs="mp3"'];
    // mse-controller rewrites the codec to "Opus" on Safari and leaves it lower
    // case everywhere else, and Safari is fussy about which it is given.
    if (/^opus$/i.test(codec)) return ['audio/mp4; codecs="opus"', 'audio/mp4; codecs="Opus"'];
  }

  // Everything else is passed through untouched: ts-demuxer sets `originalCodec`
  // equal to `codec` for AC-3 and E-AC-3, and video is never rewritten at all.
  return [`${kind}/mp4; codecs="${codec}"`];
}

/**
 * The sentence to show, or null if this browser can play what arrived.
 *
 * @param {{videoCodec?: string, audioCodec?: string}} info the demuxer's media info.
 * @param {(type: string) => boolean} isTypeSupported normally
 *   MediaSource.isTypeSupported, injected so this is testable without a browser.
 */
export function unplayableReason(info, isTypeSupported) {
  if (!info || typeof isTypeSupported !== 'function') return null;

  const checks = [
    ['video', info.videoCodec],
    ['audio', info.audioCodec],
  ];

  const bad = [];
  for (const [kind, codec] of checks) {
    if (!codec) continue;
    // Any candidate passing is enough: they are the forms this one stream could
    // be handed to MSE as, not a list of things it needs all of. The reader is
    // still told about the DECLARED codec, because that is what their provider
    // sends and what they would see named in VLC.
    const ok = mseCandidates(kind, codec).some((type) => {
      try {
        return isTypeSupported(type);
      } catch {
        // A browser that throws on a malformed codec string is telling us no.
        return false;
      }
    });
    if (!ok) bad.push(codecName(codec));
  }

  if (bad.length === 0) return null;

  // Both halves unplayable is one sentence, not two: the reader is going to VLC
  // either way, and listing two problems reads as two things to fix.
  const what = bad.length === 1 ? bad[0] : `${bad[0]} and ${bad[1]}`;
  return `This channel is ${what}, which this browser cannot decode. VLC can — the button is beside Play.`;
}
