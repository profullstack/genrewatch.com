import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';

/**
 * Magic link + passkey. There is no password anywhere in this file, by design:
 * the emailed link already proves control of the address, and a password would only
 * add a weaker second secret whose recovery path collapses back to emailing a link.
 */

const TOKEN_TTL_MINUTES = 20;

/** rpID must match the host the credential was created on, so it is derived from
 *  SITE_URL rather than the request -- otherwise a passkey made on the apex simply
 *  does not exist on the railway.app hostname and login fails with no error. */
export const rpID = new URL(config.siteUrl).hostname;
export const rpName = 'GenreWatch';

/**
 * Every origin a credential may legitimately be created from.
 *
 * The apex and `www` both serve this app, and an rpID of `genrewatch.com` is valid
 * for both -- so the browser happily creates the credential on `www`, the password
 * manager saves it, and then the server rejects the response because its single
 * expectedOrigin was the apex. The user sees a passkey in Bitwarden and no account
 * to use it with, which is the worst of both outcomes.
 *
 * SimpleWebAuthn accepts an array, so list them rather than picking one.
 */
export const expectedOrigins = (() => {
  const site = new URL(config.siteUrl);
  const origins = new Set([site.origin]);
  if (site.hostname.startsWith('www.')) {
    origins.add(`${site.protocol}//${site.hostname.slice(4)}`);
  } else {
    origins.add(`${site.protocol}//www.${site.hostname}`);
  }
  for (const extra of (process.env.EXTRA_WEBAUTHN_ORIGINS ?? '').split(',')) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed.replace(/\/$/, ''));
  }
  return [...origins];
})();

const hashToken = (t) => createHash('sha256').update(t).digest();

/* ------------------------------------------------------------- magic link -- */

/**
 * Mint a sign-in link. Returns the URL for the caller to email.
 *
 * The caller must answer the user identically whether or not the address is known:
 * a different response for a registered address turns this endpoint into a way to
 * enumerate who has an account.
 */
export async function createLoginLink(email) {
  const token = randomBytes(32).toString('base64url');
  await q.insertLoginToken({
    tokenHash: hashToken(token),
    email: email.trim().toLowerCase(),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000),
  });
  return `${config.siteUrl}/auth/magic?t=${token}`;
}

/**
 * Spend a link and return a session id.
 *
 * This is also the registration path: an address nobody has used before gets an
 * account here rather than being turned away to find a sign-up form.
 */
export async function consumeLoginLink(token, { userAgent } = {}) {
  const email = await q.consumeLoginToken(hashToken(token));
  if (!email) return null;
  const user = await q.findOrCreateUser(email);
  const sessionId = await q.startSession({
    userId: user.id,
    ttlDays: config.session.ttlDays,
    userAgent,
  });
  return { user, sessionId };
}

/* ---------------------------------------------------------------- passkey -- */

export async function passkeyRegistrationOptions(user) {
  const existing = await q.listPasskeys(user.id);
  return generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userID: Buffer.from(user.id),
    attestationType: 'none',
    // Stops the same authenticator silently registering twice, which shows up later
    // as a device that cannot be told apart in the settings list.
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

export async function verifyPasskeyRegistration({ user, response, expectedChallenge }) {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
  });
  if (!v.verified || !v.registrationInfo) return false;

  const { credential } = v.registrationInfo;
  await q.insertPasskey({
    credentialId: credential.id,
    userId: user.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: response.response?.transports ?? [],
  });
  return true;
}

export async function passkeyAuthenticationOptions() {
  // No allowCredentials: the browser offers whatever resident key it holds, so the
  // user never has to say who they are before proving it.
  return generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
}

export async function verifyPasskeyAuthentication({ response, expectedChallenge, userAgent }) {
  const stored = await q.getPasskey(response.id);
  if (!stored) return null;

  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
    credential: {
      id: stored.credential_id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.counter),
      transports: stored.transports,
    },
  });
  if (!v.verified) return null;

  await q.touchPasskey(stored.credential_id, v.authenticationInfo.newCounter);
  const sessionId = await q.startSession({
    userId: stored.user_id,
    ttlDays: config.session.ttlDays,
    userAgent,
  });
  return { userId: stored.user_id, sessionId };
}

/* --------------------------------------------------------------- sessions -- */

export async function userFromRequest(cookieValue) {
  if (!cookieValue) return null;
  return q.getSessionUser(cookieValue);
}

export function sessionCookie(sessionId, { clear = false } = {}) {
  const parts = [
    `${config.session.cookie}=${clear ? '' : sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${config.session.ttlDays * 86400}`,
  ];
  if (config.isProd) parts.push('Secure');
  return parts.join('; ');
}

/** Constant-time compare for the CoinPay webhook signature. */
export function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export { open, seal } from './secretbox.js';
