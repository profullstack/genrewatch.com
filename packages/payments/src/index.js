import { createHmac } from 'node:crypto';
import { safeEqualHex } from '@genre/auth';
import { config } from '@genre/config';
import { sql } from '@genre/db';

/**
 * CoinPay checkout for a single game's stream.
 *
 * Deliberately narrow: this module can start a payment and verify a webhook, and
 * nothing else. Granting an entitlement happens in one place (`grantFromWebhook`)
 * so there is exactly one code path that can turn money into access.
 */

/** Grace after the final whistle. A live stream grant is never open-ended. */
const ENTITLEMENT_GRACE_HOURS = 6;

export async function createCheckout({ user, event, offer }) {
  if (!config.coinpay.enabled) throw new Error('CoinPay is not configured');

  const res = await fetch(`${config.coinpay.baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.coinpay.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      business_id: config.coinpay.businessId,
      amount: offer.price_cents / 100,
      currency: offer.currency,
      description: `Stream: ${event.name}`,
      // Echoed back on the webhook. This is what links a payment to the thing bought;
      // without it a settled payment cannot be attributed to an event.
      metadata: { user_id: user.id, event_id: String(event.id), offer_id: String(offer.id) },
      success_url: `${config.siteUrl}/events/${event.id}?paid=1`,
      cancel_url: `${config.siteUrl}/events/${event.id}`,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`coinpay ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();

  await sql`
    insert into payments ${sql({
      user_id: user.id,
      provider: 'coinpay',
      provider_ref: body.id ?? body.payment_id,
      amount_cents: offer.price_cents,
      currency: offer.currency,
      status: 'pending',
      raw: body,
    })}
    on conflict (provider, provider_ref) do nothing
  `;

  return body.checkout_url ?? body.url;
}

/**
 * Verify a CoinPay webhook signature.
 *
 * Signed over the RAW request bytes -- re-serialising the parsed JSON changes key
 * order and whitespace and the signature stops matching, which reads as a forged
 * request rather than the bug it is. The timestamp window is what stops a captured
 * webhook being replayed later.
 */
export function verifyWebhook({ rawBody, signatureHeader, toleranceSeconds = 300 }) {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => kv.split('=').map((s) => s.trim())),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', config.coinpay.webhookSecret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  try {
    return safeEqualHex(expected, v1);
  } catch {
    return false;
  }
}

/**
 * Settle a payment and grant access, atomically.
 *
 * Capacity is enforced inside the same transaction as the grant. Checking it first
 * and inserting after is the classic oversell: two buyers pass the check together
 * and both get a seat that only exists once. The conditional UPDATE ... WHERE
 * sold < capacity is what makes the last seat go to exactly one of them.
 */
/** Statuses that mean money actually arrived. Everything else records and grants nothing. */
const SETTLED = new Set(['paid', 'completed', 'confirmed', 'succeeded', 'settled']);

export async function grantFromWebhook(payload) {
  const meta = payload.metadata ?? {};
  const userId = meta.user_id;
  const eventId = Number(meta.event_id);
  const offerId = Number(meta.offer_id);
  const ref = payload.id ?? payload.payment_id;
  const status = String(payload.status ?? '').toLowerCase();

  if (!userId || !Number.isFinite(eventId)) throw new Error('webhook missing metadata');
  if (!ref) throw new Error('webhook missing payment reference');

  return sql.begin(async (tx) => {
    const [payment] = await tx`
      update payments set status = ${status || 'unknown'}, raw = ${payload}, updated_at = now()
      where provider = 'coinpay' and provider_ref = ${ref}
      returning id, status
    `;

    // A webhook fires for failures and cancellations too. Granting on any verified
    // webhook would consume a seat and hand out a free stream for a payment that
    // never settled -- the signature proves the message is genuine, not that money
    // arrived.
    if (!SETTLED.has(status)) return { granted: false, reason: `not settled (${status})` };

    const [claimed] = await tx`
      update stream_offers set sold = sold + 1
      where id = ${offerId} and active and sold < capacity
      returning id
    `;
    if (!claimed) return { granted: false, reason: 'sold-out' };

    const [event] = await tx`select starts_at from events where id = ${eventId}`;
    if (!event) return { granted: false, reason: 'event-gone' };

    const expiresAt = new Date(
      new Date(event.starts_at).getTime() + ENTITLEMENT_GRACE_HOURS * 3600_000,
    );

    await tx`
      insert into entitlements ${tx({
        user_id: userId,
        event_id: eventId,
        offer_id: offerId,
        payment_id: payment?.id ?? null,
        status: 'active',
        expires_at: expiresAt,
      })}
      on conflict (user_id, event_id) do nothing
    `;

    return { granted: true, expiresAt };
  });
}

export async function activeEntitlement({ userId, eventId }) {
  const [row] = await sql`
    select * from entitlements
    where user_id = ${userId} and event_id = ${eventId}
      and status = 'active' and expires_at > now()
  `;
  return row ?? null;
}

export async function offersForEvent(eventId) {
  return sql`
    select id, price_cents, currency, capacity, sold, (capacity - sold) as remaining
    from stream_offers
    where event_id = ${eventId} and active and sold < capacity
    order by price_cents
  `;
}
