import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { EventPage } = await import('../apps/web/src/views/pages.jsx');

const event = {
  id: 7,
  name: 'Severance 2x03',
  subject_slug: 'severance-1',
  subject_name: 'Severance',
  subject_id: 3,
  category: 'tv',
  kind: 'episode',
  starts_at: '2026-09-04T18:30:00Z',
  time_known: true,
  precision: 'minute',
  venue: 'Apple TV+',
};

const render = async (ownChannels) =>
  (
    await EventPage({
      user: { id: 1, email: 'x@example.com' },
      event,
      genres: [],
      comments: [],
      following: false,
      ownChannels,
    }).toString()
  ).toString();

describe("a reader's own channel list on an event page", () => {
  /*
   * The regression this pins, ported from upstream: rendering nothing when a list
   * IS present but nothing matched is indistinguishable from the feature being
   * broken. "None of your 7,059 channels look like they have this" is an answer;
   * silence is not.
   */
  test('says so when the list has nothing for this event', async () => {
    const out = await render({ hasList: true, channelCount: 7059, matches: [], genre: [] });
    expect(out).toContain('7,059');
    expect(out).toMatch(/None of your/);
  });

  test('lists matches when there are some', async () => {
    const out = await render({
      hasList: true,
      channelCount: 12,
      matches: [{ id: 44, title: 'Severance S02', url: 'http://x/1.ts' }],
      genre: [],
    });
    expect(out).toContain('Severance S02');
    expect(out).toContain('/my/channels/44/playlist.m3u');
    expect(out).not.toMatch(/None of your/);
  });

  /*
   * A 24/7 genre channel is a DIFFERENT claim from "your show is on this", so it
   * is a separate group with its own wording.
   *
   * It no longer needs its own tier in the link: rows are addressed by row id, so
   * which list a row was ranked into cannot change what the link resolves to. That
   * was the point of the change -- an index only means something inside one
   * ranking on one page, and the subject page ranks the same entries with no event
   * to index against.
   */
  test('genre channels are a separate group with their own wording', async () => {
    const out = await render({
      hasList: true,
      channelCount: 12,
      matches: [],
      genre: [{ id: 31, title: 'Horror HD', url: 'http://x/2.ts' }],
    });
    expect(out).toContain('Horror HD');
    expect(out).toContain('/my/channels/31/check');
    expect(out).toMatch(/may or may not be/);
  });

  test('nothing at all is rendered for a reader with no list', async () => {
    const out = await render({ hasList: false, channelCount: 0, matches: [], genre: [] });
    expect(out).not.toContain('In your channel list');
  });
});
