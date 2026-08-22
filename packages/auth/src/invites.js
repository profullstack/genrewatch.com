import { randomBytes } from 'node:crypto';
import { config } from '@genre/config';
import * as q from '@genre/db/queries';

/**
 * Inviting people.
 *
 * Two halves with very different risk. A shareable link costs nothing and needs no
 * limits, because the inviter does the sending themselves through whatever they
 * already use. "Email it for me" is the half that needs care: it puts our domain on
 * the envelope of mail a stranger did not ask for, and the bill for that is paid in
 * the deliverability of every reminder we send to everybody else.
 *
 * So the sending half is capped per account per day, refuses an address somebody
 * else already invited recently, and never says which of those happened -- the
 * invitee's relationship with this site is not something the inviter gets to query.
 */

/** Short enough to read out loud, long enough not to be guessed at. */
const CODE_BYTES = 9;

/** Per account per day. Generous for a person, useless for a mailing list. */
export const DAILY_SEND_LIMIT = 10;

/** How many addresses one submission may carry. */
export const MAX_PER_SUBMISSION = 5;

/**
 * A month of quiet after anybody invites an address.
 *
 * Not scoped to the inviter: being emailed the same pitch by three different people
 * is precisely what makes this feel like spam to the one party who never opted in.
 */
const REINVITE_QUIET_DAYS = 30;

export const inviteUrl = (code) => `${config.siteUrl}/i/${code}`;

/**
 * The two functions below take their database and mailer as arguments.
 *
 * Not a testing affectation: these are the only things in this package that both
 * write rows AND send mail to strangers, so the collaborators worth substituting are
 * exactly the two that have outside effects. Passing them in also keeps the tests
 * from having to replace the whole queries module globally, which in a shared test
 * process quietly replaces it for every other file too.
 */

/** Minted on first use rather than for every account that ever signs up. */
export async function inviteCodeFor(userId, db = q) {
  return db.ensureInviteCode({ userId, code: randomBytes(CODE_BYTES).toString('base64url') });
}

/**
 * What the invitee is told the sender is called.
 *
 * A chosen name or handle only. Never the inviter's email address -- they gave it to
 * us to receive reminders, not to have it handed to whoever they recommend the site
 * to. "Someone" is a worse invitation and the right default.
 */
export const inviterName = (user) =>
  user?.display_name || (user?.handle ? `@${user.handle}` : 'Someone');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Split a textarea or comma-separated field into addresses.
 *
 * Deduplicated, because pasting a list twice should not spend two of somebody's ten.
 */
export function parseAddresses(raw) {
  const seen = new Set();
  for (const part of String(raw ?? '').split(/[\s,;]+/)) {
    const address = part.trim().toLowerCase();
    if (address && EMAIL_RE.test(address)) seen.add(address);
  }
  return [...seen];
}

/**
 * Send the invite link to some addresses, within the limits.
 *
 * The result counts rather than naming outcomes per address, and that is deliberate:
 * telling the sender "that one was skipped, they already have an account" would turn
 * this form into the address checker the sign-in page is careful not to be. From the
 * outside, "already invited by somebody else" and "invited fine" look the same.
 *
 * @param {(args: {email: string, url: string, from: string}) => Promise<unknown>} send
 */
export async function sendInvites({ user, raw, send, db = q }) {
  const addresses = parseAddresses(raw);
  if (addresses.length === 0) return { ok: false, error: 'No usable email addresses in that.' };
  if (addresses.length > MAX_PER_SUBMISSION) {
    return { ok: false, error: `Up to ${MAX_PER_SUBMISSION} at a time, please.` };
  }

  const alreadySent = await db.invitesSentSince(user.id, { hours: 24 });
  const remaining = DAILY_SEND_LIMIT - alreadySent;
  if (remaining <= 0) {
    return {
      ok: false,
      error: `That is ${DAILY_SEND_LIMIT} invites today, which is the limit. Share your link instead — it has no limit.`,
    };
  }

  const code = await inviteCodeFor(user.id, db);
  const url = inviteUrl(code);
  const from = inviterName(user);

  let sent = 0;
  let skipped = 0;
  for (const email of addresses.slice(0, remaining)) {
    // Never mail the sender their own invite, and never pile onto somebody who has
    // already had one of these from anybody.
    if (
      email === String(user.email ?? '').toLowerCase() ||
      (await db.invitedRecently({ email, days: REINVITE_QUIET_DAYS }))
    ) {
      skipped++;
      continue;
    }
    try {
      await send({ email, url, from });
      await db.recordInviteSend({ inviterId: user.id, email });
      sent++;
    } catch {
      // One address failing is not a reason to abandon the rest, and the sender is
      // told a count rather than which one bounced.
      skipped++;
    }
  }

  const overflow = Math.max(0, addresses.length - remaining);
  return { ok: true, sent, skipped: skipped + overflow };
}

/**
 * Credit an inviter, once, for an account that did not exist before.
 *
 * Only for a genuinely new account: somebody who already had one and happened to
 * open a friend's link was not invited, and counting them would make the number on
 * the page a lie. Failure is silent by design -- a sign-in must never break because
 * an invite code was stale, mistyped, or belonged to a deleted account.
 */
export async function claimInvite({ code, user, created, db = q }) {
  if (!code || !created || !user?.id) return false;
  try {
    const inviter = await db.getUserByInviteCode(code);
    if (!inviter) return false;
    return await db.recordInviteClaim({ inviterId: inviter.id, invitedUserId: user.id });
  } catch {
    return false;
  }
}
