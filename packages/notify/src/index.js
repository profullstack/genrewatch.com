import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import webpush from 'web-push';

if (config.push.enabled) {
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
}

/** "in 1 minute" / "in 1 hour" -- the phrase people actually read on a lock screen. */
function phrase(offsetMinutes) {
  if (offsetMinutes < 60) return `in ${offsetMinutes} minute${offsetMinutes === 1 ? '' : 's'}`;
  const h = Math.round(offsetMinutes / 60);
  return `in ${h} hour${h === 1 ? '' : 's'}`;
}

function titleFor(event) {
  if (event.home_name && event.away_name) return `${event.away_name} at ${event.home_name}`;
  return event.name;
}

/**
 * Web push to every live subscription a user has.
 *
 * A person with three browsers has three subscriptions and should be told once per
 * device. A 404 or 410 means the browser discarded the subscription -- that is the
 * push service telling us to stop, so the row is disabled rather than retried
 * forever. Any other status is a real failure and is allowed to throw so the caller
 * records it and BullMQ retries.
 */
export async function sendPush(target, { event, offsetMinutes }) {
  if (!config.push.enabled) throw new Error('VAPID keys not configured');

  const payload = JSON.stringify({
    title: titleFor(event),
    body: `Starts ${phrase(offsetMinutes)} — ${event.league_name}`,
    tag: `event-${event.id}`,
    url: `${config.siteUrl}/events/${event.id}`,
  });

  const results = await Promise.allSettled(
    target.push_subscriptions.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: Math.max(60, offsetMinutes * 60) },
      ),
    ),
  );

  let delivered = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      delivered++;
      continue;
    }
    const code = r.reason?.statusCode;
    if (code === 404 || code === 410) {
      await q.disablePushSubscription(target.push_subscriptions[i].endpoint);
    }
  }

  // Every endpoint being dead is not a delivery. Throwing lets the caller mark the
  // row failed, which is the difference between "we tried" and "they were told".
  if (delivered === 0) throw new Error('no live push endpoint');
  return delivered;
}

/**
 * Email via Resend. Plain fetch rather than the SDK -- one HTTP call does not
 * justify a dependency, and this way the failure is a status code we can read.
 */
export async function sendEmail(target, { event, offsetMinutes }) {
  if (!config.mail.enabled) throw new Error('RESEND_API_KEY not configured');

  const title = titleFor(event);
  const when = new Date(event.starts_at).toLocaleString('en-US', {
    timeZone: target.timezone || 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.mail.resendKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.mail.from,
      to: target.email,
      subject: `${title} starts ${phrase(offsetMinutes)}`,
      text: [
        `${title}`,
        `${event.league_name}${event.venue ? ` — ${event.venue}` : ''}`,
        `Starts ${when} (${target.timezone || 'UTC'})`,
        '',
        `${config.siteUrl}/events/${event.id}`,
        '',
        `Stop these: ${config.siteUrl}/settings`,
      ].join('\n'),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

/** Magic link. The only transactional mail that is not a reminder. */
export async function sendLoginLink({ email, url }) {
  if (!config.mail.enabled) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.mail.resendKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.mail.from,
      to: email,
      subject: 'Your GenreWatch sign-in link',
      text: `Tap to sign in:\n\n${url}\n\nThe link works once and expires in 20 minutes.\nIf you did not ask for it, ignore this email.`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
