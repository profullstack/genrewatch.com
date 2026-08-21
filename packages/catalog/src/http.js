/**
 * One fetch path for every provider, because every provider throttles differently.
 *
 * The sibling sports site could get away with a bare `fetch`: it talked to one
 * upstream that tolerated a few hundred requests an hour. This site talks to five,
 * and their limits differ by three orders of magnitude -- TMDB is happy at 50
 * requests a second, MusicBrainz cuts you off above one, and TheSpaceDevs allows
 * fifteen an HOUR without a key. A single shared concurrency setting cannot be
 * right for all of them, so the limit lives next to the adapter that needs it and
 * this module enforces it per host.
 *
 * The queue is per host rather than per adapter so that two adapters hitting the
 * same API (TVmaze for shows and for episodes) share one budget rather than
 * doubling it.
 */

/** @type {Map<string, {minGapMs: number, next: Promise<void>}>} */
const lanes = new Map();

/**
 * Serialise calls to one host, leaving at least `minGapMs` between them.
 *
 * Implemented as a promise chain rather than a timer wheel: each caller waits on
 * the previous one and then on its own gap, so ordering is FIFO and there is no
 * bookkeeping to leak. The chain is deliberately never awaited by the map itself,
 * which is what keeps a slow host from blocking a fast one.
 */
function lane(host, minGapMs) {
  let l = lanes.get(host);
  if (!l) {
    l = { minGapMs, next: Promise.resolve() };
    lanes.set(host, l);
  }
  // A host's gap can be widened by a 429 (see below) but never narrowed, so a
  // provider that has already complained stays slowed for the life of the process.
  l.minGapMs = Math.max(l.minGapMs, minGapMs);
  const mine = l.next.then(() => sleep(l.minGapMs));
  l.next = mine.catch(() => {});
  return mine;
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Providers that answer 403 to a browser-like agent and 200 to an honest one. */
const USER_AGENT = 'genrewatch/1.0 (+https://genrewatch.com; hello@genrewatch.com)';

/**
 * GET some JSON, politely.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.minGapMs] minimum spacing between calls to this host
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries] attempts after the first, for 429 and 5xx only
 * @param {Record<string,string>} [opts.headers]
 * @param {object} [opts.body] when present the call is a POST with a JSON body
 */
export async function getJson(url, opts = {}) {
  const { minGapMs = 0, timeoutMs = 30_000, retries = 2, headers = {}, body = null } = opts;
  const host = new URL(url).host;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await lane(host, minGapMs);

    let res;
    try {
      res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // A timeout or a dropped socket is worth one more go; a bad URL is not, but
      // it will fail the same way twice and cost only the retry budget.
      lastError = err;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.status === 429) {
      /*
       * Slow this host down for good, not just for this retry.
       *
       * Retry-After tells us how long to wait once. It does not tell us the rate,
       * so backing off and then resuming the old cadence walks straight back into
       * the limit -- which is how the first MusicBrainz pass got a five-minute
       * ban. Widening the lane's gap makes the correction stick.
       */
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      lanes.get(host).minGapMs = Math.max(lanes.get(host).minGapMs * 2, 1000);
      lastError = new Error(`${host} rate limited (429)`);
      await sleep(retryAfter * 1000 || backoffMs(attempt));
      continue;
    }

    if (res.status >= 500) {
      lastError = new Error(`${host} answered ${res.status}`);
      await sleep(backoffMs(attempt));
      continue;
    }

    /*
     * 404 is data, not an error.
     *
     * Half these endpoints answer 404 for "nothing scheduled in that window",
     * which is the normal state of most of the catalogue most of the time.
     * Throwing on it made an empty week look like an outage.
     */
    if (res.status === 404) return null;

    if (!res.ok) throw new Error(`${host} answered ${res.status} for ${url}`);
    return res.json();
  }

  throw lastError ?? new Error(`${host} did not answer`);
}

/** Exponential with a ceiling, so a long outage does not become a long sleep. */
function backoffMs(attempt) {
  return Math.min(500 * 2 ** attempt, 8000);
}

/** Reset between tests, which would otherwise inherit each other's widened lanes. */
export function resetLanes() {
  lanes.clear();
}
