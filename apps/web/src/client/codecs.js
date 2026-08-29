/**
 * Whether this browser can actually decode what the demuxer just unwrapped.
 *
 * The table itself now lives in `@profullstack/player/codecs`, because
 * tipoffwatch carried a byte-identical copy of it and pairux's player wants the
 * same answers. Every rule in it was paid for by a channel that failed in
 * production -- and two of them were got wrong twice -- so having one copy to
 * fix is the whole point. See that module for the reasoning; it was moved
 * comment for comment.
 *
 * What stays here is the part that is ours: the advice at the end of the
 * sentence, which depends on there being a VLC button next to Play on this
 * page, and the word "channel", which is what our reader clicked. The shared
 * module knows neither.
 *
 * Imported from the `/codecs` subpath, not the package root: the root pulls in
 * the player and its dynamic engine imports, and this bundle wants a lookup
 * table and nothing else.
 */

import {
  codecName,
  mseCandidates,
  unplayableReason as sharedUnplayableReason,
} from '@profullstack/player/codecs';

/** What to do instead, which only this page knows. */
const ADVICE = 'VLC can — the button is beside Play.';

/**
 * The sentence to show, or null if this browser can play what arrived.
 *
 * @param {{videoCodec?: string, audioCodec?: string}} info the demuxer's media info.
 * @param {(type: string) => boolean} isTypeSupported normally
 *   MediaSource.isTypeSupported, injected so this is testable without a browser.
 * @returns {string|null}
 */
export function unplayableReason(info, isTypeSupported) {
  return sharedUnplayableReason(info, isTypeSupported, ADVICE, 'channel');
}

export { codecName, mseCandidates };
