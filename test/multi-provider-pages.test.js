import { describe, expect, test } from 'bun:test';
import { ChannelRow, Channels, Settings } from '../apps/web/src/views/pages.jsx';

/**
 * What the reader actually sees, rendered.
 *
 * The pages are where "one list" was assumed most deeply -- a heading that counts
 * one row, a Remove button that names none, a section-level answer to a question
 * that is now per entry. These render the components rather than reading their
 * source, because a mistake in a branch only a SECOND list reaches is invisible
 * both to a text assertion and to every existing test, all of which render one.
 */

const render = async (node) => String(await node.toString());
const user = { id: 'u1', email: 'a@b.c', handle: 'chovy', display_name: 'Anthony' };
const line = (id, label, over) => ({
  id,
  label,
  channel_count: 1000,
  last_synced_at: null,
  last_error: null,
  managed: false,
  position: id,
  ...over,
});
const prefs = { offsets_minutes: [60], date_offsets_minutes: [1440], channels: ['email'] };
const settings = (playlist, playlists) =>
  render(Settings({ user, prefs, passkeys: [], passwordMinLength: 10, playlist, playlists }));

describe('the channel page adds up every line', () => {
  test('counts them all, not just the first', async () => {
    const html = await render(
      Channels({
        user,
        playlist: line(1, 'First provider'),
        playlists: [line(1, 'First provider'), line(2, 'Second provider')],
        groups: [{ name: 'Movies', count: 40 }],
        kinds: [],
      }),
    );
    /*
     * Two thousand across the two, where the heading used to read one row's count
     * against groups that already spanned the lot. "1,000 channels in 40 groups"
     * to somebody holding two thousand reads as a list we lost, not as a number we
     * added up wrong.
     */
    expect(html).toContain('2,000 channels');
    expect(html).toContain('across 2 lines');
  });

  test('names the line that stopped answering', async () => {
    const html = await render(
      Channels({
        user,
        playlist: line(1, 'First provider'),
        playlists: [
          line(1, 'First provider'),
          line(2, 'Second provider', { last_error: 'the provider answered 404' }),
        ],
        groups: [],
        kinds: [],
      }),
    );
    // Unnamed, a reader with three providers cannot tell which one is broken.
    expect(html).toContain('Second provider: the provider answered 404');
  });

  test('reads exactly as it did for somebody with one line', async () => {
    const html = await render(
      Channels({
        user,
        playlist: line(1, 'Only provider'),
        playlists: [line(1, 'Only provider')],
        groups: [{ name: 'Movies', count: 40 }],
        kinds: [],
      }),
    );
    expect(html).toContain('1,000 channels');
    // No tally of lines for somebody who has one: it would be noise stating the
    // only answer there is.
    expect(html).not.toContain('across 1 lines');
  });
});

describe('settings, with several lines on the account', () => {
  test('lists the others, each removable by name', async () => {
    const html = await settings(line(1, 'First provider'), [
      line(1, 'First provider'),
      line(2, 'Second provider'),
    ]);
    expect(html).toContain('Your other lines');
    expect(html).toContain('Second provider');
    // The main card's Remove and the other-lines row's Remove name different rows.
    // Unnamed, the route falls back to "every list this reader has".
    expect(html).toContain('name="playlist_id" value="1"');
    expect(html).toContain('name="playlist_id" value="2"');
    // Adding is its own form, and carries no id -- that is what makes it an add
    // rather than an edit of the card above.
    expect(html).toContain('Add another line');
  });

  test('a managed line among them offers no Remove', async () => {
    const html = await settings(line(1, 'First provider'), [
      line(1, 'First provider'),
      line(2, 'GenreWatch Live TV', { managed: true }),
    ]);
    expect(html).toContain('Live TV pass');
    // Deleting the row we provisioned would leave the pass paid for and nothing to
    // play it on. It goes when the pass lapses, not from a button here.
    expect(html).not.toContain('name="playlist_id" value="2"');
  });

  test('one line grows no empty other-lines section', async () => {
    const html = await settings(line(1, 'Only provider'), [line(1, 'Only provider')]);
    expect(html).not.toContain('Your other lines');
  });

  test('no line at all still offers the plain add form and nothing else', async () => {
    const html = await settings(null, []);
    expect(html).not.toContain('Your other lines');
    // The form below already says "Add a list"; a second add form beside it would
    // be two ways to do one thing.
    expect(html).not.toContain('Add another line');
  });
});

describe('an entry carries its own answer about what it may hand over', () => {
  test('a reader entry names its line and keeps the external players', async () => {
    const html = await render(
      ChannelRow({
        ch: {
          id: 9,
          title: 'Blade Runner 2049',
          url: 'http://line.example/a/b/9',
          playlistId: 1,
          providerLabel: 'First provider',
          providerManaged: false,
        },
      }),
    );
    expect(html).toContain('First provider');
    expect(html).toContain('VLC');
  });

  test('a managed entry beside it hands over nothing', async () => {
    /*
     * The row directly below the one above, from our line, in the same merged
     * list. VLC, Infuse and the .m3u each hand over the stream address, which on
     * our line IS the reseller credential -- and a section-level answer cannot
     * tell these two rows apart, so it would have published it.
     */
    const html = await render(
      ChannelRow({
        ch: {
          id: 10,
          title: 'Blade Runner 2049',
          url: 'http://line.example/x/y/10',
          playlistId: 2,
          providerLabel: 'GenreWatch Live TV',
          providerManaged: true,
        },
      }),
    );
    expect(html).toContain('GenreWatch Live TV');
    expect(html).not.toContain('VLC');
    expect(html).not.toContain('Infuse');
    expect(html).not.toContain('.m3u');
  });

  test('a row that does not know its line still obeys the section', async () => {
    // The pages rendering a single known list pass `managed` and their rows carry
    // no playlist identity. Those must keep behaving exactly as they did.
    const html = await render(
      ChannelRow({ ch: { id: 11, title: 'Anything', url: 'http://x/y' }, managed: true }),
    );
    expect(html).not.toContain('VLC');
  });

  test('a single-provider reader is not tagged with the only answer there is', async () => {
    const html = await render(
      ChannelRow({ ch: { id: 12, title: 'Anything', url: 'http://x/y', playlistId: 1 } }),
    );
    // providerLabel absent, so no tag: a badge repeating "your list" on every row
    // is noise for the reader it does not distinguish anything for.
    expect(html).not.toContain('channel-tag provider');
  });
});
