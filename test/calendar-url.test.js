import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { Following } = await import('../apps/web/src/views/pages.jsx');

const FEED = 'https://genrewatch.com/calendar/9f2c1b7a4e.ics';

const render = async (props) =>
  (
    await Following({
      user: { id: 1, email: 'x@example.com' },
      events: [],
      follows: [],
      calendarUrl: FEED,
      ...props,
    }).toString()
  ).toString();

describe('calendar subscription by URL', () => {
  /**
   * The three buttons cover the clients we can deep-link into. Everything else --
   * Outlook, Thunderbird, Fastmail, a phone's stock calendar -- subscribes by having
   * a URL pasted into it, and the page offered nothing to paste.
   */
  test('shows the feed URL in a field that can be copied', async () => {
    const out = await render();
    expect(out).toContain(`value="${FEED}"`);
    expect(out).toContain('readonly');
    expect(out).toContain('data-copy="#calendar-url"');
  });

  test('the field is readable with no script at all', async () => {
    const out = await render();
    // A readonly input carries its value in the markup; a div filled in by script
    // would leave a non-JS visitor with an empty box and no way to subscribe.
    const field = out.slice(out.indexOf('id="calendar-url"'));
    expect(field.slice(0, 200)).toContain(FEED);
  });

  test('says where to paste it', async () => {
    const out = await render();
    expect(out).toContain('Google Calendar');
    expect(out).toContain('New Calendar Subscription');
    expect(out).toContain('Subscribe from web');
  });

  test('nothing calendar-shaped renders without a feed URL', async () => {
    const out = await render({ calendarUrl: null });
    expect(out).not.toContain('calendar-url');
    expect(out).not.toContain('Add to your calendar');
  });

  test('a copy button exists to serve the field', async () => {
    const src = await readFile(
      new URL('../apps/web/public/app.js', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('[data-copy]');
    expect(src).toContain('initCopyButtons()');
    // The clipboard is refusable and absent on insecure origins; the fallback must
    // leave the text selected rather than the button dead.
    expect(src).toContain('field.select?.()');
  });
});
