/**
 * Where an advert for a break comes from.
 *
 * genrewatch decides nothing about which advert plays and records nothing
 * about it playing. Both belong to the ad network: it runs the auction and
 * meters the impression, and a second opinion here would be a second set of
 * numbers. This is a proxy with an opinion about failure, nothing more.
 *
 * The opinion is that a break nobody can fill does not happen. The player
 * treats anything without a url as "no advert" and keeps the station playing,
 * which is the only behaviour worth defaulting to when the alternative is dead
 * air on a live stream.
 */

/** The network's break endpoint. Overridable so a deployment can point elsewhere. */
const AD_ORIGIN = process.env.AD_ORIGIN ?? 'https://crawlproof.com';

/**
 * This property's slot at the network.
 *
 * Unset means adverts are off, which is the right default for a development
 * copy: it has no advertising relationship and should not spend a request per
 * break being told so.
 */
/**
 * genrewatch's own slot at the network. Not a secret: the browser sends it on
 * every break, so it is already public, and a property's own slot is no more
 * configuration than its own domain is. AD_SLOT still overrides; empty is off.
 */
const DEFAULT_AD_SLOT = 'efed11ec-7244-49e3-80ab-e9c66734c2e1';

const AD_SLOT = process.env.AD_SLOT ?? DEFAULT_AD_SLOT;

/**
 * How long to wait.
 *
 * A break is a gap in a live station, so the budget is what a listener will not
 * notice. Past it the advert is not worth having: the player falls back to the
 * stream, which beats a pause while a third party thinks about it.
 */
const TIMEOUT_MS = 1500;

/** No advert. The shape the player expects, not an error. */
const NONE = { url: null };

/**
 * @param {string|null} kindParam
 * @param {{fetchImpl?: typeof fetch, origin?: string, slot?: string}} [deps]
 * @returns {Promise<{url: string, kind: 'audio'|'video'}|{url: null}>}
 */
export async function nextAdvert(kindParam, deps = {}) {
  const slot = deps.slot ?? AD_SLOT;
  if (!slot) return NONE;

  // Audio unless a caller says otherwise. The radio bar is audio-only and has
  // nowhere to put a picture.
  // Video by default: genrewatch plays TV into a <video>, so a picture has
  // somewhere to go. The radio properties default the other way.
  const kind = kindParam === 'audio' ? 'audio' : 'video';
  const doFetch = deps.fetchImpl ?? fetch;
  const origin = deps.origin ?? AD_ORIGIN;

  try {
    const res = await doFetch(
      `${origin}/api/ads/stream?slot=${encodeURIComponent(slot)}&kind=${kind}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return NONE;

    const body = await res.json();
    // Only https, and only a real string. This url is handed to a media element
    // in somebody's browser, so a javascript: or data: value arriving from the
    // network must not survive being proxied through here.
    if (typeof body?.url !== 'string') return NONE;
    let parsed;
    try {
      parsed = new URL(body.url);
    } catch {
      return NONE;
    }
    if (parsed.protocol !== 'https:') return NONE;

    return { url: parsed.toString(), kind: body.kind === 'video' ? 'video' : 'audio' };
  } catch {
    // A timeout, a refused connection, malformed JSON. All the same answer.
    return NONE;
  }
}
