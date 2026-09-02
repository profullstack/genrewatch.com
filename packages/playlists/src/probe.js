/**
 * Does this channel actually play?
 *
 * A provider playlist is mostly aspirational. The slot exists and the title is
 * right, and a large share of them answer with an HTML error page rather than
 * video -- measured against a real line: several endpoints returned
 * `text/html; charset=UTF-8` with zero bytes where a stream was advertised.
 * Handing one of those to somebody during a match is worse than handing them
 * nothing, because they find out by tapping it.
 *
 * The check is deliberately small: ask for the first couple of kilobytes and look
 * at what comes back. That is enough to tell video from an error page, costs no
 * meaningful bandwidth, and holds the upstream connection for under a second --
 * which matters, because these lines cap concurrent connections and a probe that
 * lingers is a probe that competes with the reader's own playback.
 */

/**
 * What a working stream looks like coming back.
 *
 * Exported because the browser proxy has to make the same judgement from the same
 * headers, and two lists that drift apart would mean an entry the probe calls
 * live and the player calls broken.
 */
export const PLAYABLE_TYPE = [
  /^video\//i,
  /^audio\//i,
  // MPEG-TS, which is what most of these actually serve.
  /^application\/(octet-stream|x-mpegurl|vnd\.apple\.mpegurl)/i,
];

/** Long enough for a redirect and first bytes; short enough not to hold a slot. */
const TIMEOUT_MS = 6000;

/**
 * Statuses that say something permanent about the slot.
 *
 * Everything else -- 401, 403, 429 and the whole 5xx range -- is transient often
 * enough that remembering it is wrong. The 403 is the one that matters: a line
 * that permits one connection answers 403 to the second, which is to say it
 * answers 403 exactly when the reader is already watching, INCLUDING the moment
 * after a dropped stream when the panel has not yet noticed the old session is
 * gone. Treating that as permanent ends the match.
 *
 * Exported for the same reason PLAYABLE_TYPE is: the browser proxy has to make
 * the same judgement about the same panel, and two copies of this rule that
 * drifted apart would mean an entry the probe calls transient and the player
 * calls dead.
 */
const DEAD_STATUS = new Set([404, 410, 451]);

/** @param {number} status */
export function isDeadStatus(status) {
  return DEAD_STATUS.has(status);
}

/**
 * What to write down about a check, if anything.
 *
 * The one place that decides it, so no caller has to remember the rule: a yes and
 * a definite no are facts about the slot; everything else is a fact about the
 * last few seconds and is stored as "unknown" -- which the candidate query treats
 * as offerable, because it is. A stored no hides the row for thirty minutes, so
 * persisting an indefinite one takes a working entry off the page.
 *
 * @param {{ live: boolean, definitive?: boolean }} result
 * @returns {boolean|null}
 */
export function verdictToStore(result) {
  if (result?.live) return true;
  return result?.definitive ? false : null;
}

/**
 * @param {string} url
 * @returns {Promise<{ live: boolean, definitive: boolean, note: string }>}
 *   `definitive` is whether this verdict is worth remembering.
 */
export async function probeStream(url, { signal } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { live: false, definitive: true, note: 'not a fetchable url' };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  // The caller's signal, normally the request's. A probe that outlives the reader
  // who asked for it is a connection held open on a line that counts them, and the
  // page now verifies several channels in a row.
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      // Ranged, so a live stream hands over a couple of KB and lets go rather
      // than opening a session we then have to abandon mid-flight.
      headers: { range: 'bytes=0-2047', 'user-agent': 'VLC/3.0.20 LibVLC/3.0.20' },
      redirect: 'follow',
      signal: controller.signal,
    });

    const type = (res.headers.get('content-type') ?? '').trim();

    if (!res.ok && res.status !== 206) {
      return {
        live: false,
        definitive: isDeadStatus(res.status),
        note: `provider answered ${res.status}`,
      };
    }

    if (PLAYABLE_TYPE.some((re) => re.test(type))) {
      return { live: true, definitive: true, note: type || 'video' };
    }

    // The common failure, and the reason a status code alone is not enough: a
    // dead slot answers 200 with an HTML page saying so.
    if (/^text\/html/i.test(type)) {
      return { live: false, definitive: true, note: 'returned a web page, not a stream' };
    }

    return {
      live: false,
      definitive: true,
      note: type ? `unexpected type ${type}` : 'no content type',
    };
  } catch (err) {
    // A fact about the last six seconds, not about the entry. Remembering it is
    // how one timeout on the right channel takes it off the page for half an hour.
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return {
      live: false,
      definitive: false,
      note: aborted ? 'timed out' : 'could not connect',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Walk candidates in order and return the first that plays.
 *
 * Sequential on purpose. These are one subscriber's own connections and the line
 * caps how many can be open at once; probing five at a time to save two seconds
 * is how somebody's account gets flagged.
 *
 * @param {Array<{ title: string, url: string }>} candidates
 * @param {number} max how many to try before giving up
 */
export async function firstLiveChannel(candidates, { max = 4, onResult, signal } = {}) {
  const tried = [];
  for (const c of (candidates ?? []).slice(0, max)) {
    if (signal?.aborted) break;
    const result = await probeStream(c.url, { signal });
    tried.push({ ...c, ...result });
    if (onResult) await onResult(c, result);
    if (result.live) return { pick: c, tried };
  }
  return { pick: null, tried };
}
