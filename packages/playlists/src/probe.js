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

/** What a working stream looks like coming back. */
const PLAYABLE = [
  /^video\//i,
  /^audio\//i,
  // MPEG-TS, which is what most of these actually serve.
  /^application\/(octet-stream|x-mpegurl|vnd\.apple\.mpegurl)/i,
];

/** Long enough for a redirect and first bytes; short enough not to hold a slot. */
const TIMEOUT_MS = 6000;

/**
 * @param {string} url
 * @returns {Promise<{ live: boolean, note: string }>}
 */
export async function probeStream(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { live: false, note: 'not a fetchable url' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
      return { live: false, note: `provider answered ${res.status}` };
    }

    if (PLAYABLE.some((re) => re.test(type))) {
      return { live: true, note: type || 'video' };
    }

    // The common failure, and the reason a status code alone is not enough: a
    // dead slot answers 200 with an HTML page saying so.
    if (/^text\/html/i.test(type)) {
      return { live: false, note: 'returned a web page, not a stream' };
    }

    return { live: false, note: type ? `unexpected type ${type}` : 'no content type' };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return { live: false, note: aborted ? 'timed out' : 'could not connect' };
  } finally {
    clearTimeout(timer);
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
export async function firstLiveChannel(candidates, { max = 4, onResult } = {}) {
  const tried = [];
  for (const c of (candidates ?? []).slice(0, max)) {
    const result = await probeStream(c.url);
    tried.push({ ...c, ...result });
    if (onResult) await onResult(c, result);
    if (result.live) return { pick: c, tried };
  }
  return { pick: null, tried };
}
