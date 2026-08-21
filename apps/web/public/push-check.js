/* The notification self-check.
   Runs the same steps the toggle runs, one at a time, and says which one failed.
   Kept out of app.js because it only ever runs on one page, on demand. */

const steps = document.getElementById('check-steps');
const verdict = document.getElementById('check-verdict');
const run = document.getElementById('run-check');

/** Deadlines matter more here than anywhere: a hang IS the finding. */
const SUBSCRIBE_MS = 25_000;

const say = (text, kind) => {
  verdict.textContent = text;
  verdict.className = `feedback ${kind}`;
  verdict.hidden = false;
};

function step(label, detail, state) {
  const li = document.createElement('li');
  li.className = `check-step ${state}`;
  const strong = document.createElement('strong');
  strong.textContent = label;
  li.append(strong);
  if (detail) {
    const span = document.createElement('span');
    span.textContent = detail;
    li.append(span);
  }
  steps.append(li);
  return li;
}

const withDeadline = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('timed out'), { timedOut: true })), ms),
    ),
  ]);

const isBrave = async () => {
  try {
    return (await navigator.brave?.isBrave?.()) === true;
  } catch {
    return false;
  }
};

/** Send the findings home so a support conversation does not need a screenshot. */
async function report(result) {
  await fetch('/api/push/diag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  }).catch(() => {});
}

run.addEventListener('click', async () => {
  run.disabled = true;
  steps.replaceChildren();
  steps.hidden = false;
  verdict.hidden = true;

  const result = { ua: navigator.userAgent, brave: await isBrave() };

  try {
    // 1. Does this browser have the pieces at all?
    const supported = 'serviceWorker' in navigator && 'PushManager' in window;
    result.supported = supported;
    step(
      'Browser support',
      supported ? 'service workers and push are both present' : 'this browser has no push support',
      supported ? 'ok' : 'bad',
    );
    if (!supported) {
      say('This browser cannot do web push at all. Email reminders still work.', 'error');
      return;
    }

    // 2. Is the key on the page?
    result.vapid = Boolean(window.__VAPID);
    step(
      'Server key',
      result.vapid ? `present, ${window.__VAPID.length} characters` : 'missing from the page',
      result.vapid ? 'ok' : 'bad',
    );
    if (!result.vapid) {
      say('The site did not send its notification key. That is our bug, not yours.', 'error');
      return;
    }

    // 3. The worker.
    await navigator.serviceWorker.register('/sw.js');
    const reg = await withDeadline(navigator.serviceWorker.ready, 10_000);
    result.worker = reg.active?.state ?? null;
    step('Service worker', `${result.worker} at ${reg.scope}`, 'ok');

    // 4. Permission.
    result.permission = Notification.permission;
    if (Notification.permission === 'default') {
      result.permission = await Notification.requestPermission().catch(() => 'default');
    }
    result.permissionState = await reg.pushManager
      .permissionState({ userVisibleOnly: true })
      .catch(() => 'unknown');
    step(
      'Permission',
      `${result.permission} (push says ${result.permissionState})`,
      result.permission === 'granted' ? 'ok' : 'bad',
    );
    if (result.permission !== 'granted') {
      say('Notifications are not allowed for this site yet, so there is nothing to test.', 'error');
      await report(result);
      return;
    }

    // 5. The step that actually fails.
    const existing = await withDeadline(reg.pushManager.getSubscription(), 5_000).catch(() => null);
    if (existing) {
      result.existing = true;
      step('Existing subscription', 'this browser is already subscribed', 'ok');
      say('This browser is already subscribed. Notifications should be working.', 'ok');
      await report(result);
      return;
    }

    const key = (() => {
      const b = window.__VAPID;
      const padded = (b + '='.repeat((4 - (b.length % 4)) % 4))
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    })();

    const pending = step('Subscribing', `waiting up to ${SUBSCRIBE_MS / 1000}s…`, 'wait');
    const started = performance.now();
    try {
      const sub = await withDeadline(
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
        SUBSCRIBE_MS,
      );
      result.ms = Math.round(performance.now() - started);
      result.endpointHost = new URL(sub.endpoint).host;
      pending.className = 'check-step ok';
      pending.replaceChildren();
      pending.append(
        Object.assign(document.createElement('strong'), { textContent: 'Subscribing' }),
        Object.assign(document.createElement('span'), {
          textContent: `worked in ${result.ms}ms via ${result.endpointHost}`,
        }),
      );
      await sub.unsubscribe().catch(() => {});
      say('Everything works. Go back and turn notifications on — it should stick now.', 'ok');
    } catch (err) {
      result.ms = Math.round(performance.now() - started);
      result.error = err?.timedOut ? 'HUNG' : `${err?.name}: ${err?.message}`;
      pending.className = 'check-step bad';
      pending.replaceChildren();
      pending.append(
        Object.assign(document.createElement('strong'), { textContent: 'Subscribing' }),
        Object.assign(document.createElement('span'), {
          textContent: err?.timedOut
            ? `never answered — still waiting after ${SUBSCRIBE_MS / 1000}s`
            : `refused: ${result.error}`,
        }),
      );

      // A hang and a refusal have different causes, and only one of them is ours.
      if (err?.timedOut && result.brave) {
        say(
          'Brave never answered. Turn on “Use Google services for push messaging” in brave://settings/privacy, restart Brave, then run this again.',
          'error',
        );
      } else if (err?.timedOut) {
        say(
          'Your browser never answered its own push service. That connection is blocked or missing — a VPN, a firewall or a custom DNS resolver is the usual cause. Email reminders still work.',
          'error',
        );
      } else {
        say(`Your browser refused the subscription: ${result.error}`, 'error');
      }
    }
  } catch (err) {
    step('Unexpected', `${err?.name}: ${err?.message}`, 'bad');
    result.error = `${err?.name}: ${err?.message}`;
    say('The check itself fell over. The detail above is what happened.', 'error');
  } finally {
    run.disabled = false;
    await report(result);
  }
});
