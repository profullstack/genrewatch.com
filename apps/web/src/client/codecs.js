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
];

/** What to call a codec string in a sentence. */
export function codecName(codec) {
  if (!codec) return null;
  for (const [re, name] of NAMES) if (re.test(codec)) return name;
  return codec;
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
    let ok = false;
    try {
      ok = isTypeSupported(`${kind}/mp4; codecs="${codec}"`);
    } catch {
      // A browser that throws on a malformed codec string is telling us no.
      ok = false;
    }
    if (!ok) bad.push(codecName(codec));
  }

  if (bad.length === 0) return null;

  // Both halves unplayable is one sentence, not two: the reader is going to VLC
  // either way, and listing two problems reads as two things to fix.
  const what = bad.length === 1 ? bad[0] : `${bad[0]} and ${bad[1]}`;
  return `This channel is ${what}, which this browser cannot decode. VLC can — the button is beside Play.`;
}
