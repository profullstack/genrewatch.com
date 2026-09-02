/**
 * Putting a stream in front of a browser, which cannot fetch it itself.
 *
 * Everything else in this feature deliberately keeps genrewatch out of the path
 * of the video: the reader's own URL goes back to the reader's own player and no
 * bytes cross this server. That is still the better route wherever it works, and
 * it is still what the VLC, Infuse and .m3u buttons do.
 *
 * It cannot work in a browser, and not for one reason but four, each of which is
 * on its own fatal:
 *
 *   - The provider serves `http://`. A page on https may not load an http media
 *     source, and no header relaxes that -- mixed content is not a CSP decision,
 *     so there is nothing to loosen.
 *   - It sends no CORS headers, so even an https provider would be unreadable by
 *     a script on our origin.
 *   - The URL is the reader's subscription credential. In an href it is already
 *     exposed to whoever is holding the phone, which is acceptable because that
 *     is the account's own owner; handed to a page it would also sit in history,
 *     in the referrer of anything the page loads next, and in reach of any
 *     extension reading the DOM.
 *   - Some lines answer only a player-shaped user agent, and a browser cannot
 *     forge one.
 *
 * So for the browser -- and only for the browser -- the bytes come through here.
 * What arrives is MPEG-2 Transport Stream, which no browser can decode natively
 * either; the page transmuxes it to fMP4 and feeds Media Source Extensions. That
 * transmux is deliberately the CLIENT's job: this stays a byte pipe with no
 * ffmpeg, no segmenting and no per-viewer CPU, which is the difference between a
 * feature that runs on the container already deployed and one that needs a fleet.
 *
 * One reader, one upstream connection, and it belongs to the account that
 * supplied it. This is not a restream: nothing here is shared between accounts,
 * cached, or reachable without the session of the person whose subscription it
 * is.
 */

import { isDeadStatus, PLAYABLE_TYPE, probeStream } from './probe.js';

export { probeStream };

/** Long enough for a redirect to a token URL; short enough to fail a dead slot fast. */
const CONNECT_TIMEOUT_MS = 8000;

/**
 * Line up as a player, because a browser cannot.
 *
 * The same string the probe uses, and for the same reason: several of these
 * panels answer a browser-shaped agent with an error page and a real player with
 * video.
 */
const PLAYER_UA = 'VLC/3.0.20 LibVLC/3.0.20';

/**
 * Open the upstream and hand back its body, or say why not.
 *
 * One connection, not two. The .m3u route probes first and then lets a desktop
 * player open its own connection, which is fine because the probe has let go by
 * then. Here a probe would be a second simultaneous connection on a line that
 * caps them -- so the check and the playback are the same request: read the
 * headers, decide, and if it is video keep the body flowing.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal }} opts the request's signal, so a reader who
 *   closes the tab drops the provider connection with it. Without it the line
 *   holds a slot open for a viewer who left, which is how a subscription reaches
 *   its concurrent-stream cap with nobody watching.
 * @param {number} [opts.connectTimeoutMs] overridable so the timeout branch can be
 *   tested in milliseconds rather than by making a test wait eight seconds --
 *   which is how that branch ends up untested.
 */
export async function openStream(url, { signal, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, status: 502, note: 'not a fetchable url', definitive: true };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  // Bounds reaching the provider, NOT watching it. Cleared the moment the headers
  // arrive: a timeout that survived into playback would cut the match off after
  // eight seconds.
  const timer = setTimeout(abort, connectTimeoutMs);

  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': PLAYER_UA },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // A reader who navigated away is not a failure, and must not be written back
    // to the channel row as one.
    if (signal?.aborted) return { ok: false, status: 499, note: 'closed', silent: true };
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return {
      ok: false,
      status: 504,
      note: aborted ? 'timed out' : 'could not connect',
      definitive: false,
    };
  }
  clearTimeout(timer);

  const type = (res.headers.get('content-type') ?? '').trim();

  /**
   * @param {number} status
   * @param {string} note
   * @param {boolean} definitive whether this says something about the SLOT, or
   *   only about the last few seconds. Two things read it: the caller, which
   *   persists only a definitive no, and the player, which reconnects from
   *   anything else.
   */
  const fail = (status, note, definitive) => {
    // Let the connection go rather than leaving it to a finaliser. These lines
    // count concurrent streams, and a leaked one counts.
    res.body?.cancel().catch(() => {});
    signal?.removeEventListener('abort', abort);
    return { ok: false, status, note, definitive };
  };

  /*
   * A panel that says no is usually saying "not right now".
   *
   * Every non-ok status used to come back as 502, and the player treats a 502 as
   * final -- so the commonest transient answer these lines give ended the stream.
   * The sequence was: the provider drops the connection, the player reconnects a
   * moment later, the panel is still counting the session whose end it has not
   * noticed and answers 403, that becomes 502, and the player gives up on an
   * entry that was playing seconds earlier and would have played again on the
   * next attempt.
   *
   * So only the statuses that mean the slot is GONE keep the final 502. The rest
   * -- 403 and 429 for a busy line, the whole 5xx range for a panel having a bad
   * minute -- answer 503, which the player reconnects from and nothing writes
   * down. The split is `isDeadStatus`, shared with the probe so that the two
   * cannot come to different conclusions about the same panel.
   */
  if (!res.ok) {
    const dead = isDeadStatus(res.status);
    return fail(dead ? 502 : 503, `provider answered ${res.status}`, dead);
  }

  // The common failure: a dead slot answers 200 with an HTML page saying so.
  if (/^text\/html/i.test(type)) return fail(502, 'returned a web page, not a stream', true);

  /*
   * An HLS playlist is playable, but not by this page.
   *
   * The transmuxer on the other end reads transport stream; handed an .m3u8 it
   * fails with a decoder error, which reads as "the player is broken" rather than
   * "this one needs a different player". Nothing in the measured 7,059-entry list
   * is HLS, but a provider can change that overnight, and being told to open it
   * in VLC is a working answer where a black rectangle is not.
   */
  if (/mpegurl/i.test(type)) return fail(415, 'that channel is an HLS playlist', true);

  if (!PLAYABLE_TYPE.some((re) => re.test(type))) {
    /*
     * Kept definitive, and deliberately unlike tipoffwatch, which reads the first
     * bytes before refusing on a header and can therefore afford to call this
     * unknown. Without that sniff there is nothing here but the header, so this
     * stays what it has always been rather than becoming a channel the page
     * offers again every half hour on no evidence.
     */
    return fail(502, type ? `unexpected type ${type}` : 'no content type', true);
  }

  return { ok: true, body: res.body, contentType: type, note: type };
}

/**
 * How many streams one account may have open at once, and what happens at the
 * ceiling: the OLDEST one is dropped, not the newest.
 *
 * The ceiling itself is not a rate limit and not about our capacity. A provider
 * line permits a small number of simultaneous connections -- often exactly one --
 * and exceeding it is what gets a subscription suspended. The reader owns that
 * line, so the ceiling protects THEM.
 *
 * Refusing the new stream also respected the ceiling, and was wrong anyway.
 * Pressing Play on a second channel is not an accident to be corrected: it says
 * which channel is wanted now. "You are already watching a channel" told the
 * reader to go and stop something they had usually already stopped -- because the
 * page tears the old player down before it asks for the new one, and the server
 * only learns that when the abort of a socket it is no longer reading reaches it.
 * That is a race the reader cannot see and cannot win by trying again quickly:
 * pressing Play twice in a second was the reliable way to be told no.
 *
 * So the newest claim evicts the oldest, and eviction is not just bookkeeping --
 * `evict` aborts the upstream fetch, so the provider connection is really gone
 * before the replacement is opened. One line, one connection, and the reader
 * never has to think about it.
 *
 * In process, not in Redis, because there is one web container. Splitting the web
 * role across instances makes this per-instance and therefore too generous; that
 * is the moment to move the registry, and the reason it is a small module of its
 * own rather than a variable inside the route.
 */
const open = new Map();

/**
 * Take a slot, dropping this account's oldest stream if the line is full.
 *
 * @param {string} userId
 * @param {object} [opts]
 * @param {number} [opts.max] simultaneous streams this line permits.
 * @param {() => void} [opts.evict] how to end THIS stream if a later claim takes
 *   the slot. Aborts the upstream fetch in the route; a claim with no evict is
 *   still counted, so a caller that forgets one loses the takeover rather than
 *   the ceiling.
 * @returns {(() => void) | null} release, or null if the line permits nothing at
 *   all. Callers must treat null as "not now" rather than assuming a slot.
 */
export function claimStreamSlot(userId, { max = 1, evict } = {}) {
  if (!(max >= 1)) return null;

  let slots = open.get(userId);
  if (!slots) {
    slots = new Set();
    open.set(userId, slots);
  }

  /*
   * Oldest first, which is what a Set's insertion order gives. Evicting in a
   * loop rather than once: `max` can be lowered by a deploy while streams from
   * the old ceiling are still running, and then a single eviction would leave
   * the account permanently over its line's limit.
   */
  for (const old of slots) {
    if (slots.size < max) break;
    old.release();
    try {
      old.evict?.();
    } catch {
      // An upstream that is already gone throws on abort. The slot is what
      // mattered and it has been given back.
    }
  }

  /*
   * Re-attach before claiming. Releasing the last entry drops the account's whole
   * Set from the map -- which is right, and means that after evicting everything
   * the local `slots` is a detached object nothing can see. Adding the new claim
   * to that would count the stream nowhere: the ceiling would stop applying and
   * the reader would quietly accumulate connections on a line that permits one.
   */
  open.set(userId, slots);

  const entry = { evict, released: false };
  entry.release = () => {
    // Idempotent: this is called from a stream teardown, which can fire on both
    // cancel and error for the same viewer, and again from an eviction that the
    // teardown then follows. Counting any of those twice would walk the slot
    // count down until the ceiling stopped applying at all.
    if (entry.released) return;
    entry.released = true;
    const live = open.get(userId);
    if (!live) return;
    live.delete(entry);
    if (live.size === 0) open.delete(userId);
  };

  slots.add(entry);
  return entry.release;
}

/** How many streams this account has open. Only for tests and diagnostics. */
export function streamSlotsOpen(userId) {
  return open.get(userId)?.size ?? 0;
}

/** Only for tests: the registry is process-wide and outlives a test file. */
export function _resetStreamSlots() {
  open.clear();
}
