/**
 * Adverts in a break, bundled as a global.
 *
 * The break machinery arrived with the live TV player (#39) and was attached
 * inside it, which left the other playback path with nothing. There are two: a
 * live channel, demuxed from a transport stream by a 270KB library, and a stored
 * file, handed straight to the element. The second exists SO THAT it never loads
 * the first bundle -- an iPhone has no Media Source and plays the MP4 natively --
 * so a break attached inside the demuxer bundle reached live channels only. A
 * name's own page, which is what a reader arrives on from a search engine, plays a
 * film.
 *
 * Hence a bundle of its own, loaded by app.js on the same press for either path.
 * Tree-shaken to itself attachAds is 4.5KB, which any press can afford, and the
 * interval and the creative source now live in one place instead of two that can
 * drift apart.
 */

import { attachAds } from '@profullstack/player';

/**
 * How often a break comes round.
 *
 * TEMPORARY: 10 seconds while the ad network is being tested end to end. Nobody
 * would ship an advert every ten seconds; this goes back to 300 once the fills,
 * the impressions and the playback have been watched working.
 */
const AD_EVERY_SECONDS = 10;

/*
 * How long before Skip appears.
 *
 * On a site nobody has to use, the alternative to a skip control is that they
 * close the tab -- and an advert watched for five seconds is metered either way,
 * so an unskippable one trades a reader for nothing.
 */
const AD_SKIP_AFTER_SECONDS = 5;

/*
 * In case a creative stalls.
 *
 * An advert that will not end must never cost somebody the thing they were
 * watching. Longer than any spot actually is, so this only fires on a broken one.
 */
const MAX_ADVERT_SECONDS = 45;

/**
 * Where a creative comes from: the server route, which proxies the ad network.
 *
 * A break that cannot be filled does not happen. Every failure path on the server
 * answers with a null url and this returns null, which attachAds treats as "no
 * advert" -- the programme keeps playing, which is the only acceptable outcome for
 * something a reader chose.
 */
async function nextCreative() {
  try {
    const answer = await fetch('/api/ads/next', { headers: { accept: 'application/json' } });
    if (!answer.ok) return null;
    const body = await answer.json();
    return body && typeof body.url === 'string' ? { url: body.url, kind: body.kind } : null;
  } catch {
    return null;
  }
}

/**
 * @param {HTMLElement} stage   the box the picture is in; the advert uses the same one
 * @param {HTMLMediaElement} media
 * @param {{live?: boolean}} [opts]
 * @returns {{destroy: () => void}|null}
 */
function startBreaks(stage, media, opts = {}) {
  /*
   * Only where there is a document to build into, and never allowed to throw.
   *
   * Both guards are inherited from #39 and both were paid for. attachAds creates
   * DOM and starts an interval: without the feature check it threw in a headless
   * run -- and because it sat on the same call path as playback, that took the
   * stream down and failed every reconnect test on a ReferenceError. A try/catch
   * alone did not fix it either, because the interval survived in runs that never
   * tear a player down, which hung the suite rather than failing it.
   *
   * The catch stays for the browser: a break that cannot be set up is a break that
   * does not happen, never a programme that does not play.
   */
  if (typeof document === 'undefined') return null;
  try {
    return attachAds(stage ?? media, media, {
      /*
       * A live channel has no beginning to put one in front of -- the reader joined
       * midway through by definition, and a pre-roll on something already in
       * progress delays them into a stream that has moved on. A film starts, so it
       * gets one first, which is where this inventory is worth most and is the
       * whole reason this path had to be reached.
       */
      preroll: !opts.live,
      everySeconds: AD_EVERY_SECONDS,
      skipAfter: AD_SKIP_AFTER_SECONDS,
      maxSeconds: MAX_ADVERT_SECONDS,
      next: nextCreative,
      /*
       * Logged, never surfaced. The reader did not ask for the advert and there is
       * nothing for them to do about one that failed; what they asked for is still
       * playing, which is the answer.
       */
      onError: (error) => console.warn('advert failed', error),
    });
  } catch (error) {
    console.warn('adverts unavailable', error);
    return null;
  }
}

window.__genreAds = { startBreaks };
