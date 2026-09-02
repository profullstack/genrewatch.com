import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { Layout } = await import('../apps/web/src/views/Layout.jsx');

const html = async (props) => (await Layout(props).toString()).toString();

describe('Layout', () => {
  test('carries the known timezone for a signed-in visitor', async () => {
    const out = await html({ user: { timezone: 'America/New_York' }, children: 'x' });
    expect(out).toContain('data-known-tz="America/New_York"');
  });

  test('defaults a signed-in visitor with no stored zone to UTC', async () => {
    const out = await html({ user: {}, children: 'x' });
    expect(out).toContain('data-known-tz="UTC"');
  });

  test('omits the attribute entirely when signed out', async () => {
    // Signed-out pages are cached and served byte-identical to everyone, so a
    // timezone attribute here would be one visitor's zone shown to the next -- and
    // would make every reader POST a correction for a session that does not exist.
    const out = await html({ user: null, children: 'x' });
    expect(out).not.toContain('data-known-tz');
  });

  test('names the data sources on every page', async () => {
    // ESPN supplies this site with nothing -- it was the sibling sports site's
    // provider and rode along in the port. Name the ones the catalogue is really
    // built from, and keep TMDB's required disclaimer with them.
    const out = await html({ user: null, children: 'x' });
    for (const source of ['TMDB', 'TVmaze', 'AniList', 'MusicBrainz', 'The Space Devs', 'IMDb']) {
      expect(out).toContain(source);
    }
    expect(out).toContain('not endorsed or certified by TMDB');
    expect(out).not.toContain('ESPN');
  });
});

describe('timezone precedence', () => {
  test('the chosen zone rides on the body so it can win over the browser', async () => {
    const out = await html({ user: { timezone: 'America/Los_Angeles' }, children: 'x' });
    expect(out).toContain('data-tz="America/Los_Angeles"');
  });

  test('a signed-out visitor carries no zone at all', async () => {
    // Signed-out pages are cached and served byte-identical, so one visitor's zone
    // must never be baked in for the next.
    const out = await html({ user: null, children: 'x' });
    expect(out).not.toContain('data-tz=');
  });

  test('the client prefers the chosen zone and will not overwrite it', async () => {
    const src = await Bun.file(
      new URL('../apps/web/public/app.js', import.meta.url).pathname,
    ).text();

    // The bug: the setting applied only to email, so someone who set PST still saw
    // their device's zone on every page and concluded the app ignored them.
    expect(src).toContain('document.body?.dataset?.tz');
    expect(src).toContain('const zone = chosen ||');
    // And auto-detection must stop once a zone has actually been set.
    expect(src).toContain("known !== 'UTC'");
  });
});
