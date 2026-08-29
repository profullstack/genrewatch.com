import { open } from '@genre/auth';
import * as q from '@genre/db/queries';
import { maskPlaylistUrl } from './mask.js';

/**
 * Reading back the address a reader gave us.
 *
 * The stored URL is sealed because it carries the reader's provider username and
 * password in its path, and for a long time that was read as "it can never be
 * shown" -- so settings offered a label, a count, Refresh and Remove, and nothing
 * else. That is not privacy, it is amnesia: the only way to change a list was to
 * delete it and type the whole credentialed URL again, which meant keeping a copy
 * of it somewhere less safe than here.
 *
 * The credential belongs to the account that supplied it, so showing it back to
 * that same account, behind that same session, discloses nothing it did not
 * already have. What is kept is the discipline around it: masked by default,
 * revealed only on a deliberate request, and never written into a cached page.
 */

export { maskPlaylistUrl } from './mask.js';

/**
 * The stored address, in the clear, for the account that stored it.
 *
 * Takes a user id and uses it, like every other query in this feature -- there is
 * no variant that takes a playlist id, because that is the shape that leaks it
 * later. Returns null rather than throwing when the seal cannot be opened: a
 * rotated PLAYLIST_SECRET makes an old row unreadable, and the reader's answer to
 * that is to paste the URL again, not to see a stack trace.
 */
export async function playlistSource(userId) {
  const row = await q.getPlaylist(userId);
  if (!row) return null;
  const url = open(row.source_url);
  return {
    label: row.label ?? null,
    url: url ?? null,
    masked: url ? maskPlaylistUrl(url) : null,
  };
}
