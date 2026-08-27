/**
 * Parsing a reader's own channel list, and finding tonight's thing in it.
 *
 * This is a personal-player feature, not a distribution one: a reader adds the
 * playlist they already subscribe to, and we tell them which of their own
 * channels is carrying something on their calendar. Nothing here is shared
 * between accounts, nothing is relayed, and the hand-off is a one-channel file
 * the owner opens in the player they already use.
 *
 * What this version adds over the sports one is `group-title`. A provider list is
 * already a genre catalogue -- "Movies | Horror", "UK | Documentary", "Kids" --
 * and on a genre site that grouping is the most useful thing in the file. It
 * stays verbatim and stays private: it is never mapped onto our own genres,
 * because every provider names them differently and a confident wrong mapping is
 * worse than the raw string the reader already sees in their player.
 *
 * The parsing is deliberately forgiving. A real provider playlist is not a clean
 * format: thousands of entries with a dozen naming conventions, blank titles,
 * stale event slots with last month's date in them, and #EXTINF lines that carry
 * either key="value" attributes or nothing at all.
 */

import { normaliseTitle } from './slug.js';

/**
 * Fallback ceiling for callers that do not pass one.
 *
 * The real limit is configuration -- see playlists.maxChannels -- because it had to
 * become a knob: at 20,000 this silently truncated a 300,000-entry VOD catalogue
 * and the reader had no way to tell which entries were missing.
 */
export const MAX_CHANNELS = 300_000;

/**
 * Pull `key="value"` pairs out of the attribute block of an #EXTINF line.
 *
 * Only the block BEFORE the last comma is scanned. Attribute values routinely
 * contain commas ("Movies, Drama"), so splitting the line on the first comma and
 * calling the rest the title -- which is the obvious implementation, and the one
 * the sibling repo has -- truncates the title of every channel whose group
 * contains one.
 */
function parseAttrs(head) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const m of head.matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * Split an M3U into { title, group, url } entries.
 *
 * Only `#EXTINF` followed by a URL counts. Everything else -- `#EXTM3U`,
 * `#EXT-X-SESSION-DATA`, comments, blank lines -- is skipped rather than guessed
 * at, because a playlist that half-parses is worse than one that does not.
 *
 * @param {string} text
 */
export function parseM3u(text, { max = MAX_CHANNELS } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  /** `#EXTGRP:` is the other way providers state a group; it applies until changed. */
  let currentGroup = null;

  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTGRP:')) {
      currentGroup = line.slice('#EXTGRP:'.length).trim() || null;
      continue;
    }
    if (!line.startsWith('#EXTINF')) continue;

    /*
     * The title is everything after the LAST comma, not the first.
     *
     * The attribute block before it may itself contain commas inside quotes, and
     * on a real provider list it usually does -- group-title="Movies, Action" is
     * ordinary. Splitting on the first comma turns every such title into a
     * fragment of its own metadata.
     */
    const comma = line.lastIndexOf(',');
    if (comma < 0) continue;
    const head = line.slice(0, comma);
    const title = line.slice(comma + 1).trim();
    const attrs = parseAttrs(head);

    // The URL is the next line that is not another directive. Providers sometimes
    // interleave #EXTVLCOPT or #EXTGRP between the two.
    let url = null;
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j].trim();
      if (!cand) continue;
      if (cand.startsWith('#EXTGRP:')) {
        currentGroup = cand.slice('#EXTGRP:'.length).trim() || currentGroup;
        continue;
      }
      if (cand.startsWith('#')) continue;
      url = cand;
      i = j;
      break;
    }
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;

    const name = title || attrs['tvg-name'] || '';
    if (!name) continue;

    const group = attrs['group-title'] || currentGroup || null;
    out.push({ title: name, group, url, kind: entryKind({ url, group }) });
  }

  return out;
}

/**
 * The distinct groups in a list, largest first.
 *
 * This is what the reader's own genre index is built from. Counts come along
 * because a provider list has a long tail of one-channel groups that are not
 * worth a row on a page.
 *
 * @param {Array<{group: string|null}>} channels
 */
export function groupsOf(channels) {
  const counts = new Map();
  for (const c of channels ?? []) {
    const g = (c.group ?? '').trim();
    if (!g) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Words that carry no identity, so they can never be the reason two things match.
 *
 * Two groups. Broadcast furniture ("hd", "live", "channel") appears in thousands of
 * provider titles; media furniture ("season", "episode", "movie") appears in most
 * of the rest. Ported from the sports original, with its competition words
 * ("grand", "prix", "round") swapped for the ones this catalogue actually collides
 * on.
 */
const STOP = new Set([
  'hd',
  'fhd',
  'sd',
  'uhd',
  '4k',
  'hevc',
  'h265',
  'h264',
  'tv',
  'live',
  'channel',
  'feed',
  'main',
  'network',
  'vip',
  'raw',
  'dub',
  'sub',
  'multi',
  'new',
  'show',
  'series',
  'movie',
  'movies',
  'film',
  'season',
  'episode',
  'ep',
  'part',
  'vol',
  'volume',
  'and',
  'the',
  'for',
  'with',
  'from',
]);

/**
 * An unassigned slot, not a channel.
 *
 * Providers park spare capacity as "MOVIES 03:" with nothing after the colon, or
 * name it outright: BLANK, Temp, Test. There are hundreds, they rank well on a
 * shortest-title tiebreak, and every one of them is dead air.
 */
export function isPlaceholder(title) {
  const t = String(title ?? '').trim();
  if (!t) return true;
  // Everything after the last colon is the actual name on these providers.
  const tail = t.includes(':') ? t.slice(t.lastIndexOf(':') + 1).trim() : t;
  if (!tail) return true;
  return /^(blank|temp|tempo|test|tba|tbd|n\/?a|reserved|placeholder)\b/i.test(tail);
}

/** Significant words of a name, normalised. */
function tokens(s) {
  return normaliseTitle(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/**
 * Words whose whole job is telling one instalment from another.
 *
 * This is the genre catalogue's version of the sports matcher's club
 * discriminators, and it exists for the same reason: a partial match on a shared
 * word is how you get the wrong thing. "Dune" matches "Dune: Part Three" quite
 * happily, and a reader who opens it expecting Part Two has been actively
 * misled. So if a title carries one of these and the subject does not, the match
 * is refused.
 *
 * Like the original it is a heuristic and errs towards refusing: a miss costs a
 * channel not offered, a false match costs someone opening the wrong thing.
 */
const SEQUELS = new Set([
  'two',
  'three',
  'four',
  'five',
  'six',
  'ii',
  'iii',
  'iv',
  'vi',
  'vii',
  'returns',
  'reloaded',
  'redux',
  'reborn',
  'origins',
  'legacy',
  'begins',
  'awakens',
  'rises',
  'forever',
  'again',
  'next',
  'final',
]);

/**
 * Is this entry a live channel or something on demand?
 *
 * One playlist carries both. A provider panel encodes the difference in the URL
 * path -- `/live/` and a `.ts`/`.m3u8` stream, versus `/movie/` or `/series/` and
 * a `.mkv`/`.mp4` file -- and that is far more reliable than the title, which is
 * free text the reseller types.
 *
 * It matters because the two are DIFFERENT ANSWERS to "where can I watch this".
 * A live channel might be showing it now; an on-demand copy of the exact title is
 * there whenever the reader wants it, which is the better answer and should rank
 * above a channel rather than beside it.
 */
export function entryKind({ url, group } = {}) {
  const u = String(url ?? '').toLowerCase();
  if (/\/series\//.test(u)) return 'series';
  if (/\/(movie|movies|vod)\//.test(u)) return 'vod';
  if (/\.(mkv|mp4|avi|m4v)(\?|$)/.test(u)) return 'vod';
  if (/\/live\//.test(u) || /\.(ts|m3u8)(\?|$)/.test(u)) return 'live';

  // Nothing in the URL says. Fall back to the group, which usually does.
  const g = String(group ?? '').toLowerCase();
  if (/\b(vod|on ?demand|movies?|films?)\b/.test(g)) return 'vod';
  if (/\b(series|shows?|tv ?shows?)\b/.test(g)) return 'series';
  return 'live';
}

/**
 * The words worth asking the database about, for one title.
 *
 * Exported so the candidate query and the ranker agree on what "significant"
 * means. They have to: the query narrows a list to rows worth ranking, and a word
 * the ranker would have matched but the query never asked for is an entry the
 * reader is silently not offered.
 *
 * This exists because a list can now be a whole VOD catalogue. At seven thousand
 * entries, loading all of them and normalising each per page view was free. At
 * three hundred thousand it is a third of a second of CPU on every page, to find a
 * handful of rows that could have been selected by index.
 */
export function matchTerms({ title, genreName, categoryName } = {}) {
  const out = new Set();
  for (const name of [title, genreName, categoryName]) {
    if (!name) continue;
    for (const t of tokens(name)) out.add(t);
  }
  /*
   * A short title has no significant tokens -- tokens() drops anything under three
   * characters -- and would otherwise ask the database for nothing and match
   * nothing. The normalised whole is the best available needle for those.
   */
  if (out.size === 0 && title) {
    const whole = normaliseTitle(title);
    if (whole.length >= 2) out.add(whole);
  }
  return [...out];
}

/**
 * Does this channel appear to be carrying this event?
 *
 * The sports version could require BOTH team names, which made the separator
 * between them irrelevant and rejected anything mentioning only one club. A genre
 * event has ONE name, so that safeguard does not exist here and the risk runs the
 * other way -- towards matching too much.
 *
 * So a subject matches only when every significant word of its name is present.
 * Partial matches are handled a tier down, where the sequel guard applies.
 *
 * @param {string} channelTitle
 * @param {string} eventTitle the SUBJECT's name -- a show or a film, never the
 *   episode line, which carries numbering no provider uses
 */
/**
 * Words a provider adds to a filename that say nothing about which title it is.
 *
 * Matching every word of the title is not enough on its own, because a short
 * title reduces to very few significant words: "The Last of Us" is just `last`
 * once stop words and two-letter words are dropped, so "Last Man Standing S01E02"
 * matched all of it and was offered as the on-demand copy.
 *
 * The fix is to look at what the CHANNEL has that the title does not. An episode
 * marker, a year, a resolution or a codec is decoration and explains nothing --
 * "Severance S02E03" is still Severance. A real word is not: "Man" and
 * "Standing" mean this is a different programme.
 */
const DECORATION = [
  /^\d{4}$/, // a year
  /^s\d{1,2}(e\d{1,3})?$/, // s02, s02e03
  /^e(p|pisode)?\d{1,3}$/,
  /^season\d*$/,
  /^part\d*$/,
  /^\d{3,4}p$/, // 1080p, 720p
  /^(uhd|fhd|hdr|sdr|web|webrip|webdl|bluray|bdrip|dvdrip|remux|x264|x265|hevc|avc|aac|ddp|atmos|dolby|multi|dual|subbed|dubbed|vostfr|repack|proper|extended|unrated|imax|remastered)$/,
];

const isDecoration = (word) => DECORATION.some((re) => re.test(word));

/**
 * Significant words the channel has that the title does not account for.
 *
 * This is the whole precision rule, and it is the same on both paths: a channel
 * may add decoration and it may add an instalment marker, but it may not name
 * something the title never mentioned. "Top Chef" is not "Top Gun: Maverick"
 * because of `chef`, and no amount of sharing the word `top` changes that.
 *
 * Instalment words are allowed through here rather than rejected, because they
 * already have a dedicated mechanism -- SEQUELS and contradicts() -- which knows
 * whether the SUBJECT is itself an instalment. Rejecting them here as well would
 * mean "Dune: Part One" stopped matching "Dune".
 */
function unexplainedWords(channelTitle, ownWords) {
  /*
   * "24/7:" is a provider convention for a channel dedicated to one thing, not
   * part of what it is called. It normalises to the two words `24 7`, and
   * treating those as content lost "24/7: John Wick" from the John Wick page --
   * a real match, and exactly the kind this whole rule exists to keep.
   */
  return normaliseTitle(channelTitle)
    .replace(/\b24 7\b/g, ' ')
    .split(' ')
    .filter((w) => w && !ownWords.has(w) && !STOP.has(w) && !isDecoration(w) && !SEQUELS.has(w));
}

/**
 * Every word of a title, including the ones tokens() throws away.
 *
 * tokens() drops anything under three characters, which is right for deciding
 * what to MATCH on and wrong for deciding what is unexplained. Two mistakes came
 * out of using it for both:
 *
 *   - "John Q (2002)" was offered for "John Wick". They share `john`; the `Q`
 *     that makes it a different film is one character, so it vanished and left
 *     nothing to refuse it with.
 *   - and in the other direction, a possessive splits into a stray `s`
 *     ("Marvel's Cloak & Dagger" normalises to `marvel s cloak dagger`). Checking
 *     the channel's raw words against the title's TOKENS would have made that `s`
 *     unexplained and rejected an exact match.
 *
 * So the comparison is raw words on both sides. Short words still cannot be
 * matched ON, but they can now account for themselves.
 */
const wordsOf = (title) =>
  new Set(
    normaliseTitle(title ?? '')
      .split(' ')
      .filter(Boolean),
  );

export function channelMatchesTitle(channelTitle, eventTitle) {
  const hay = normaliseTitle(channelTitle);
  const needle = normaliseTitle(eventTitle);
  if (!hay || !needle) return false;
  if (isPlaceholder(channelTitle)) return false;

  // Two characters of overlap is noise. Below four we require the whole channel,
  // or "Up" matches "UP Network HD".
  if (needle.length < 4) return hay === needle;

  const words = new Set(hay.split(' '));
  const own = tokens(eventTitle);

  // A name made entirely of stop words ("The Show") has no significant words to
  // match on, so fall back to whole-phrase containment at a word boundary.
  if (own.length === 0) return ` ${hay} `.includes(` ${needle} `);

  if (!own.every((t) => words.has(t))) return false;

  /*
   * Every word of the title is here -- but so is everything else the channel is
   * called, and that is what decides it. Anything the channel adds beyond the
   * title has to be decoration; a real word means this is something else with an
   * overlapping name.
   *
   * Without this "The Last of Us" (which is the single word `last` once stop
   * words go) matched "Last Man Standing S01E02" completely, and offered it as
   * the on-demand copy.
   */
  return unexplainedWords(channelTitle, wordsOf(eventTitle)).length === 0;
}

/** Did the title name a DIFFERENT instalment than the one we are looking for? */
function contradicts(words, name, matched) {
  const own = tokens(name);
  // A complete match cannot be contradicted -- every word of the name is there.
  if (matched.length >= own.length) return false;
  for (const w of words) {
    if (SEQUELS.has(w) && !own.includes(w)) return true;
  }
  return false;
}

/**
 * Rank a reader's list against one event, in tiers, best first.
 *
 * The tiers are the point and they are three different claims:
 *
 *   - `certain`  every significant word of the subject is in the title.
 *   - `likely`   some of them are, and nothing contradicts it. Providers
 *                abbreviate -- a list writes "Severance S02" where we store
 *                "Severance" -- so requiring the whole name misses real matches.
 *   - `genre`    the channel is for the genre or category rather than this
 *                event. A 24/7 "Horror HD" channel carries whatever horror is on,
 *                which is worth showing and worth labelling honestly rather than
 *                presenting as "your show is on this".
 *
 * @param {Array<{title:string,url:string}>} channels
 */
export function rankChannelsForTitle(channels, { title, genreName, categoryName } = {}) {
  const onDemand = [];
  const certain = [];
  const likely = [];
  const genre = [];

  const genreTokens = new Set([...tokens(genreName ?? ''), ...tokens(categoryName ?? '')]);
  // Hoisted: this was recomputed for every candidate, and a 300,000-entry list
  // narrows to a couple of thousand of them.
  const titleTokens = title ? tokens(title) : [];

  const titleWords = wordsOf(title);

  for (const c of channels ?? []) {
    const norm = normaliseTitle(c.title);
    if (!norm) continue;
    // Dropped rather than ranked: a parked slot wins a shortest-title tiebreak and
    // is dead air.
    if (isPlaceholder(c.title)) continue;

    const words = new Set(norm.split(' '));
    // Entries parsed before this existed have no kind; treat them as live, which
    // is what they were assumed to be.
    const kind = c.kind ?? entryKind(c);
    const isFile = kind === 'vod' || kind === 'series';

    if (title) {
      if (channelMatchesTitle(c.title, title)) {
        /*
         * An on-demand copy of the exact title is the best answer there is, so it
         * gets its own tier above the channels. A live channel that happens to
         * carry the same name is a claim about right now; a file is a claim about
         * whenever the reader wants it, and conflating the two puts a maybe above
         * a certainty.
         */
        (isFile ? onDemand : certain).push({ ...c, score: 100 + titleTokens.length });
        continue;
      }
      const found = titleTokens.filter((t) => words.has(t));
      /*
       * A partial match is a maybe, and it stays one.
       *
       * Two things were wrong here. Any single shared word was enough -- which is
       * how "Top Chef S23E07" was offered for "Top Gun: Maverick", on the word
       * `top` -- and a file was then promoted into the on-demand tier, so a
       * coincidence appeared above the exact matches as the strongest claim the
       * page makes.
       *
       * Now the channel has to name nothing the title does not, so "Dune HD" is
       * still a maybe for "Dune Part Three" while "Top Chef" is not a maybe for
       * anything. Files and channels both land in `likely`: what separates the
       * tiers is how sure we are, not what kind of entry it is.
       */
      /*
       * And the overlap has to START the title, not fall anywhere in it.
       *
       * "By the Gun (2014)" shares only `gun` with "Top Gun: Maverick", and the
       * words that make it a different film -- "By", "the" -- are erased as too
       * short and as a stop word, so it has no unexplained words left to refuse
       * it with. What gives it away is WHERE the overlap sits: a file named after
       * a title almost always opens with it, so `gun` matching the second word
       * and not the first is the tell.
       *
       * This is also why the rule is not a count. "Dune HD" is one word out of
       * three and is a fair maybe for "Dune Part Three"; "By the Gun" is one word
       * out of three and is not.
       */
      const opensTitle = found.every((t, i) => t === titleTokens[i]);
      if (
        found.length &&
        opensTitle &&
        !unexplainedWords(c.title, titleWords).length &&
        !contradicts(words, title, found)
      ) {
        likely.push({ ...c, score: found.length });
        continue;
      }
    }

    // A genre channel is a live thing by nature: a VOD folder named "Horror" is
    // not carrying anything, it IS the folder, so only live entries qualify.
    if (!isFile && genreTokens.size && [...genreTokens].some((t) => words.has(t))) {
      genre.push({ ...c, score: 1 });
    }
  }

  // Score first, then the shorter title: a provider carrying one thing on several
  // slots gives the primary the plainest name, and the long ones are regional
  // alternates and replays with a date baked in.
  const rank = (arr) =>
    arr
      .sort((x, y) => y.score - x.score || x.title.length - y.title.length)
      .map(({ score, ...c }) => c);

  return {
    onDemand: rank(onDemand),
    certain: rank(certain),
    likely: rank(likely),
    genre: rank(genre),
  };
}

/**
 * Flat list of everything that looks like this event, best first.
 *
 * Genre-level channels are excluded here: this is the "your thing is on these"
 * answer, and a 24/7 genre channel is a different claim.
 *
 * @param {Array<{title: string, url: string}>} channels
 */
export function channelsForTitle(channels, fixture) {
  const { onDemand, certain, likely } = rankChannelsForTitle(channels, fixture);
  // On demand first: it is available whenever, where a channel is a maybe.
  return [...onDemand, ...certain, ...likely];
}

/**
 * A one-channel playlist, handed back to the person who supplied it.
 *
 * This is the whole playback story and it is deliberately small: their own URL,
 * their own credentials, returned to their own browser, for their own player to
 * open. Nothing is proxied and nothing is transcoded, which also sidesteps the
 * two walls a browser puts in the way -- an http:// source is blocked as mixed
 * content on an https page, and a self-signed upstream certificate is rejected
 * outright. A desktop player has neither restriction.
 */
export function oneChannelM3u({ title, url }) {
  return `#EXTM3U\n#EXTINF:-1,${String(title ?? 'Channel').replace(/[\r\n]+/g, ' ')}\n${url}\n`;
}
