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
 * The check has to ask about the right codec, though, and for a while it did not.
 * See effectiveCodec() below: what the transport stream DECLARES and what the
 * remuxer EMITS are different strings for AAC, and asking about the declared one
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
 * The codec the browser is actually going to be asked for.
 *
 * MEDIA_INFO reports what the TRANSPORT STREAM declared. The source buffer is
 * opened with what the REMUXER emits, and for AAC those are routinely different
 * strings. mpegts.js rewrites every AAC AudioSpecificConfig before it builds the
 * init segment -- LC on Android, HE-AAC elsewhere, never the object type the ADTS
 * header carried -- so a channel that announces mp4a.40.1 is handed to MSE as
 * mp4a.40.2 and plays. In the demuxer's own media info that rewrite is invisible:
 * `audioCodec` is set from `originalCodec`, which is the header's value.
 *
 * Asking MSE about mp4a.40.1 is therefore asking about a codec nothing will ever
 * be handed. Chrome answers no -- it accepts object types 2, 5 and 29 and nothing
 * else -- and Amazon Silk is Chromium, so on a Fire TV, which is the screen this
 * player exists for, that no tore down a stream that had already connected and
 * would have played. AAC Main in the header with ordinary LC in the payload is
 * the single most common thing an IPTV provider mis-signals.
 *
 * Only AAC needs this. ts-demuxer sets `originalCodec` equal to `codec` for AC-3,
 * E-AC-3, Opus and MP3, and video is never rewritten at all, so for everything
 * else the declared codec IS the effective one and the check stands as it was.
 */
export function effectiveCodec(codec) {
  if (!codec) return codec;
  /*
   * Any AAC object type collapses to LC.
   *
   * The remuxer picks 2 or 5 depending on the platform and the sampling rate, and
   * both are supported everywhere AAC is supported at all -- so LC is the honest
   * thing to ask about. A browser that says no to it has no AAC decoder, which is
   * worth telling a reader; a browser that says no only to Main is answering
   * about a string it will never be shown.
   */
  if (/^mp4a\.40\./i.test(codec)) return 'mp4a.40.2';
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
      // The effective codec is what MSE is about to be handed. The declared one
      // is what the reader is told about, because that is what their provider
      // sends and what they would see named in VLC.
      ok = isTypeSupported(`${kind}/mp4; codecs="${effectiveCodec(codec)}"`);
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
