/**
 * Premium membership, and the commission an invite earns on it.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS SHARED VERBATIM BETWEEN BRANDS. Do not import a brand package.
 * ---------------------------------------------------------------------------
 *
 * Same rule and same reason as index.js beside it: one source cannot name two
 * different scopes, so a file that imports `@tipoff/db` can never be the file
 * genrewatch runs. Everything here is either pure or takes the caller's
 * transaction, exactly like `grantEventEntitlement` -- which is what lets
 * `cp packages/payments/src/membership.js` be the whole port.
 *
 * It touches three tables by name -- memberships, invite_claims,
 * referral_commissions -- and those names are identical on both sides on purpose.
 *
 * What is NOT here: reading whether somebody is currently a member. That is a
 * plain query with no money in it and it lives with the other reads, in each
 * brand's queries.js.
 */

/**
 * The metadata tag that tells a webhook this payment bought a membership.
 *
 * A brand sells more than one thing through one webhook, and the settled payload
 * carries no product of its own -- only the metadata bag we sent at checkout. So
 * this string is the entire difference between granting a year of membership and
 * granting a seat at a fixture, and it is defined once rather than typed twice.
 */
export const MEMBERSHIP_KIND = 'membership';

/**
 * What an inviter earns on one payment.
 *
 * Floored, deliberately. Rounding a fraction of a cent up pays out marginally more
 * than was taken in, on every transaction, forever; rounding down pays marginally
 * less and can never overdraw. On the numbers this actually sees -- 20% of $10 --
 * it is exact either way, and the floor is there for the case that is not.
 */
export function commissionCents({ amountCents, rateBps }) {
  if (!Number.isFinite(amountCents) || !Number.isFinite(rateBps)) return 0;
  if (amountCents <= 0 || rateBps <= 0) return 0;
  return Math.floor((amountCents * rateBps) / 10_000);
}

/**
 * Add one paid term to somebody's membership, inside the caller's transaction.
 *
 * A renewal STACKS rather than restarts. The new term begins at whichever is
 * later, now or the end of what they already hold -- so somebody who renews with
 * three months left keeps those three months instead of donating them back. That
 * choice is made in SQL rather than in JavaScript because the value it reads is
 * the same row set it is about to write to, and reading it in a separate round
 * trip is how two concurrent webhooks both compute the same start date and grant
 * two overlapping years.
 *
 * Idempotent through `payment_id`, which is unique: the upstream retries a webhook
 * until it gets a 200, and without that constraint every retry is another year.
 *
 * @param {Function} tx the caller's transaction, as a tagged template
 * @param {object} args
 * @param {string} args.userId
 * @param {number|null} args.paymentId  the row in `payments`, not the provider ref
 * @param {number} args.priceCents
 * @param {string} args.currency
 * @param {number} args.termDays
 */
export async function grantMembership(tx, { userId, paymentId, priceCents, currency, termDays }) {
  if (!userId) throw new Error('a membership needs a member');
  if (!Number.isFinite(termDays) || termDays <= 0) throw new Error('a membership needs a term');
  if (!Number.isFinite(priceCents) || priceCents < 0) throw new Error('bad price');

  const [row] = await tx`
    insert into memberships (user_id, payment_id, started_at, expires_at, price_cents, currency)
    select ${userId}::uuid,
           ${paymentId ?? null},
           s.start_at,
           s.start_at + make_interval(days => ${Math.trunc(termDays)}::int),
           ${Math.trunc(priceCents)}::int,
           ${currency ?? 'USD'}
    from (
      select greatest(now(), coalesce(max(expires_at), now())) as start_at
      from memberships
      where user_id = ${userId}::uuid and status = 'active'
    ) s
    on conflict (payment_id) do nothing
    returning started_at, expires_at
  `;

  // Nothing inserted means this exact payment already bought a term -- a retried
  // webhook, which is normal and must answer the same way it did the first time
  // rather than looking like a failure and being retried harder.
  if (!row) {
    const [existing] = await tx`
      select started_at, expires_at from memberships where payment_id = ${paymentId ?? null}
    `;
    return existing ? { ...existing, replayed: true } : null;
  }

  return { ...row, replayed: false };
}

/**
 * Credit whoever invited this buyer, once, for this payment.
 *
 * Runs in the same transaction as the payment it is a percentage of, so there is
 * no window in which money is recorded and the commission owed on it is not.
 *
 * Returns null -- not an error -- when nobody invited the buyer, which is the
 * common case and must not fail a webhook. A payment that settles is a payment
 * that settles whether or not anybody earns anything from it.
 *
 * `payment_id` is unique on the commission table, so the `do nothing` is the
 * second half of the same idempotency guarantee the membership gets: a retried
 * webhook credits an inviter exactly once.
 */
export async function creditReferral(tx, { buyerId, paymentId, amountCents, currency, rateBps }) {
  if (!buyerId || !paymentId) return null;

  const amount = commissionCents({ amountCents, rateBps });
  if (amount <= 0) return null;

  const [claim] = await tx`
    select inviter_id from invite_claims where invited_user_id = ${buyerId}::uuid
  `;
  if (!claim?.inviter_id) return null;

  const [row] = await tx`
    insert into referral_commissions
      (referrer_id, buyer_id, payment_id, amount_cents, rate_bps, currency)
    values (${claim.inviter_id}::uuid, ${buyerId}::uuid, ${paymentId},
            ${amount}::int, ${Math.trunc(rateBps)}::int, ${currency ?? 'USD'})
    on conflict (payment_id) do nothing
    returning id, referrer_id, amount_cents
  `;

  return row ?? null;
}
