/**
 * Sign in with CoinPay (CoinPay is the house master account).
 *
 * Confidential OIDC client: authorization code + PKCE S256 + state + nonce,
 * exact redirect https://genrewatch.com/api/v1/coinpay/oauth/callback, scopes
 * "openid profile email". The protocol half (authorize URL, code exchange that
 * always sends the client secret, id_token iss/aud/exp/nonce checks, userinfo
 * sub match) is @profullstack/coinpay-onboard/oauth.
 *
 * STANDING security rule: a CoinPay login binds to the CoinPay `sub`
 * (coinpay_identities). It never signs in to an existing account because the
 * CoinPay email matches (CoinPay never verifies emails), never stores that email
 * as users.email, and never grants anything from it. Linking CoinPay to an
 * existing account happens only from Settings while signed in to it. A first
 * CoinPay login with no link creates a NEW account with a placeholder address.
 */
import { randomBytes } from 'node:crypto';
import {
  authorizeUrl as cpAuthorizeUrl,
  pkce,
  randomToken,
  SIGN_IN_SCOPES,
  sameState,
} from '@profullstack/coinpay-onboard/oauth';

export const COINPAY_ISSUER = 'https://coinpayportal.com';
export const CALLBACK_PATH = '/api/v1/coinpay/oauth/callback';
export const OAUTH_COOKIE = 'gw_cp_oauth';
export const OAUTH_COOKIE_PATH = '/api/v1/coinpay/oauth';
export const OAUTH_COOKIE_MAX_AGE = 600;
export const SETTINGS_PATH = '/settings';
/** users.email of accounts a CoinPay login made. Nobody receives mail here. */
export const PLACEHOLDER_EMAIL_DOMAIN = 'coinpay-users.genrewatch.com';

export function coinpayConfig(env = process.env) {
  const clientId = (env.COINPAY_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (env.COINPAY_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  const issuer = (env.COINPAY_OAUTH_ISSUER || COINPAY_ISSUER).replace(/\/+$/, '');
  const siteUrl = (env.SITE_URL || 'https://genrewatch.com').replace(/\/+$/, '');
  return { clientId, clientSecret, issuer, siteUrl };
}

export const redirectUri = (cfg) => cfg.siteUrl + CALLBACK_PATH;

const hasControlChar = (v) =>
  [...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** Same-site paths only; `//host`, `/\host` and control characters fall back. */
export function safeNext(next, mode = 'login') {
  const fallback = mode === 'connect' ? SETTINGS_PATH : '/following';
  if (typeof next !== 'string' || !next.startsWith('/') || next.length > 500) return fallback;
  if (/^\/[\\/]/.test(next) || next.includes('\\') || hasControlChar(next)) return fallback;
  return next;
}

export function newPendingAuth(mode, next) {
  const { verifier, challenge } = pkce();
  return {
    state: randomToken(24),
    verifier,
    nonce: randomToken(24),
    mode,
    next: safeNext(next, mode),
    challenge,
  };
}

export function encodePending(p) {
  return Buffer.from(
    JSON.stringify({ s: p.state, v: p.verifier, n: p.nonce, m: p.mode, r: p.next }),
  ).toString('base64url');
}

export function decodePending(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!o || typeof o.s !== 'string' || typeof o.v !== 'string' || typeof o.n !== 'string')
      return null;
    if (o.m !== 'login' && o.m !== 'connect') return null;
    return { state: o.s, verifier: o.v, nonce: o.n, mode: o.m, next: safeNext(o.r, o.m) };
  } catch {
    return null;
  }
}

export function authorizeUrl(cfg, p) {
  return cpAuthorizeUrl({
    clientId: cfg.clientId,
    redirectUri: redirectUri(cfg),
    state: p.state,
    nonce: p.nonce,
    challenge: p.challenge,
    scopes: SIGN_IN_SCOPES,
    base: cfg.issuer,
  });
}

export const stateMatches = (expected, got) => sameState(expected, got);

export function placeholderEmail() {
  return `cp-${randomBytes(12).toString('hex')}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/**
 * Which user a verified CoinPay sub belongs to. Never looks at the email: a
 * CoinPay login whose email equals an existing user's gets a NEW account (or the
 * one already bound to its sub), never that user's.
 */
export async function resolveCoinpayUser({ mode, currentUserId, claims }, store) {
  const bound = await store.identityBySub(claims.sub);
  if (mode === 'connect') {
    if (!currentUserId) {
      return {
        ok: false,
        code: 'not_signed_in',
        error: 'Sign in first, then connect CoinPay from Settings.',
      };
    }
    if (bound) {
      if (bound.user_id === currentUserId)
        return { ok: true, userId: currentUserId, action: 'linked' };
      return {
        ok: false,
        code: 'linked_elsewhere',
        error: 'That CoinPay account is already connected to another GenreWatch account.',
      };
    }
    if (await store.identityByUser(currentUserId)) {
      return {
        ok: false,
        code: 'already_connected',
        error:
          'This account is already connected to a different CoinPay account. Disconnect it first.',
      };
    }
    const r = await store.link({
      user_id: currentUserId,
      coinpay_sub: claims.sub,
      coinpay_email: claims.email,
      coinpay_name: claims.name,
      created_via: 'connect',
    });
    if (r === 'conflict')
      return {
        ok: false,
        code: 'linked_elsewhere',
        error: 'That CoinPay account was just connected elsewhere.',
      };
    return { ok: true, userId: currentUserId, action: 'linked' };
  }
  if (bound) {
    await store.touch(claims.sub);
    return { ok: true, userId: bound.user_id, action: 'login' };
  }
  const userId = await store.createUser();
  const r = await store.link({
    user_id: userId,
    coinpay_sub: claims.sub,
    coinpay_email: claims.email,
    coinpay_name: claims.name,
    created_via: 'signup',
  });
  if (r === 'conflict') {
    await store.deleteUser(userId).catch(() => {});
    const again = await store.identityBySub(claims.sub);
    if (again) return { ok: true, userId: again.user_id, action: 'login' };
    throw new Error('coinpay identity conflict');
  }
  return { ok: true, userId, action: 'created' };
}

/** Disconnect is refused when CoinPay is the only way into the account. */
export async function disconnectCoinpay(user, store) {
  if (!(await store.identityByUser(user.id))) return { ok: true };
  if (!user.email || isPlaceholderEmail(user.email)) {
    return {
      ok: false,
      error: 'CoinPay is the only way to sign in to this account, so it cannot be disconnected.',
    };
  }
  await store.unlink(user.id);
  return { ok: true };
}

/** The real store over @genre/db/queries. */
export function dbCoinpayStore(q) {
  return {
    identityBySub: q.coinpayIdentityBySub,
    identityByUser: q.coinpayIdentityByUser,
    link: q.linkCoinpayIdentity,
    unlink: q.unlinkCoinpayIdentity,
    touch: q.touchCoinpayIdentity,
    createUser: () => q.createUserWithEmail(placeholderEmail()),
    deleteUser: q.deleteUser,
  };
}
