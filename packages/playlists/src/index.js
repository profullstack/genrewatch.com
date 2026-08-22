import { createHash } from 'node:crypto';
import { open, seal } from '@genre/auth';
import { MAX_CHANNELS, normaliseTitle, parseM3u, rankChannelsForTitle } from '@genre/catalog';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';

/**
 * Importing and reading a reader's own channel list.
 *
 * The whole feature is one person's subscription, used by that person. Nothing
 * here takes an id without a user id beside it, nothing is cached across accounts,
 * and the credentials only ever travel back to the account that supplied them.
 */

/**
 * Fetch the list and store it.
 *
 * The fetch happens once at import rather than per page view: a provider list is
 * most of a megabyte, and re-pulling it on every fixture would hammer the reader's
 * own line -- which is the thing that gets a subscription cut off.
 *
 * Errors are recorded against the row rather than thrown at the reader as a stack
 * trace, because every one of them is something they can act on: a typo in the URL,
 * an expired line, a provider that is down.
 */
export async function importPlaylist({ userId, url, label, knownHash = null }) {
  if (!config.playlists.enabled) throw new Error('playlists are not configured');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That does not look like a URL.');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('The list must be an http:// or https:// address.');
  }

  await q.savePlaylist({ userId, label: label || parsed.hostname, sourceUrl: seal(url) });

  let text;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
      headers: { 'user-agent': 'curl/8.5.0 (+https://genrewatch.com)' },
    });
    if (!res.ok) throw new Error(`the provider answered ${res.status}`);

    // Bounded before reading, not after: a wrong URL pointing at something huge
    // should cost one header round trip rather than filling memory.
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > config.playlists.maxBytes) {
      throw new Error(`that list is ${Math.round(len / 1e6)}MB, which is larger than we store`);
    }
    text = await res.text();
    if (text.length > config.playlists.maxBytes) {
      throw new Error('that list is larger than we store');
    }
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'the provider did not respond' : err.message;
    await q.markPlaylistError({ userId, error: message });
    throw new Error(`Could not read that list: ${message}`);
  }

  // Hash the body before parsing it. The provider offers no conditional request --
  // no ETag, no Last-Modified, and If-Modified-Since is answered with a full 200 --
  // so the download cannot be avoided, but the rewrite behind it can. Most polls see
  // a byte-identical file: a provider rewrites the handful of slots that changed and
  // leaves the other several thousand entries sitting still.
  const contentHash = createHash('sha256').update(text).digest('hex');
  if (knownHash && knownHash === contentHash) {
    await q.markPlaylistFresh({ userId, contentHash, nextAt: nextRefreshAt() });
    return { channels: null, unchanged: true };
  }

  const channels = parseM3u(text).map((c) => ({
    title: c.title,
    // The provider's own group-title, verbatim. This is what makes a reader's own
    // list browsable by genre without any of it leaving their account.
    group: c.group,
    // Sealed individually: each one is the same credential with a channel id on
    // the end, so a leak of any single row is a leak of the line.
    streamUrl: seal(c.url),
    normTitle: normaliseTitle(c.title),
  }));

  if (channels.length === 0) {
    await q.markPlaylistError({ userId, error: 'no channels found in that file' });
    throw new Error('No channels found in that file — is it an M3U playlist?');
  }

  await q.replacePlaylistChannels({ userId, channels });
  await q.markPlaylistFresh({ userId, contentHash, nextAt: nextRefreshAt() });
  return {
    channels: channels.length,
    truncated: channels.length >= MAX_CHANNELS,
    unchanged: false,
  };
}

/**
 * When this list may next be polled.
 *
 * Jittered by up to a quarter of the interval so that a hundred accounts added on
 * the same afternoon do not all fetch on the same tick forever after -- which is
 * the shape of traffic a provider notices.
 */
function nextRefreshAt() {
  const base = config.playlists.refreshMinutes * 60_000;
  return new Date(Date.now() + base + Math.floor(Math.random() * base * 0.25));
}

/** Re-read the stored URL. Same import path, so the same limits apply. */
export async function refreshPlaylist(userId, { knownHash = null } = {}) {
  const row = await q.getPlaylist(userId);
  if (!row) throw new Error('You have not added a list.');
  const url = open(row.source_url);
  if (!url) throw new Error('That stored list could not be read. Please add it again.');
  return importPlaylist({ userId, url, label: row.label, knownHash });
}

/**
 * Poll every list that is due, one at a time.
 *
 * Sequential rather than fanned out on purpose: these are other people's
 * subscriptions, and several ~800KB pulls at once from one datacenter IP is the
 * traffic pattern that gets a line cut off.
 */
export async function refreshDuePlaylists({ log = console.log, limit = 25 } = {}) {
  const due = await q.playlistsDueForRefresh({ limit });
  if (due.length === 0) {
    /*
     * Say so out loud, rather than returning in silence.
     *
     * A tick that logs nothing when there is nothing due makes an idle poller
     * indistinguishable from one that was never registered -- and that is exactly
     * the question asked of it. "Is the refresh actually running?" cannot be
     * answered from the logs when the healthy state and the broken state both
     * print nothing. The next due time comes with it, so one line answers both
     * "is it alive" and "why has it not fetched".
     */
    const [next] = await q.nextPlaylistRefreshAt();
    log(
      `[playlists] nothing due${next?.next_at ? `, next at ${new Date(next.next_at).toISOString()}` : ' (no lists stored)'}`,
    );
    return { checked: 0, changed: 0, failed: 0 };
  }

  let changed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const r = await refreshPlaylist(row.user_id, { knownHash: row.content_hash });
      if (!r.unchanged) changed++;
    } catch {
      // markPlaylistError has already recorded it and set the back-off; a provider
      // being down must not stop the other lists being polled.
      failed++;
    }
  }

  log(`[playlists] ${due.length} due, ${changed} changed, ${failed} failed`);
  return { checked: due.length, changed, failed };
}

/**
 * Which of this reader's channels is carrying this event.
 *
 * Matched on the SUBJECT's name -- the show, the film -- and never on the event
 * title, which carries season and episode numbering that no provider uses in a
 * channel name. The sports version could require both team names and let the
 * separator between them be anything; with one name there is no such trick, so
 * the match is on a whole run of words rather than a substring. Returns unsealed
 * URLs, so the caller must already have established that the requester owns them.
 */
export async function ownChannelsForEvent({ userId, event }) {
  const none = { hasList: false, channelCount: 0, onDemand: [], matches: [], genre: [] };
  if (!config.playlists.enabled || !userId) return none;

  const rows = await q.playlistChannels(userId);
  if (rows.length === 0) return none;

  const ranked = rankChannelsForTitle(
    rows.map((r) => ({ title: r.title, url: r.stream_url })),
    {
      // The SUBJECT's name, never the event title -- that carries season and
      // episode numbering no provider writes into a channel name.
      title: event.subject_name,
      // Carried so a 24/7 genre channel has something to match on when nothing
      // matches the thing itself.
      genreName: event.genre_name,
      categoryName: event.category,
    },
  );

  const unseal = (list) =>
    list
      .map((m) => ({ title: m.title, url: open(m.url) }))
      .filter((m) => m.url)
      .slice(0, 10);

  /*
   * The count comes back even when nothing matched, and that is the point.
   *
   * Showing nothing at all is indistinguishable from the feature being broken --
   * which is exactly how it read when a list was added and nothing ever lit up.
   * "None of your 7,059 channels look like they have this" is an answer; silence
   * is not.
   */
  return {
    hasList: true,
    channelCount: rows.length,
    // A file the reader already has access to, whenever they want it -- a
    // different and better answer than a channel that might be showing it.
    onDemand: unseal(ranked.onDemand),
    matches: unseal([...ranked.certain, ...ranked.likely]),
    // Channels for the GENRE rather than this event -- a 24/7 "Horror HD" carries
    // whatever horror is on. Shown separately so the page never claims more than
    // it knows.
    genre: unseal(ranked.genre),
  };
}
