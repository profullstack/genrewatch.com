import { config } from '@genre/config';
import * as q from '@genre/db/queries';
import { sendPushToMany } from '@profullstack/notifications/server';

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
 * Which of a film's three windows a row is, as the phrase a reader expects.
 *
 * Without it every reminder for a film said "starts", which is right for a
 * premiere and wrong for the day something lands on Netflix -- and the three
 * windows of one film read as the same reminder three times.
 */
export function windowPhrase(event) {
  const key = String(event.provider_key ?? '');
  if (key.startsWith('tmdb:stream:')) return event.venue ? `On ${event.venue}` : 'Streaming';
  if (key.startsWith('tmdb:digital:')) return 'To rent or buy';
  if (key.startsWith('tmdb:release:')) return 'In cinemas';
  return null;
}

/**
 * The words on a lock screen and in an inbox, for a reminder or an announcement.
 *
 * Date-only events (films, albums -- most of this site) are anchored to noon UTC,
 * so "starts in 24 hours" and "starts in 0 minutes" were both literally true and
 * both wrong; they read as tomorrow and today. The sports fields this was cloned
 * with (league_name) do not exist here, which is why every body ended in
 * "undefined".
 */
export function messageFor(event, offsetMinutes, { timezone = 'UTC' } = {}) {
  const title = titleFor(event);
  const window = windowPhrase(event);
  const timed = event.time_known !== false;
  const date = new Date(event.starts_at).toLocaleDateString('en-US', {
    timeZone: timed ? timezone : 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const context = [window, event.genre_name].filter(Boolean)[0] ?? event.subject_name ?? '';

  if (offsetMinutes === q.ANNOUNCE_OFFSET) {
    const out = new Date(event.starts_at).getTime() <= Date.now();
    const what = window ?? 'Out';
    const body = out ? `${what} now` : `${what} from ${date}`;
    return { title, body, subject: `${title}: ${body.charAt(0).toLowerCase()}${body.slice(1)}` };
  }

  if (!timed) {
    const when = offsetMinutes >= 1440 ? 'tomorrow' : 'today';
    const what = window ?? 'Out';
    const body = `${what} ${when}`;
    return { title, body, subject: `${title}: ${body.charAt(0).toLowerCase()}${body.slice(1)}` };
  }

  return {
    title,
    body: `Starts ${phrase(offsetMinutes)}${context ? ` — ${context}` : ''}`,
    subject: `${title} starts ${phrase(offsetMinutes)}`,
  };
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

  const msg = messageFor(event, offsetMinutes, { timezone: target.timezone || 'UTC' });
  const announce = offsetMinutes === q.ANNOUNCE_OFFSET;
  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body,
    // Its own tag, so the reminder later does not silently replace the news.
    tag: announce ? `announce-${event.id}` : `event-${event.id}`,
    url: `${config.siteUrl}/events/${event.id}`,
  });

  const results = await sendPushToMany(
    target.push_subscriptions.map((s) => ({
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    })),
    payload,
    {
      keys: { publicKey: config.push.publicKey, privateKey: config.push.privateKey },
      subject: config.push.subject,
      // A reminder is worthless once its moment passes; an announcement is still
      // news to a phone that was off overnight.
      ttl: announce ? 86_400 : Math.max(60, offsetMinutes * 60),
      onGone: (endpoint) => q.disablePushSubscription(endpoint),
    },
  );
  const delivered = results.filter((r) => r.sent).length;

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

  const msg = messageFor(event, offsetMinutes, { timezone: target.timezone || 'UTC' });
  const timed = event.time_known !== false;
  // A date-only row is anchored to noon UTC; printing that as a clock time in the
  // reader's zone is a time nobody announced.
  const when = timed
    ? `${new Date(event.starts_at).toLocaleString('en-US', {
        timeZone: target.timezone || 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short',
      })} (${target.timezone || 'UTC'})`
    : new Date(event.starts_at).toLocaleDateString('en-US', {
        timeZone: 'UTC',
        dateStyle: 'full',
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
      subject: msg.subject,
      text: [
        msg.title,
        msg.body,
        when,
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
/**
 * An invite, sent on somebody's behalf.
 *
 * `from` is a chosen display name or handle, never the inviter's email address --
 * they gave us that to receive reminders, not to have it handed to everyone they
 * recommend the site to. The envelope stays ours so that a reply goes nowhere
 * surprising and so this cannot be used to forge mail from a stranger.
 *
 * It says how the recipient got here and how to stop, because an email somebody
 * did not ask for owes them both.
 */
export async function sendInviteEmail({ email, url, from }) {
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
      subject: `${from} thinks you would like GenreWatch`,
      text:
        `${from} uses GenreWatch to know before things drop — shows, films, albums, rocket launches.\n\n` +
        `Have a look:\n\n${url}\n\n` +
        'It is free, nothing on your own list is advertising, and it works as a plain calendar feed if you would rather not be notified at all.\n\n' +
        'You received this because somebody typed your address into an invite form. ' +
        'We have not created an account for you and will not email you again about it.',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

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
