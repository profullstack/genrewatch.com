/**
 * Masking a stored playlist address.
 *
 * Its own file, with no imports at all, and that is load-bearing rather than
 * tidiness: this is pure string work, but it used to live beside playlistSource,
 * which imports the database. A test that wanted only the mask therefore loaded
 * the real query module -- and that re-registered it over another test file's
 * `mock.module`, sending ten unrelated password tests at a Postgres that is not
 * running. A pure function should cost nothing to import.
 */

/** How much of a secret segment survives masking. Enough to recognise, not to use. */
const KEEP = 2;

function maskSegment(value) {
  if (value.length <= KEEP) return '•'.repeat(value.length);
  return value.slice(0, KEEP) + '•'.repeat(Math.min(value.length - KEEP, 8));
}

/**
 * A version of the URL that identifies the line without handing it over.
 *
 * Both shapes an XUI panel hands out are covered: the path form
 * (`/playlist/<user>/<pass>/m3u`, also `/get.php` with the credentials as
 * segments) and the query form (`?username=&password=`). Anything unrecognised is
 * masked from the first path segment on, because guessing wrong in the direction
 * of showing less is free and guessing wrong the other way publishes a password.
 */
export function maskPlaylistUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  // The leading segment of the path form is a route, not a secret ("playlist",
  // "live", "get.php"). Everything after it is the credential.
  const masked = segments.map((s, i) => (i === 0 && segments.length > 1 ? s : maskSegment(s)));

  const search = new URLSearchParams(parsed.search);
  for (const key of [...search.keys()]) {
    if (/user|pass|token|key|auth/i.test(key)) search.set(key, maskSegment(search.get(key) ?? ''));
  }
  const query = search.toString();

  return `${parsed.protocol}//${parsed.host}/${masked.join('/')}${query ? `?${decodeURIComponent(query)}` : ''}`;
}
