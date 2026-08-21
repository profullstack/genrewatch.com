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
 * Does this channel appear to be carrying this event?
 *
 * The sports version required BOTH team names, which made the separator between
 * them irrelevant and was the whole trick. A genre event has one subject, so that
 * trick is gone and the risk is the opposite one: "Dune" would match "Dunedin
 * News". So matching is on a run of consecutive words rather than a substring,
 * and a short title has to match the channel almost exactly.
 *
 * @param {string} channelTitle
 * @param {string} eventTitle the SUBJECT's name -- a show or film, not the
 *   episode line, which carries numbering no provider uses
 */
export function channelMatchesTitle(channelTitle, eventTitle) {
  const hay = normaliseTitle(channelTitle);
  const needle = normaliseTitle(eventTitle);
  if (!hay || !needle) return false;

  // Two characters of overlap is noise. Four is the shortest real title that is
  // worth matching on ("Dune"), and below that we require the whole channel.
  if (needle.length < 4) return hay === needle;

  const words = needle.split(' ');
  if (words.length === 1) {
    // Single word: must appear as a whole word, not as a prefix of another.
    return ` ${hay} `.includes(` ${needle} `);
  }
  return ` ${hay} `.includes(` ${needle} `);
}

/**
 * Every channel in a list that looks like this event, best first.
 *
 * "Best" is the shortest title among equals, which is a proxy for the most
 * specific entry: a provider that carries something on several numbered slots
 * tends to give the primary one the plainest name, and the long ones are regional
 * alternates and replays with dates baked into the title.
 *
 * @param {Array<{title: string, url: string}>} channels
 * @param {{ title: string }} event
 */
export function channelsForTitle(channels, { title }) {
  return (channels ?? [])
    .filter((c) => channelMatchesTitle(c.title, title))
    .sort((a, b) => a.title.length - b.title.length);
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
