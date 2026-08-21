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
export async function importPlaylist({ userId, url, label }) {
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
  return { channels: channels.length, truncated: channels.length >= MAX_CHANNELS };
}

/** Re-read the stored URL. Same import path, so the same limits apply. */
export async function refreshPlaylist(userId) {
  const row = await q.getPlaylist(userId);
  if (!row) throw new Error('You have not added a list.');
  const url = open(row.source_url);
  if (!url) throw new Error('That stored list could not be read. Please add it again.');
  return importPlaylist({ userId, url, label: row.label });
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
