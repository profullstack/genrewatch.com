import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const cp = await import('../src/lib/coinpay-signin.js');
const { SignIn } = await import('../src/views/pages.jsx');
const html = async (node) => String(await node.toString());

function memoryStore(identities = []) {
  let n = 0;
  const ids = [...identities];
  return {
    ids,
    store: {
      identityBySub: async (sub) => ids.find((r) => r.coinpay_sub === sub) ?? null,
      identityByUser: async (u) => ids.find((r) => r.user_id === u) ?? null,
      link: async (row) => {
        if (ids.some((r) => r.coinpay_sub === row.coinpay_sub || r.user_id === row.user_id))
          return 'conflict';
        ids.push(row);
        return 'ok';
      },
      unlink: async (u) => {
        const i = ids.findIndex((r) => r.user_id === u);
        if (i >= 0) ids.splice(i, 1);
      },
      touch: async () => {},
      createUser: async () => `new-${++n}`,
      deleteUser: async () => {},
    },
  };
}

const cfg = {
  clientId: 'cp_x',
  clientSecret: 's',
  issuer: 'https://coinpayportal.com',
  siteUrl: 'https://genrewatch.com',
};

describe('Sign in with CoinPay', () => {
  test('authorize URL carries PKCE S256, state, nonce and the exact redirect', () => {
    const p = cp.newPendingAuth('login', '/following');
    const url = new URL(cp.authorizeUrl(cfg, p));
    expect(url.origin + url.pathname).toBe('https://coinpayportal.com/api/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(p.challenge);
    expect(url.searchParams.get('state')).toBe(p.state);
    expect(url.searchParams.get('nonce')).toBe(p.nonce);
    expect(url.searchParams.get('redirect_uri')).toBe(`https://genrewatch.com${cp.CALLBACK_PATH}`);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
  });

  test('pending cookie round-trips; off-site next falls back', () => {
    for (const evil of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      expect(cp.decodePending(cp.encodePending(cp.newPendingAuth('login', evil))).next).toBe(
        '/following',
      );
    }
    expect(cp.decodePending('junk')).toBeNull();
  });

  test('forged or missing state is rejected', () => {
    expect(cp.stateMatches('a', 'b')).toBe(false);
    expect(cp.stateMatches('a', undefined)).toBe(false);
    expect(cp.stateMatches('a', 'a')).toBe(true);
  });

  test('an email collision does NOT take over the existing account', async () => {
    const { store, ids } = memoryStore();
    const r = await cp.resolveCoinpayUser(
      {
        mode: 'login',
        currentUserId: null,
        claims: { sub: 'attacker', email: 'victim@example.com', name: null },
      },
      store,
    );
    expect(r).toEqual({ ok: true, userId: 'new-1', action: 'created' });
    expect(ids[0].created_via).toBe('signup');
    expect(cp.isPlaceholderEmail(cp.placeholderEmail())).toBe(true);
  });

  test('a returning sub signs in to its bound account', async () => {
    const { store } = memoryStore([{ user_id: 'u1', coinpay_sub: 's1', created_via: 'connect' }]);
    expect(
      await cp.resolveCoinpayUser(
        { mode: 'login', currentUserId: null, claims: { sub: 's1', email: null, name: null } },
        store,
      ),
    ).toEqual({ ok: true, userId: 'u1', action: 'login' });
  });

  test('linking needs a session and refuses a sub bound elsewhere', async () => {
    const { store } = memoryStore([
      { user_id: 'other', coinpay_sub: 'taken', created_via: 'signup' },
    ]);
    const claims = (sub) => ({ sub, email: null, name: null });
    expect(
      (
        await cp.resolveCoinpayUser(
          { mode: 'connect', currentUserId: null, claims: claims('x') },
          store,
        )
      ).code,
    ).toBe('not_signed_in');
    expect(
      (
        await cp.resolveCoinpayUser(
          { mode: 'connect', currentUserId: 'me', claims: claims('taken') },
          store,
        )
      ).code,
    ).toBe('linked_elsewhere');
    expect(
      await cp.resolveCoinpayUser(
        { mode: 'connect', currentUserId: 'me', claims: claims('mine') },
        store,
      ),
    ).toEqual({
      ok: true,
      userId: 'me',
      action: 'linked',
    });
  });

  test('disconnect is refused when CoinPay is the only way in', async () => {
    const { store, ids } = memoryStore([{ user_id: 'u', coinpay_sub: 's', created_via: 'signup' }]);
    expect((await cp.disconnectCoinpay({ id: 'u', email: cp.placeholderEmail() }, store)).ok).toBe(
      false,
    );
    expect(ids.length).toBe(1);
    expect(await cp.disconnectCoinpay({ id: 'u', email: 'me@example.com' }, store)).toEqual({
      ok: true,
    });
    expect(ids.length).toBe(0);
  });

  test('the sign-in page offers CoinPay first only when configured', async () => {
    // bun runs every test file in one process: put the env back afterwards.
    const saved = {
      id: process.env.COINPAY_OAUTH_CLIENT_ID,
      secret: process.env.COINPAY_OAUTH_CLIENT_SECRET,
    };
    try {
      delete process.env.COINPAY_OAUTH_CLIENT_ID;
      expect(await html(<SignIn mode="login" />)).not.toContain('Sign in with CoinPay');
      process.env.COINPAY_OAUTH_CLIENT_ID = 'cp_x';
      process.env.COINPAY_OAUTH_CLIENT_SECRET = 's';
      const page = await html(<SignIn mode="login" next="/following" />);
      expect(page).toContain('Sign in with CoinPay');
      expect(page.indexOf('Sign in with CoinPay')).toBeLessThan(page.indexOf('Email me a link'));
      expect(await html(<SignIn mode="signup" invite="INV-ABCD" />)).not.toContain('with CoinPay');
    } finally {
      for (const [k, v] of [
        ['COINPAY_OAUTH_CLIENT_ID', saved.id],
        ['COINPAY_OAUTH_CLIENT_SECRET', saved.secret],
      ]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
