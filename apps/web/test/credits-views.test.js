import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const { InviteLanding, InvitesPage, RedeemCard, RedeemPage, bonusLine, redeemedNotice } =
  await import('../src/views/credits.jsx');
const { SignIn } = await import('../src/views/pages.jsx');
const html = async (node) => String(await node.toString());
const src = readFileSync(new URL('../src/app.js', import.meta.url).pathname, 'utf8');
const user = { id: 'u1', email: 'a@example.test', handle: 'a' };

/**
 * The pages for credit codes and scarce invites, and the wiring in app.js that
 * the PGlite tests in test/credits.test.js cannot reach.
 */

describe('the "Have a code?" card', () => {
  test('posts the code to the redeem route and says what happened', async () => {
    const out = await html(
      <RedeemCard next="/settings#redeem" notice="Redeemed: 3 days" error="Nope" />,
    );
    expect(out).toContain('Have a code?');
    expect(out).toContain('action="/api/credits/redeem"');
    expect(out).toContain('name="code"');
    expect(out).toContain('value="/settings#redeem"');
    expect(out).toContain('Redeemed: 3 days');
    expect(out).toContain('Nope');
  });

  test('/redeem prefills a code from a link', async () => {
    const out = await html(<RedeemPage user={user} code="CR-AAAA-BBBB-CCCC-DDDD" />);
    expect(out).toContain('value="CR-AAAA-BBBB-CCCC-DDDD"');
  });

  test('the notice names the unit and the days', () => {
    expect(redeemedNotice('live_pass_days', '7')).toBe('Redeemed: 7 days of Live TV pass added.');
    expect(redeemedNotice('premium_days', '1')).toContain('1 day of');
    expect(redeemedNotice(null, null)).toBeNull();
  });
});

describe('/invites', () => {
  const quota = { total: 3, used: 1, left: 2 };

  test('shows what is left, what an invite gives, and the list', async () => {
    const out = await html(
      <InvitesPage
        user={user}
        quota={quota}
        bonus={{ unit: 'live_pass_days', days: 3 }}
        invites={[
          { id: 'i1', note: 'Sam', status: 'open', created_at: '2026-10-26T00:00:00Z' },
          { id: 'i2', note: '', status: 'used', created_at: '2026-10-26T00:00:00Z' },
        ]}
        affiliateUrl="https://genrewatch.com/i/abcdefghijkl"
      />,
    );
    expect(out).toContain('You have 2 of 3 invites left');
    expect(out).toContain('you both get 3 days of Live TV pass');
    expect(out).toContain('action="/api/invites"');
    expect(out).toContain('action="/api/invites/i1/revoke"');
    expect(out).not.toContain('action="/api/invites/i2/revoke"');
    expect(out).toContain('https://genrewatch.com/i/abcdefghijkl');
  });

  test('a fresh invite is shown with its link; none left says so', async () => {
    const fresh = await html(
      <InvitesPage
        user={user}
        quota={{ total: 3, used: 3, left: 0 }}
        created={{ code: 'INV-AAAA-BBBB-CCCC', url: 'https://x.test/i/INV-AAAA-BBBB-CCCC' }}
      />,
    );
    expect(fresh).toContain('https://x.test/i/INV-AAAA-BBBB-CCCC');
    expect(fresh).toContain('No invites left');
    expect(fresh).not.toContain('action="/api/invites"');
  });
});

describe('/i/<code>', () => {
  test('a good invite sends a stranger to sign up with it', async () => {
    const out = await html(
      <InviteLanding
        user={null}
        code="INV-AAAA-BBBB-CCCC"
        status="ok"
        bonus={{ unit: 'premium_days', days: 7 }}
      />,
    );
    expect(out).toContain('/signup?invite=INV-AAAA-BBBB-CCCC');
    expect(out).toContain('7 days of');
  });

  test('a used one says so', async () => {
    const out = await html(<InviteLanding user={null} code="INV-AAAA-BBBB-CCCC" status="used" />);
    expect(out).toContain('already been used');
    expect(out).not.toContain('/signup?invite=');
  });

  test('bonusLine is null when an invite gives nothing', () => {
    expect(bonusLine(null)).toBeNull();
  });
});

describe('the sign-up form carries the invite', () => {
  test('as a hidden field on the magic-link form', async () => {
    const out = await html(<SignIn mode="signup" invite="INV-AAAA-BBBB-CCCC" />);
    expect(out).toContain('name="invite" value="INV-AAAA-BBBB-CCCC"');
    const plain = await html(<SignIn mode="signup" />);
    expect(plain).not.toContain('name="invite"');
  });
});

describe('app.js wiring', () => {
  test('every route is there', () => {
    for (const route of [
      "app.get('/redeem'",
      "app.post('/api/credits/redeem'",
      "app.get('/invites'",
      "app.get('/api/invites'",
      "app.post('/api/invites'",
      "app.post('/api/invites/:id/revoke'",
    ]) {
      expect(src).toContain(route);
    }
  });

  test('invite links are never charged as a crawler', () => {
    const open = src.slice(
      src.indexOf('openPaths: ['),
      src.indexOf('],', src.indexOf('openPaths: [')),
    );
    expect(open).toContain("'/i/'");
  });

  test('the scarce invite is accepted only with `created`, after the commission claim', () => {
    const magic = src.slice(src.indexOf("app.get('/auth/magic', async"));
    const body = magic.slice(0, magic.indexOf('\n});\n'));
    expect(body).toContain(
      'credits.acceptInvite({ userId: result.user.id, code: scarce, created: result.created })',
    );
    expect(body.indexOf('auth.claimInvite')).toBeLessThan(body.indexOf('credits.acceptInvite'));
  });

  test('/i/ keeps the old commission link working for codes that are not INV-', () => {
    const route = src.slice(src.indexOf("app.get('/i/:code'"));
    const body = route.slice(0, route.indexOf('\n});\n'));
    expect(body).toContain('credits.looksLikeInvite(code)');
    expect(body).toContain('setCookie(c, INVITE_COOKIE, code');
    expect(body).toContain("c.redirect('/signup', 302)");
    // The INV- branch comes first: an INV- code also fits the commission pattern.
    expect(body.indexOf('credits.looksLikeInvite(code)')).toBeLessThan(
      body.indexOf('setCookie(c, INVITE_COOKIE, code'),
    );
  });
});
