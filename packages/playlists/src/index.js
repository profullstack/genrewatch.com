import { createHash } from 'node:crypto';
import { open, seal } from '@genre/auth';
import { matchTerms, normaliseTitle, parseM3u, rankChannelsForTitle } from '@genre/catalog';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';

export { maskPlaylistUrl } from './mask.js';
export { firstLiveChannel, isDeadStatus, probeStream, verdictToStore } from './probe.js';
export { claimStreamSlot, openStream, streamSlotsOpen } from './proxy.js';
export { playlistSource } from './source.js';

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

  /*
   * What was stored before this attempt, so a failed one can be undone.
   *
   * The address is written before the fetch, because an error has to be recorded
   * against a row and a first-time add has no row until this runs. The cost was
   * that a typo replaced a working address with a broken one and there was no way
   * to read the old value back -- the credential was sealed, so "paste it again"
   * meant "keep a copy of it somewhere else", which is exactly what sealing it was
   * supposed to make unnecessary.
   */
  const previous = await q.getPlaylist(userId);

  await q.savePlaylist({ userId, label: label || parsed.hostname, sourceUrl: seal(url) });

  /**
   * Put back the address that was working, and say which one failed.
   *
   * Only when the address actually changed. A refresh, or a save of the same URL,
   * re-submits what is already stored, and rolling that back to itself would be a
   * write for nothing -- and would clear an error the reader is meant to see.
   */
  const restorePrevious = async () => {
    if (!previous) return false;
    // Compared unsealed: seal() carries a random nonce, so two ciphertexts of the
    // same URL never match and a ciphertext comparison would always roll back.
    const before = open(previous.source_url);
    if (!before || before === url) return false;
    await q.savePlaylist({
      userId,
      label: previous.label,
      sourceUrl: previous.source_url,
    });
    return true;
  };

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
    const restored = await restorePrevious();
    await q.markPlaylistError({ userId, error: message });
    throw new Error(
      restored
        ? `Could not read that list: ${message}. Your previous address is still saved.`
        : `Could not read that list: ${message}`,
    );
  }

  // Hash the body before parsing it. The provider offers no conditional request --
  // no ETag, no Last-Modified, and If-Modified-Since is answered with a full 200 --
  // so the download cannot be avoided, but the rewrite behind it can. Most polls see
  // a byte-identical file: a provider rewrites the handful of slots that changed and
  // leaves the other several thousand entries sitting still.
  const contentHash = createHash('sha256').update(text).digest('hex');
  /*
   * ...unless the rows we already hold predate a column a fresh parse would fill.
   *
   * Skipping on an unchanged hash freezes the SCHEMA those rows were imported
   * under, not just their content. `kind` arrived in 0013 and, for anybody whose
   * provider had not touched their playlist since, never got written -- so their
   * films kept falling back to the sealed-url guess and landing in the generic
   * tier rather than "Available on demand", which is the exact bug 0013 fixed,
   * surviving in the data. One cheap exists() per poll buys the self-heal.
   */
  const stale = await q.playlistNeedsReparse(userId);
  if (knownHash && knownHash === contentHash && !stale) {
    await q.markPlaylistFresh({ userId, contentHash, nextAt: nextRefreshAt(text.length) });
    return { channels: null, unchanged: true };
  }

  const channels = parseM3u(text, { max: config.playlists.maxChannels }).map((c) => ({
    title: c.title,
    // The provider's own group-title, verbatim. This is what makes a reader's own
    // list browsable by genre without any of it leaving their account.
    group: c.group,
    // Sealed individually: each one is the same credential with a channel id on
    // the end, so a leak of any single row is a leak of the line.
    streamUrl: seal(c.url),
    normTitle: normaliseTitle(c.title),
    /*
     * Worked out once, here, and stored.
     *
     * It cannot be recomputed at match time: the URL it is read from is sealed at
     * rest, so entryKind would be inspecting an encrypted blob. It did exactly
     * that until 0013, found no "/movie/" in a base64 string, and answered 'live'
     * for every entry on every list -- which is why "Available on demand" never
     * appeared for anyone.
     */
    kind: c.kind ?? null,
  }));

  if (channels.length === 0) {
    // Reached something, but not a playlist. Same rollback as a failed fetch: a
    // URL that answers with a login page is a typo like any other.
    const restored = await restorePrevious();
    await q.markPlaylistError({ userId, error: 'no channels found in that file' });
    throw new Error(
      restored
        ? 'No channels found in that file — is it an M3U playlist? Your previous address is still saved.'
        : 'No channels found in that file — is it an M3U playlist?',
    );
  }

  await q.replacePlaylistChannels({ userId, channels });
  await q.markPlaylistFresh({ userId, contentHash, nextAt: nextRefreshAt(text.length) });
  return {
    channels: channels.length,
    truncated: channels.length >= config.playlists.maxChannels,
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
/**
 * When to poll this list again, scaled by how big it is.
 *
 * The provider supports no conditional request, so every poll downloads the whole
 * file whether or not a byte changed. Five minutes is right for a channel lineup
 * and ruinous for a full VOD catalogue: a 38MB list on a five-minute cycle pulls
 * 11GB a day off the reader's own subscription from a datacenter IP, which is how
 * a line gets flagged.
 *
 * So the interval is the configured minimum or size/rate, whichever is longer. An
 * ordinary list is unaffected; a large one is polled proportionally less often.
 * The jitter stops every list on a deploy waking up in the same second.
 */
function nextRefreshAt(bytes = 0) {
  const floorMs = config.playlists.refreshMinutes * 60_000;
  const scaledMs = (bytes / config.playlists.refreshBytesPerMinute) * 60_000;
  const base = Math.max(floorMs, scaledMs);
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
/**
 * How long a "yes, this is there" verdict is worth trusting.
 *
 * Ten minutes, which is short on purpose. A provider slot that answers at eight
 * o'clock can be an error page by nine -- that is the normal behaviour of these
 * lines, not an edge case -- so a stale yes is exactly the thing being fixed.
 * Long enough that opening the same page twice does not probe twice.
 */
const VERDICT_TTL_MS = 10 * 60 * 1000;

const freshEnough = (at) => Boolean(at) && Date.now() - new Date(at).getTime() < VERDICT_TTL_MS;

export async function ownChannelsFor({ userId, title, genreName = null, categoryName = null }) {
  const none = {
    hasList: false,
    channelCount: 0,
    onDemand: [],
    matches: [],
    genre: [],
    unavailable: [],
  };
  if (!config.playlists.enabled || !userId) return none;

  /*
   * Narrowed in the database, ranked in JavaScript.
   *
   * This used to load the whole list. That was free at seven thousand entries and
   * is not at three hundred thousand -- a provider that exposes its VOD catalogue
   * ships one -- so rows that could not possibly match are dropped by an index
   * before they are ever sent. The ranker below is unchanged and still decides
   * everything; this only decides what it is shown.
   *
   * The count is fetched separately because it is still owed to the page even when
   * nothing matched: "none of your 7,059 entries look like they carry this" is an
   * answer, and it used to come free from having loaded them all.
   */
  const [channelCount, rows] = await Promise.all([
    q.playlistChannelCount(userId),
    q.playlistCandidates(userId, { terms: matchTerms({ title, genreName, categoryName }) }),
  ]);
  if (channelCount === 0) return none;
  if (rows.length === 0) {
    return { hasList: true, channelCount, onDemand: [], matches: [], genre: [], unavailable: [] };
  }

  const ranked = rankChannelsForTitle(
    rows.map((r) => ({
      // The row id travels with the channel so a probe verdict can be written back
      // against the right one. It is an internal id and never reaches a page.
      id: r.id,
      title: r.title,
      url: r.stream_url,
      /*
       * The stored kind and group, rather than letting the ranker work them out.
       *
       * It cannot: `url` here is the SEALED value, and entryKind reads a URL path.
       * Handing it an encrypted blob is what made every entry look like a live
       * channel and left the on-demand tier permanently empty. Both are columns
       * now (0013), so this is a read rather than a guess.
       */
      kind: r.kind ?? null,
      group: r.group_title ?? null,
    })),
    { title, genreName, categoryName },
  );

  // What we last learned about each slot, so the page does not re-probe something
  // confirmed a moment ago. The ranker only preserves the fields it is handed, so
  // liveness is looked up against the rows rather than carried through it.
  const byId = new Map(rows.map((r) => [r.id, r]));
  /*
   * A recent "dead" verdict. The probe asked the provider and it refused.
   *
   * These used to be filtered out in SQL, which made a consistently-failing
   * title flicker on a thirty-minute cycle -- present, probed, 404, gone for half
   * an hour, back again. Now they are separated out and reported, so the page can
   * say the list HAS this and the provider will not serve it.
   */
  const failing = (m) => {
    const row = byId.get(m.id);
    return row?.is_live === false && freshEnough(row?.checked_at);
  };

  const shape = (m) => ({
    id: m.id,
    title: m.title,
    // The provider's own shelf for this entry, so a row can say what it is.
    group: byId.get(m.id)?.group_title ?? null,
    kind: byId.get(m.id)?.kind ?? null,
    url: open(m.url),
    verified: byId.get(m.id)?.is_live === true && freshEnough(byId.get(m.id)?.checked_at),
  });

  const unseal = (list) =>
    list
      .filter((m) => !failing(m))
      .map(shape)
      .filter((m) => m.url)
      .slice(0, 10);

  // Matched, and currently refused by the provider. Never offered as playable --
  // the URL is dropped rather than unsealed, because there is nothing to play.
  const unavailable = [...ranked.onDemand, ...ranked.certain, ...ranked.likely]
    .filter(failing)
    .map((m) => ({ id: m.id, title: m.title, kind: byId.get(m.id)?.kind ?? null }))
    .slice(0, 5);

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
    channelCount,
    // A file the reader already has access to, whenever they want it -- a
    // different and better answer than a channel that might be showing it.
    onDemand: unseal(ranked.onDemand),
    matches: unseal([...ranked.certain, ...ranked.likely]),
    // Channels for the GENRE rather than this event -- a 24/7 "Horror HD" carries
    // whatever horror is on. Shown separately so the page never claims more than
    // it knows.
    genre: unseal(ranked.genre),
    // On the list, and refused by the provider when we last asked. Reported
    // rather than hidden: "you have this and your line will not serve it" is an
    // answer, and silence was being read as the matcher being broken.
    unavailable,
  };
}

/**
 * The same question, asked from an event page.
 *
 * Matched on the SUBJECT's name, never the event title -- that carries season and
 * episode numbering no provider writes into a channel name.
 */
export async function ownChannelsForEvent({ userId, event }) {
  return ownChannelsFor({
    userId,
    title: event.subject_name,
    // Carried so a 24/7 genre channel has something to match on when nothing
    // matches the thing itself.
    genreName: event.genre_name,
    categoryName: event.category,
  });
}

/**
 * And from a subject page, which is where it was missing.
 *
 * A search result links to a SUBJECT, and until now that page never asked this
 * question at all -- it listed upcoming events and nothing else. For a film from
 * 2022 there are no upcoming events, so the page a reader reached by searching for
 * something they wanted to watch was a title, a poster and "Nothing scheduled."
 * Their own list was never consulted, which reads exactly like a provider that
 * does not carry it.
 */
export async function ownChannelsForSubject({ userId, subject, genreName = null }) {
  return ownChannelsFor({
    userId,
    title: subject.display_name ?? subject.name,
    genreName,
    categoryName: subject.category,
  });
}

/**
 * Which of the SHARED lists is carrying this event.
 *
 * The same matching as ownChannelsForEvent, over other people's rows, and it
 * exists only because the owner of a line asked for one. Everything about this
 * table was built to make it impossible -- see migration 0011 for what the owner
 * is actually agreeing to -- so the differences from the private path are all
 * deliberate:
 *
 *   - The stream URL is NOT unsealed here. A shared entry is playable through the
 *     proxy and nowhere else, because every other route hands the reader the URL
 *     itself, and that URL carries the owner's provider username and password. A
 *     shared list that also handed out credentials would last exactly as long as
 *     it took one person to paste one.
 *   - Each row carries its owner, because the connection ceiling belongs to the
 *     owner's line rather than to whoever is watching.
 *   - Rows are keyed by channel id, so the routes can look one up without a
 *     viewer to scope by.
 *
 * @param {{viewerId: string|null, event: object}} args
 */
export async function sharedChannelsFor({
  viewerId,
  title,
  genreName = null,
  categoryName = null,
}) {
  const none = { channels: [], owners: 0, channelCount: 0 };
  if (!config.playlists.enabled || !viewerId) return none;

  /*
   * Narrowed across the WHOLE shared set, the same way the reader's own page is.
   *
   * This used to take the first 20,000 rows by position and rank those, while
   * ownChannelsFor narrowed by term over everything. On a 300,000-entry VOD
   * catalogue the row carrying a given film sits well past that ceiling, so the
   * owner saw it and everyone they had shared with saw nothing -- which reads as
   * sharing being broken rather than as a limit. The count comes back separately
   * so an empty result can say which kind of empty it is.
   */
  const [channelCount, rows] = await Promise.all([
    q.sharedChannelCount({ viewerId }),
    q.sharedPlaylistCandidates({
      viewerId,
      terms: matchTerms({ title, genreName, categoryName }),
    }),
  ]);
  if (channelCount === 0) return none;
  if (rows.length === 0) return { channels: [], owners: 0, channelCount };

  const ranked = rankChannelsForTitle(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.stream_url,
      // Read, not guessed -- `url` is sealed here too. See ownChannelsFor.
      kind: r.kind ?? null,
      group: r.group_title ?? null,
    })),
    { title, genreName, categoryName },
  );

  const byId = new Map(rows.map((r) => [r.id, r]));
  // On demand first, then the ones that look like the thing, then the genre
  // channels -- the same order the reader's own section uses, so the two read
  // the same way.
  const flat = [...ranked.onDemand, ...ranked.certain, ...ranked.likely, ...ranked.genre];

  const channels = flat
    .map((m) => {
      const row = byId.get(m.id);
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        group: row.group_title ?? null,
        // Carried for the same reason the reader's own rows carry it: the page
        // has to know whether the thing behind the Play button is a channel or a
        // file, and cannot tell from a proxy route that looks identical for both.
        kind: row.kind ?? null,
        ownerId: row.owner_id,
        ownerLabel: row.owner_label,
        // No `url`. Deliberately, and the absence is the security property: a
        // caller that wants to play this has to go through the proxy route, which
        // looks the row up again and never renders the URL into a page.
      };
    })
    .filter(Boolean)
    .slice(0, 10);

  return { channels, owners: new Set(channels.map((c) => c.ownerId)).size, channelCount };
}

/** From an event page. */
export async function sharedChannelsForEvent({ viewerId, event }) {
  return sharedChannelsFor({
    viewerId,
    title: event.subject_name,
    genreName: event.genre_name,
    categoryName: event.category,
  });
}

/** And from a subject page, for the same reason as ownChannelsForSubject. */
export async function sharedChannelsForSubject({ viewerId, subject, genreName = null }) {
  return sharedChannelsFor({
    viewerId,
    title: subject.display_name ?? subject.name,
    genreName,
    categoryName: subject.category,
  });
}
