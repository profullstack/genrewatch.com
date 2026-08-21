/**
 * Slugs and title normalisation.
 *
 * Slugs are a public URL and a unique key at the same time, which is the tension:
 * they have to be readable and they have to not collide. Every table here is
 * unique on (provider, provider_key) as well, so a collision is recoverable --
 * the suffix is derived from the provider key rather than from a counter, so the
 * same row gets the same slug on every sync rather than drifting.
 */

/** Latin-ish transliteration for the accents that actually show up in titles. */
const FOLD = {
  à: 'a',
  á: 'a',
  â: 'a',
  ã: 'a',
  ä: 'a',
  å: 'a',
  ā: 'a',
  è: 'e',
  é: 'e',
  ê: 'e',
  ë: 'e',
  ē: 'e',
  ì: 'i',
  í: 'i',
  î: 'i',
  ï: 'i',
  ī: 'i',
  ò: 'o',
  ó: 'o',
  ô: 'o',
  õ: 'o',
  ö: 'o',
  ø: 'o',
  ō: 'o',
  ù: 'u',
  ú: 'u',
  û: 'u',
  ü: 'u',
  ū: 'u',
  ñ: 'n',
  ç: 'c',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ð: 'd',
  þ: 'th',
};

/** @param {string} s */
function fold(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .replace(/[àáâãäåāèéêëēìíîïīòóôõöøōùúûüūñçßæœðþ]/g, (c) => FOLD[c] ?? c)
      // Strip combining marks left by anything the table above missed.
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
  );
}

/**
 * A URL-safe slug.
 *
 * @param {string} text
 * @param {string} [discriminator] appended when the base could collide -- pass the
 *   provider key, never a counter, so re-running a sync is idempotent
 */
export function slugify(text, discriminator = '') {
  const base = fold(text)
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/, '');

  const safe = base || 'x';
  if (!discriminator) return safe;
  const tail = fold(discriminator)
    .replace(/[^a-z0-9]+/g, '')
    .slice(-8);
  return tail ? `${safe}-${tail}` : safe;
}

/**
 * A title reduced to comparable words.
 *
 * Used for matching an event against a channel in someone's own playlist, where
 * the two strings come from different vendors and agree on nothing but the words:
 * "Dune: Part Three (2026) [4K]" and "DUNE PART THREE UHD" have to meet somewhere.
 * Punctuation, bracketed junk and quality tags all go; word order is preserved
 * because it is the only signal left.
 */
export function normaliseTitle(text) {
  return (
    fold(text)
      // Bracketed suffixes are almost always provider furniture: [4K], (2026), (HD).
      .replace(/[[(][^\])]*[\])]/g, ' ')
      .replace(/\b(4k|uhd|fhd|hd|sd|hevc|h265|h264|multi|vip|raw|dub|sub)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

/**
 * A stable key for a row a provider gives us no id for.
 *
 * MusicBrainz genres and m3u groups are strings, not entities. Hashing the string
 * would be opaque; slugging it is readable and just as stable, and the caller
 * prefixes it with the provider name so two providers cannot collide.
 */
export function keyFor(...parts) {
  return parts
    .map((p) =>
      fold(p)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .join(':');
}
