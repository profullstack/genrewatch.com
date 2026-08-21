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

/** Hard ceiling on a stored list. A real one is ~7k lines; this bounds abuse. */
export const MAX_CHANNELS = 20000;

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
export function parseM3u(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  /** `#EXTGRP:` is the other way providers state a group; it applies until changed. */
  let currentGroup = null;

  for (let i = 0; i < lines.length && out.length < MAX_CHANNELS; i++) {
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

    out.push({
      title: name,
      group: attrs['group-title'] || currentGroup || null,
      url,
    });
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

  return own.every((t) => words.has(t));
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
  const certain = [];
  const likely = [];
  const genre = [];

  const genreTokens = new Set([...tokens(genreName ?? ''), ...tokens(categoryName ?? '')]);

  for (const c of channels ?? []) {
    const norm = normaliseTitle(c.title);
    if (!norm) continue;
    // Dropped rather than ranked: a parked slot wins a shortest-title tiebreak and
    // is dead air.
    if (isPlaceholder(c.title)) continue;

    const words = new Set(norm.split(' '));

    if (title) {
      if (channelMatchesTitle(c.title, title)) {
        certain.push({ ...c, score: 100 + tokens(title).length });
        continue;
      }
      const found = tokens(title).filter((t) => words.has(t));
      if (found.length && !contradicts(words, title, found)) {
        likely.push({ ...c, score: found.length });
        continue;
      }
    }

    if (genreTokens.size && [...genreTokens].some((t) => words.has(t))) {
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

  return { certain: rank(certain), likely: rank(likely), genre: rank(genre) };
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
  const { certain, likely } = rankChannelsForTitle(channels, fixture);
  return [...certain, ...likely];
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
