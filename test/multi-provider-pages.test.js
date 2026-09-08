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
/*
 * Settings takes the LINES, each already carrying its masked address.
 *
 * It used to take "the playlist" plus the list of them, because one row got a
 * card and the rest got a name and a Remove button. Every line has a card now, so
 * there is one prop and no first row to privilege.
 */
const settings = (lines) =>
  render(
    Settings({
      user,
      prefs,
      passkeys: [],
      passwordMinLength: 10,
      lines,
      shareLine: lines.find((l) => !l.managed) ?? null,
    }),
  );

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
  test('gives each one a card, not a name and a Remove button', async () => {
    const html = await settings([
      line(1, 'First provider', { masked: 'http://one.example/***' }),
      line(2, 'Second provider', { masked: 'http://two.example/***' }),
    ]);
    expect(html).toContain('First provider');
    expect(html).toContain('Second provider');
    expect(html).toContain('id="line-1"');
    expect(html).toContain('id="line-2"');
    // Every form on every card names its row. Unnamed, the delete route falls
    // back to "every list this reader has".
    expect(html).toContain('name="playlist_id" value="1"');
    expect(html).toContain('name="playlist_id" value="2"');
    // The whole point of the change: the second line is editable, not just
    // removable. Two addresses, two edit forms, two Refresh buttons.
    expect(html.match(/data-playlist-url/g) ?? []).toHaveLength(2);
    expect(html.match(/action="\/api\/playlist\/refresh"/g) ?? []).toHaveLength(2);
    expect(html.match(/action="\/api\/playlist\/delete"/g) ?? []).toHaveLength(2);
    // Adding is its own form, and carries no id -- that is what makes it an add
    // rather than an edit of a card.
    expect(html).toContain('Add another line');
  });

  test('a reader with one line sees the same card, and is offered another', async () => {
    const html = await settings([line(1, 'Only provider', { masked: 'http://one.example/***' })]);
    expect(html).toContain('id="line-1"');
    expect(html).toContain('data-playlist-url');
    expect(html).toContain('Add another line');
  });

  test('a reader with none is offered the add form, not an empty card', async () => {
    const html = await settings([]);
    expect(html).toContain('id="add-line"');
    expect(html).toContain('Add a list');
    expect(html).not.toContain('data-playlist-url');
  });

  test('a managed line among them offers no Remove, and no address', async () => {
    const html = await settings([
      line(1, 'First provider', { masked: 'http://one.example/***' }),
      line(2, 'GenreWatch Live TV', { managed: true }),
    ]);
    expect(html).toContain('Live TV pass');
    // Deleting the row we provisioned would leave the pass paid for and nothing to
    // play it on. It goes when the pass lapses, not from a button here.
    expect(html).not.toContain('name="playlist_id" value="2"');
    // And its address is ours, not theirs: one card, one Show button, both the
    // reader's own line's.
    expect(html.match(/data-playlist-url/g) ?? []).toHaveLength(1);
  });

  test('a reader whose only line came with a pass is not promised a switch', async () => {
    const html = await settings([line(1, 'GenreWatch Live TV', { managed: true })]);
    // Our line is not shareable and never will be, so "once you have added a
    // list" would be a promise made to somebody who has one.
    expect(html).not.toContain('Once you have added a list');
    expect(html).not.toContain('/api/playlist/share');
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
