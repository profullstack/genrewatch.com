/* Progressive enhancement only. Every control on this site already works as a plain
   form; this file localises times and adds push notifications and passkeys where the
   browser has them. */

/* ------------------------------------------------------------ local time -- */

/**
 * Rewrite server-rendered UTC times into the viewer's own zone.
 *
 * Schedule pages are cached in Redis and served byte-identical to everyone, so the
 * server cannot bake in a per-viewer timezone. It emits UTC plus a machine-readable
 * `datetime`, and this rewrites the visible text. With JavaScript off the page still
 * shows a correct time, labelled UTC.
 */
function localiseTimes(root = document) {
  // A zone the visitor picked in settings beats the browser's. Without this the
  // setting only affected email, so someone who set PST still saw their device's
  // zone on every page and reasonably concluded the app ignored them.
  const chosen = document.body?.dataset?.tz || null;
  const zone = chosen || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const inZone = chosen ? { timeZone: chosen } : {};
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...inZone,
  });
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...inZone,
  });

  for (const el of root.querySelectorAll('time[data-local]')) {
    const at = new Date(el.getAttribute('datetime'));
    if (Number.isNaN(+at)) continue;
    const t = el.querySelector('[data-local-time]');
    const d = el.querySelector('[data-local-day]');
    if (t) t.textContent = time.format(at);
    if (d) d.textContent = day.format(at);
    el.title = `${at.toLocaleString(undefined, inZone)} (${zone})`;
  }

  for (const el of document.querySelectorAll('[data-tz-label]')) el.textContent = zone;

  // Two forms, because they read in different places. Prose wants the full IANA
  // name ("America/Los_Angeles"); a schedule row wants the abbreviation people
  // actually say ("PDT"), which is short enough to sit under the time.
  const abbr = shortZone(zone, inZone);
  for (const el of root.querySelectorAll('[data-tz-abbr]')) el.textContent = abbr;
}

/** "PDT" for a zone, falling back to its IANA name where there is no short form. */
function shortZone(zone, inZone) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: 'short',
      ...inZone,
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    return name || zone;
  } catch {
    return zone;
  }
}

/**
 * Tell the server which zone we are in, once.
 *
 * Email reminders are rendered on a server with no browser, so they need a stored
 * zone or they go out in UTC and look an hour or eight wrong. Only sent when it
 * actually differs from what the server already has.
 */
async function reportTimezone() {
  const el = document.querySelector('[data-known-tz]');
  if (!el) return;
  const known = el.getAttribute('data-known-tz');

  // Auto-detect only while the account is still on the untouched default. Once a
  // zone has been set, the device must not quietly overwrite it -- that is how
  // "my timezone is set to PST" ends up displaying something else entirely.
  if (known && known !== 'UTC') return;

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || zone === known) return;
  await fetch('/api/timezone', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ timezone: zone }),
  }).catch(() => {});
}

/* --------------------------------------------------------------- helpers -- */

const postJson = (url, body, { timeoutMs } = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A request with no ceiling is another way for a button to sit on a message
    // forever. AbortSignal.timeout is missing on older Safari; there it just waits.
    signal: timeoutMs && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  });

/** Say what happened. The passkey button used to fail in total silence. */
function say(el, message, kind = 'info') {
  if (!el) return;
  el.textContent = message;
  el.className = `feedback ${kind}`;
  el.hidden = false;
}

/* ------------------------------------------------------------------ push -- */

const urlB64ToUint8Array = (b64) => {
  const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

/**
 * Register the worker and wait for it to be *active*.
 *
 * `register()` resolves while the worker is still installing, and subscribing
 * against a registration with no active worker fails -- so on a first visit the
 * button could fail for a reason that had nothing to do with the user.
 */
async function registerSw() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    await navigator.serviceWorker.register('/sw.js');
    return await navigator.serviceWorker.ready;
  } catch (err) {
    console.warn('sw registration failed', err);
    return null;
  }
}

/* How long each hangable step is given before the button says something useful.
   The prompt gets the longer one: a real person reading a permission dialog is
   slow, and cutting them off mid-decision would be its own bug. */
const PERMISSION_DEADLINE_MS = 90_000;
/** How often the browser's own permission state is re-read while the prompt is up. */
const PERMISSION_POLL_MS = 400;
const SUBSCRIBE_DEADLINE_MS = 20_000;
/** Reading back an existing subscription is local, so it gets a short one. */
const READBACK_DEADLINE_MS = 3_000;
const SAVE_DEADLINE_MS = 15_000;

/** Race a promise against a deadline, so no branch can leave the button waiting forever. */
const withDeadline = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('timed out'), { timedOut: true })), ms),
    ),
  ]);

/**
 * Ask for permission, and notice an answer given anywhere else.
 *
 * `Notification.requestPermission()` settles only when the page's own prompt is
 * answered. Chrome shows that prompt quietly -- a bell in the address bar -- and
 * lets the choice be made from site settings instead; answer it there and the
 * promise stays pending for the life of the page. That is the reported bug:
 * notifications allowed in the browser, button still saying it is waiting.
 *
 * So the browser's own permission state is polled alongside the prompt, and
 * whichever reports first wins. Polling rather than the Permissions API, which
 * cannot observe notifications in every browser we serve.
 */
function askPermission() {
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(state ?? Notification.permission);
    };

    const poll = setInterval(() => {
      if (Notification.permission !== 'default') finish(Notification.permission);
    }, PERMISSION_POLL_MS);

    // Safari long took only a callback and returned undefined; newer browsers
    // return a promise and still honour the callback.
    let request;
    try {
      request = Notification.requestPermission(finish);
    } catch (err) {
      console.warn('requestPermission threw', err);
      finish(Notification.permission);
      return;
    }
    if (request && typeof request.then === 'function') {
      request.then(finish, () => finish(Notification.permission));
    }
  });
}

/**
 * Is this Brave?
 *
 * Brave ships with Google's push service switched off, and `subscribe()` then never
 * settles rather than failing -- so the generic "unreachable" message is true but
 * useless. Brave exposes `navigator.brave.isBrave()` for exactly this kind of
 * feature-specific advice.
 */
async function isBrave() {
  try {
    return (await navigator.brave?.isBrave?.()) === true;
  } catch {
    return false;
  }
}

/**
 * Notification toggle.
 *
 * Every branch reports what happened and re-enables the button. The two awaits
 * that can hang indefinitely -- the permission prompt, and the browser's own call
 * out to its push service -- are bounded, because a control sitting on "waiting"
 * with no way forward is indistinguishable from a broken one.
 */
async function initPush() {
  const box = document.getElementById('push-optin');
  const btn = document.getElementById('enable-push');
  const label = document.getElementById('push-state');
  const msg = document.getElementById('push-msg');
  if (!box || !btn) return;

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && window.__VAPID;
  if (!supported) {
    box.hidden = false;
    if (label)
      label.textContent = 'This browser cannot show notifications. Email reminders still work.';
    btn.hidden = true;
    return;
  }

  const reg = await registerSw();
  if (!reg) {
    box.hidden = false;
    if (label)
      label.textContent = 'Notifications are unavailable here. Email reminders still work.';
    btn.hidden = true;
    return;
  }

  async function paint() {
    // Bounded: this read is what reveals the control, so a wedged push manager must
    // not be able to hide the whole thing behind a promise that never settles.
    const sub = await withDeadline(reg.pushManager.getSubscription(), READBACK_DEADLINE_MS).catch(
      () => null,
    );
    box.hidden = false;

    if (Notification.permission === 'denied') {
      // Nothing the page can do: only the browser's own site settings can undo it.
      if (label)
        label.textContent = 'Notifications are blocked for this site in your browser settings.';
      btn.hidden = true;
      return null;
    }

    btn.hidden = false;
    if (sub) {
      if (label) label.textContent = 'Notifications are on — before anything you follow is out.';
      btn.textContent = 'Turn off notifications';
      btn.className = 'ghost';
    } else {
      if (label) label.textContent = 'Get told before something you follow is out.';
      btn.textContent = 'Turn on notifications';
      btn.className = 'cta';
    }
    return sub;
  }

  let current = await paint();

  // Coming back to the tab -- from the browser's site settings, say -- re-reads the
  // real state, so the control is never a stale snapshot of an abandoned attempt.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || btn.disabled) return;
    current = await paint();
  });

  /** Hand the subscription to the server, and say so if it will not take it. */
  async function save(sub) {
    say(msg, 'Saving…', 'info');
    let res;
    try {
      res = await postJson('/api/push/subscribe', sub.toJSON(), { timeoutMs: SAVE_DEADLINE_MS });
    } catch (err) {
      console.warn('[push] save failed', err);
      await sub.unsubscribe().catch(() => {});
      say(msg, 'Could not reach the server. Try again in a moment.', 'error');
      return;
    }
    // A redirect means the session went away: fetch follows it and hands back a
    // perfectly fine 200 for the sign-in page, which used to read as success.
    if (res.redirected || !res.ok) {
      // Do not leave the browser subscribed to something the server never stored.
      await sub.unsubscribe().catch(() => {});
      say(
        msg,
        res.redirected
          ? 'You have been signed out. Sign in again and turn these on.'
          : 'Could not save that. Try again in a moment.',
        'error',
      );
      return;
    }
    say(msg, 'Notifications are on.', 'ok');
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (current) {
        say(msg, 'Turning off…', 'info');
        const { endpoint } = current;
        await current.unsubscribe();
        await postJson('/api/push/unsubscribe', { endpoint });
        say(msg, 'Notifications are off.', 'info');
        return;
      }

      if (Notification.permission === 'default') say(msg, 'Waiting for your browser…', 'info');
      let permission;
      try {
        permission = await withDeadline(askPermission(), PERMISSION_DEADLINE_MS);
      } catch (err) {
        if (!err?.timedOut) throw err;
        say(
          msg,
          'Your browser never answered. Allow notifications for this site from the icon in the address bar, then try again.',
          'error',
        );
        return;
      }
      if (permission !== 'granted') {
        say(
          msg,
          permission === 'denied'
            ? 'Your browser blocked notifications for this site.'
            : 'No answer from the browser prompt — nothing changed.',
          'error',
        );
        return;
      }

      say(msg, 'Setting up…', 'info');
      let sub;
      try {
        sub = await withDeadline(
          reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8Array(window.__VAPID),
          }),
          SUBSCRIBE_DEADLINE_MS,
        );
      } catch (err) {
        if (!err?.timedOut) throw err;
        console.warn('[push] subscribe did not finish within', SUBSCRIBE_DEADLINE_MS, 'ms');
        // It may still have completed after the deadline; take that if it did. Bounded
        // too, because a wedged push manager makes this read hang alongside subscribe.
        sub = await withDeadline(reg.pushManager.getSubscription(), READBACK_DEADLINE_MS).catch(
          () => null,
        );
        if (!sub) {
          say(
            msg,
            (await isBrave())
              ? 'Brave keeps push notifications off until you turn on “Use Google services for push messaging” in brave://settings/privacy and restart Brave. Email reminders still work meanwhile.'
              : 'Your browser never finished subscribing — its push service is unreachable. Some Chromium builds ship without one, and some networks block it. Email reminders still work.',
            'error',
          );
          return;
        }
      }
      await save(sub);
    } catch (err) {
      say(msg, `Could not change that: ${err?.message ?? err}`, 'error');
    } finally {
      btn.disabled = false;
      current = await paint();
    }
  });
}

/* -------------------------------------------------------------- passkeys -- */

async function initPasskeys() {
  const { startAuthentication, startRegistration } = window.SimpleWebAuthnBrowser ?? {};

  const signin = document.getElementById('passkey-signin');
  const signinMsg = document.getElementById('passkey-signin-msg');
  if (signin) {
    if (!window.PublicKeyCredential || !startAuthentication) {
      signin.hidden = true;
    } else {
      signin.addEventListener('click', async () => {
        signin.disabled = true;
        try {
          const options = await (await postJson('/api/auth/passkey/authenticate/options')).json();
          const asseResp = await startAuthentication({ optionsJSON: options });
          const res = await postJson('/api/auth/passkey/authenticate/verify', asseResp);
          if (res.ok) {
            location.href = '/following';
            return;
          }
          const body = await res.json().catch(() => ({}));
          say(signinMsg, body.error ?? 'That passkey was not recognised.', 'error');
        } catch (err) {
          if (err?.name !== 'NotAllowedError') {
            say(signinMsg, `Could not sign in with a passkey: ${err?.message ?? err}`, 'error');
          }
        } finally {
          signin.disabled = false;
        }
      });
    }
  }

  const add = document.getElementById('add-passkey');
  const addMsg = document.getElementById('add-passkey-msg');
  if (add) {
    if (!window.PublicKeyCredential || !startRegistration) {
      add.hidden = true;
      return;
    }
    add.addEventListener('click', async () => {
      add.disabled = true;
      say(addMsg, 'Follow your browser or password manager prompt…', 'info');
      try {
        const optRes = await postJson('/api/auth/passkey/register/options');
        if (!optRes.ok) {
          say(addMsg, 'Could not start registration. Try signing in again.', 'error');
          return;
        }
        const options = await optRes.json();
        const attResp = await startRegistration({ optionsJSON: options });

        const res = await postJson('/api/auth/passkey/register/verify', attResp);
        const body = await res.json().catch(() => ({}));

        if (res.ok && body.ok) {
          // Reload so the new key appears in the list -- and say so first, because
          // the previous version reloaded silently and looked like nothing happened.
          say(addMsg, 'Passkey added.', 'ok');
          setTimeout(() => location.reload(), 600);
          return;
        }
        // The real failure this replaces: the server rejected the credential and the
        // page did nothing at all, while the password manager had already saved it.
        say(addMsg, body.error ?? 'The server rejected that passkey. Nothing was saved.', 'error');
      } catch (err) {
        if (err?.name === 'NotAllowedError') say(addMsg, 'Cancelled.', 'info');
        else if (err?.name === 'InvalidStateError')
          say(addMsg, 'That device already has a passkey for this account.', 'info');
        else say(addMsg, `Could not add a passkey: ${err?.message ?? err}`, 'error');
      } finally {
        add.disabled = false;
      }
    });
  }
}

/* --------------------------------------------------------------- confirm -- */

/**
 * `data-confirm="..."` on a submit button: ask before the form goes.
 *
 * Only for the handful of controls that destroy something a person built up over
 * time -- clearing the whole follow list -- never for an ordinary toggle, where a
 * dialog is noise and the undo is one click away.
 *
 * It listens on submit rather than click so a keyboard Enter in the form is caught
 * too, and reads the message off the submitter, because the button is what carries
 * the consequence. With script off nothing asks and the form simply posts; that is
 * the same trade every other control here makes, and the page reports afterwards
 * exactly what was removed.
 */
function initConfirmForms() {
  document.addEventListener(
    'submit',
    (event) => {
      const button = event.submitter ?? event.target?.querySelector?.('[data-confirm]');
      const message = button?.getAttribute?.('data-confirm');
      if (!message) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        // Stop the follow-form handler from acting on a submit that the person
        // just declined.
        event.stopImmediatePropagation();
      }
    },
    true,
  );
}

/* ------------------------------------------------------------------ copy -- */

/**
 * Copy buttons: `data-copy="<selector>"` copies that field's value.
 *
 * The field is a real readonly input, so the URL is visible and selectable with no
 * script at all; this is only the shortcut. navigator.clipboard is absent outside a
 * secure context and can be refused outright, so the fallback leaves the text
 * selected -- one keystroke from copied rather than a dead button.
 */
function initCopyButtons() {
  // Clicking into the field selects the whole URL: nobody wants to drag-select a
  // token by hand, and a partial copy produces a calendar that never loads.
  document.addEventListener('focusin', (event) => {
    if (event.target?.closest?.('.copy-row')) event.target.select?.();
  });

  document.addEventListener('click', async (event) => {
    const btn = event.target?.closest?.('[data-copy]');
    if (!btn) return;
    const field = document.querySelector(btn.getAttribute('data-copy'));
    if (!field) return;

    const flash = (label) => {
      btn.dataset.idle = btn.dataset.idle ?? btn.textContent;
      btn.textContent = label;
      setTimeout(() => {
        btn.textContent = btn.dataset.idle;
      }, 1600);
    };

    field.focus?.();
    field.select?.();
    try {
      await navigator.clipboard.writeText(field.value ?? field.textContent);
      flash('Copied');
    } catch {
      flash('Press Ctrl-C');
    }
  });
}

/* ------------------------------------------------------------------ ajax -- */

/**
 * Follow / unfollow without a round trip.
 *
 * The markup stays a real <form> that posts and redirects, so the site works with
 * JavaScript off and for anything that does not run it. This intercepts the submit
 * and does the same request in the background, then flips the button in place.
 *
 * The button is updated optimistically and reverted if the request fails, because
 * the honest alternative -- a spinner on a 60ms request -- is slower to read than
 * the state change itself.
 */
function initFollowForms() {
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const action = form.getAttribute('action') ?? '';
    if (action !== '/api/follow' && action !== '/api/unfollow') return;

    event.preventDefault();
    const button = form.querySelector('button');
    const following = action === '/api/unfollow';
    const chip = form.closest('.chip');
    const label = button?.getAttribute('data-label') ?? '';
    const who = label ? ` ${label}` : '';

    form.setAttribute('data-pending', '');
    try {
      const res = await fetch(action, {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: new FormData(form),
      });
      if (!res.ok) throw new Error(String(res.status));

      // A chip only exists to be removed; everything else toggles.
      if (chip) {
        chip.remove();
        return;
      }
      form.setAttribute('action', following ? '/api/follow' : '/api/unfollow');
      if (button) {
        // The name belongs in both states, not just the unfollowed one: two of these
        // sit side by side on an event page and "Following" alone does not say who.
        button.textContent = following ? `☆ Follow${who}` : `★ Following${who}`;
        button.classList.toggle('following', !following);
        button.classList.toggle('cta', false);
        button.classList.toggle('ghost', true);
      }
    } catch {
      // Put it back rather than leaving a button claiming something untrue.
      if (button) button.textContent = following ? `★ Following${who}` : `☆ Follow${who}`;
    } finally {
      form.removeAttribute('data-pending');
    }
  });
}

/**
 * Same-origin navigation without a full document load.
 *
 * Fetches the next page, swaps <main> and the title, and pushes history. Anything
 * this cannot handle -- a modified click, a different origin, a download, a form
 * post -- is left to the browser, which is the correct behaviour rather than a
 * fallback.
 */
function initNavigation() {
  if (!window.history?.pushState) return;

  const main = () => document.querySelector('main');
  let token = 0;

  async function go(url, { push = true } = {}) {
    const mine = ++token;
    document.body.setAttribute('data-loading', '');
    try {
      const res = await fetch(url, { headers: { 'x-requested-with': 'navigation' } });
      if (!res.ok) throw new Error(String(res.status));
      const html = await res.text();
      // A newer click already started; discard this one rather than racing it onto
      // the page out of order.
      if (mine !== token) return;

      const doc = new DOMParser().parseFromString(html, 'text/html');
      const next = doc.querySelector('main');
      if (!next || !main()) {
        location.href = url;
        return;
      }
      // Before the swap: the player lives inside <main>, and removing its <video>
      // does not stop it -- it keeps pulling the stream and holding the one
      // connection the reader's line allows until the tab closes.
      window.__genreStopPlayer?.();
      main().replaceWith(next);
      document.title = doc.title;
      if (push) history.pushState({}, '', url);
      window.scrollTo(0, 0);
      localiseTimes();
      initPush();
      initPasskeys();
      // The swapped-in <main> carries its own channel list, which has had neither
      // the phone hand-off treatment nor a single check run against it.
      initOwnChannelActions();
      // initInlinePlayer starts the check sweep itself -- it has to own it, so
      // that pressing Play can abort a probe that would otherwise be a second
      // connection on a line that permits one.
      initInlinePlayer();
    } catch {
      location.href = url;
    } finally {
      if (mine === token) document.body.removeAttribute('data-loading');
    }
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    if (link.target || link.hasAttribute('download') || link.hasAttribute('data-no-ajax')) return;

    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    // The API and static assets are not pages; let the browser have them.
    if (url.pathname.startsWith('/api/') || /\.[a-z0-9]+$/i.test(url.pathname)) return;

    event.preventDefault();
    go(url.pathname + url.search);
  });

  window.addEventListener('popstate', () =>
    go(location.pathname + location.search, { push: false }),
  );
}

localiseTimes();
reportTimezone();
initOwnChannelActions();
initInlinePlayer();
initPush();
initPasskeys();
// Before initFollowForms: it must be able to cancel a submit that handler would
// otherwise have already sent.
initConfirmForms();
initFollowForms();
initCopyButtons();
initNavigation();

/* --------------------------------------------------- your own channels -- */

/**
 * Offer each device the hand-off that works on it, and only that one.
 *
 * There are two ways off this page and into a real player, and they are exact
 * opposites: a .m3u file, and a deep link into a player app. Neither works
 * everywhere, and the page ships both because the markup is identical for every
 * device -- so one of them is removed here, once it is known which device this is.
 *
 * The .m3u hand-off is right on a desktop, where the file opens in whatever player
 * is registered. On iOS it is a trap with two endings: Safari either offers to
 * download the playlist, or follows it to the stream and offers to download a .ts
 * instead. Neither plays. These providers serve MPEG-2 Transport Stream and Safari
 * has no demuxer for it, which is a missing codec rather than a missing hint -- no
 * header changes it.
 *
 * The deep links are the mirror image, and that was missed for a while. Both are
 * `x-callback-url` schemes, which VLC and Infuse register on iOS and Android and
 * which have no meaning on a desktop: the desktop app opens, is handed the whole
 * `vlc-x-callback://...` string as its MRL, and fails to open it. So the button
 * appeared to do something and then produced a player error, while the .m3u next to
 * it worked -- which is exactly what was reported.
 *
 * Done here rather than by sniffing the User-Agent server-side: the markup stays
 * the same for everyone, and a laptop with a touchscreen keeps the download it can
 * actually use.
 */
function initOwnChannelActions(root = document) {
  // Pointer, not screen width. A touchscreen laptop still has a filesystem and a
  // registered handler; a phone has neither.
  const phone = window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;

  for (const actions of root.querySelectorAll('.own-channel-actions')) {
    if (actions.dataset.mobile) continue;
    actions.dataset.mobile = '1';

    if (!phone) {
      /*
       * A desktop keeps the file and loses the deep links.
       *
       * Not rewritten to some desktop equivalent, because there is no reliable
       * one: `vlc://` is registered on some platforms and not others, and what it
       * does with a URL after the scheme differs between them. The .m3u beside
       * these opens VLC and plays, which is the thing the buttons were for.
       */
      for (const a of actions.querySelectorAll('a[href^="vlc-x-callback:"], a[href^="infuse:"]')) {
        a.remove();
      }
      continue;
    }

    for (const a of actions.querySelectorAll('a[href*="playlist.m3u"]')) a.remove();

    // A deep link to an app that is not installed does nothing at all: iOS ignores
    // an unregistered scheme silently, which reads exactly like a broken button.
    // Say where to get one, once per list rather than once per channel.
    const section = actions.closest('.own-line');
    if (section && !section.querySelector('.player-hint')) {
      const hint = document.createElement('p');
      hint.className = 'muted small player-hint';
      hint.textContent = 'These open in a player that can handle these streams. ';
      const link = document.createElement('a');
      link.href = 'https://www.videolan.org/vlc/download-ios.html';
      link.rel = 'noopener';
      link.textContent = 'Get VLC';
      hint.append(link, ' if nothing happens when you tap.');
      section.append(hint);
    }
  }
}

/* ------------------------------------------- checking before offering -- */

/**
 * Playing an entry in the page, for the screens that have nowhere else to play it.
 *
 * The VLC and Infuse buttons assume a device with apps on it. A Fire TV, an
 * Android TV box or a locked-down desktop has a browser and nothing else, and
 * "install VLC" is not an answer on a television. This is that answer.
 *
 * It is strictly an addition. The deep links stay exactly where they were, the
 * button ships disabled, and it is enabled only after the browser has been asked
 * whether it can do the job -- so the failure mode of every check below is the
 * page exactly as it was before this existed.
 */

/**
 * The two pieces of state this needs, on `window` rather than in module scope.
 *
 * Not a stylistic choice. This section sits below the block that calls
 * initInlinePlayer() at boot, and a `let` at the bottom of the file is in its
 * temporal dead zone when that call runs -- so the first reader with a channel
 * list would get a ReferenceError instead of a player. Function declarations
 * hoist and bindings do not, which is why every other late section here gets away
 * with holding no state at all. `window.__genrePlayer` is already the handoff
 * between the two files, so this stays beside it.
 *
 * `__genrePlayerLoading` is the in-flight bundle fetch: two presses must not
 * pull a quarter of a megabyte twice.
 *
 * `__genreStopPlayer` is how anything else stops playback, and the navigation
 * handler is what needs it: it replaces <main> wholesale, and a player whose
 * <video> has been removed from the document does not stop -- it keeps pulling
 * the stream, holding the one connection the reader's line allows, until the tab
 * closes. The symptom is the next channel refusing to start with "you are already
 * watching", on a page showing no player at all.
 */

function loadPlayerBundle(src) {
  if (window.__genrePlayer) return Promise.resolve(window.__genrePlayer);
  if (window.__genrePlayerLoading) return window.__genrePlayerLoading;
  window.__genrePlayerLoading = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () =>
      window.__genrePlayer ? resolve(window.__genrePlayer) : reject(new Error('no player'));
    el.onerror = () => {
      // Cleared, so a reader on a flaky connection can press again rather than
      // being left holding a promise that will never settle.
      window.__genrePlayerLoading = null;
      reject(new Error('could not load the player'));
    };
    document.head.append(el);
  });
  return window.__genrePlayerLoading;
}

/**
 * Can this browser transmux at all?
 *
 * Asked WITHOUT loading the bundle, which is the whole point of asking here: an
 * iPhone would otherwise download 270KB of demuxer to be told it cannot use it.
 * MediaSource with an H.264/AAC fragment is precisely what the library needs, so
 * a yes here and a yes from the library agree in practice -- and the library is
 * asked again anyway before anything is attached.
 */
function canTransmux() {
  try {
    return Boolean(
      window.MediaSource?.isTypeSupported?.('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
    );
  } catch {
    return false;
  }
}

/**
 * Ask the provider whether each listed entry is actually there.
 *
 * A provider playlist is mostly aspirational: the slot exists, the title matches
 * the fixture, and a large share of them answer with an HTML error page rather
 * than video. Offering those and letting the reader find out by pressing Play is
 * how "Your provider did not send a stream for that channel" became a routine
 * outcome of using the feature as intended -- the .m3u route has probed since it
 * was written, and the page had no way to.
 *
 * Sequential, one row at a time, and that is not a detail. These are one
 * subscriber's own connections on a line that usually permits exactly one, so
 * five checks at once is how an account gets flagged. A row clears the moment its
 * own answer arrives rather than when the slowest of five has timed out.
 *
 * Rows that fail are removed outright. Greying one out leaves the reader deciding
 * whether to try it anyway, and the answer is no.
 *
 * @param section  the .own-line section
 * @param onLive   called with each row that came back streaming
 * @param signal   aborts the sweep -- pressing Play must not leave a probe
 *                 competing with the stream it just started
 */
async function checkOwnChannels(section, onLive, signal) {
  const rows = [...section.querySelectorAll('li[data-check]')];
  if (rows.length === 0) return;

  // Already confirmed by the server, within the ten minutes a verdict is worth
  // trusting. Reopening a page must not re-probe a line that counts connections.
  for (const li of rows.filter((li) => li.dataset.verified)) onLive(li);

  const pending = rows.filter((li) => !li.dataset.verified);
  if (pending.length === 0) return;

  for (const li of pending) li.classList.add('checking');
  const say = (li, text) => {
    const slot = li.querySelector('.own-channel-state');
    if (slot) slot.textContent = text;
  };
  for (const li of pending) say(li, 'checking…');

  let dropped = 0;
  for (const li of pending) {
    if (signal?.aborted) {
      for (const rest of pending.slice(pending.indexOf(li))) {
        rest.classList.remove('checking');
        say(rest, '');
      }
      return;
    }

    let verdict;
    try {
      const res = await fetch(li.dataset.check, {
        headers: { accept: 'application/json' },
        signal,
      });
      verdict = await res.json();
    } catch {
      /*
       * An abort is not a verdict.
       *
       * The reader pressed Play, and this row is simply unchecked -- it must not
       * be enabled on the strength of a check that never finished, and it must
       * not be left saying "checking" with nothing checking it. The sweep is
       * restarted when playback stops, and the row gets its answer then.
       */
      if (signal?.aborted) {
        for (const rest of pending.slice(pending.indexOf(li))) {
          rest.classList.remove('checking');
          say(rest, '');
        }
        return;
      }

      // A genuine network failure here says nothing about the entry, so the row
      // is left usable rather than removed. Better an unchecked row than one
      // wrongly deleted because our own connection dropped.
      li.classList.remove('checking');
      say(li, '');
      onLive(li);
      continue;
    }

    /*
     * The line is busy: this account is watching something, here or in another
     * tab. The check cannot run without becoming a second connection on a line
     * that permits one, so it does not run.
     *
     * The remaining rows are left usable rather than disabled. Nothing has
     * vouched for them -- pressing one is exactly the gamble it was before any of
     * this -- but a row that can never be re-enabled from this tab is worse: the
     * sweep restarts when playback stops HERE, and a stream stopped in another
     * tab would never reach it.
     */
    if (verdict?.skipped) {
      for (const rest of pending.slice(pending.indexOf(li))) {
        rest.classList.remove('checking');
        say(rest, '');
        onLive(rest);
      }
      return;
    }

    li.classList.remove('checking');
    if (verdict?.live) {
      li.dataset.verified = '1';
      say(li, '');
      onLive(li);
      continue;
    }

    // Named, not silent. "returned a web page, not a stream" tells you the slot is
    // empty; "timed out" tells you it is not. The row goes, and the note goes with
    // it into the summary rather than being lost.
    dropped += 1;
    li.remove();
  }

  if (dropped === 0) return;

  // Every list that lost all its rows goes with them. There are three -- on demand,
  // the matches, and the genre channels -- and an emptied <ul> left behind is a
  // gap where a list used to be, under a heading that now names nothing.
  for (const ul of section.querySelectorAll('ul.channels')) {
    if (!ul.querySelector('li')) {
      // The heading and blurb above it describe a list that is no longer there.
      const label = ul.previousElementSibling;
      if (label?.matches?.('h3, p.muted')) label.remove();
      ul.remove();
    }
  }

  const left = section.querySelectorAll('li[data-check]').length;
  const note = document.createElement('p');
  note.className = 'muted small channels-dropped';
  note.textContent = left
    ? `${dropped} ${dropped === 1 ? 'entry is' : 'entries are'} not there right now, so ${dropped === 1 ? 'it was' : 'they were'} removed.`
    : 'None of your matching entries are there right now. Your provider lists them, but the slots are empty.';
  section.querySelector('.channels-dropped')?.remove();
  section.appendChild(note);
}

/**
 * There can be two player sections on a page now, not one.
 *
 * The reader's own list and the shared lists are separate sections because they
 * are separate claims with different controls -- and querySelector took the first
 * and left the second inert, which showed up as a shared entry whose Play button
 * never enabled. Each section gets its own player state: its own sweep, its own
 * generation counter, its own teardown.
 *
 * Stopping is still global. `__genreStopPlayer` chains, so a press in one section
 * tears down the other -- the reader's line, or the owner's, permits one
 * connection and two <video> elements pulling at once is the thing the whole
 * ceiling exists to prevent.
 */
function initInlinePlayer(root = document) {
  const sections = [...root.querySelectorAll('.own-line[data-player-src]')].filter(
    (el) => !el.dataset.player,
  );
  if (sections.length === 0) return;

  /*
   * The chain starts empty for each fresh set of sections.
   *
   * A client-side navigation replaces <main> wholesale and then calls this again,
   * so without the reset the chain would accumulate a teardown per section per
   * navigation -- each holding a reference to a section long since removed from
   * the document. The navigation handler has already run the old chain before the
   * swap, so there is nothing live left to lose.
   */
  window.__genreStopPlayer = null;
  for (const section of sections) initPlayerSection(section);
}

function initPlayerSection(section) {
  if (!section || section.dataset.player) return;
  section.dataset.player = '1';

  const buttons = [...section.querySelectorAll('button[data-play]')];

  /*
   * The sweep aborts when a stream starts.
   *
   * A probe is a connection like any other, and the line permits one. Pressing
   * Play while the sweep is still walking the list would put a background check
   * alongside the reader's own film -- which, now that a new claim evicts the
   * old, is not merely rude but would take their film off them.
   */
  let sweep = new AbortController();

  /*
   * A browser that cannot play these loses the button rather than keeping a dead
   * one.
   *
   * iPhone Safari is the case: no Media Source Extensions, so there is nothing to
   * push fragments into, and no header or container that changes it. It already
   * has the right answer on the page -- VLC, which demuxes TS natively -- and a
   * "Play here" that silently failed would pull people away from the button that
   * works.
   *
   * The check sweep still runs there. VLC and .m3u are handed the same channels,
   * and a dead slot is just as dead in VLC.
   */
  if (!canTransmux() || buttons.length === 0) {
    for (const b of buttons) b.remove();
    checkOwnChannels(section, () => {}, sweep.signal);
    return;
  }

  const src = section.dataset.playerSrc;
  let stop = null;
  let stage = null;

  /*
   * Which press is the live one.
   *
   * Starting a player is not instant -- the bundle has to arrive on the first
   * press -- and a second press during that wait used to run the whole handler a
   * second time. Both then reached `stop = player.attach(...)`, the later one
   * overwrote the earlier handle, and the earlier player kept running with
   * nothing left that could destroy it: two <video> elements, two connections on
   * a line that permits one, and a stray one that only a reload could stop.
   *
   * A press that is no longer the newest abandons itself rather than racing.
   */
  let generation = 0;

  /** One at a time, because the reader's line allows one. */
  const teardown = () => {
    if (stop) stop();
    stop = null;
    stage?.remove();
    stage = null;
  };
  // Chained, not assigned. With two sections the second would otherwise replace
  // the first's handle, and a navigation would tear down one player while the
  // other kept pulling the stream.
  const previousStop = window.__genreStopPlayer;
  window.__genreStopPlayer = () => {
    previousStop?.();
    teardown();
  };

  const fail = (message) => {
    teardown();
    for (const b of buttons) {
      b.dataset.playing = '';
      b.textContent = 'Play here';
      // Only rows the provider has confirmed. Re-enabling everything after an
      // error would quietly undo the check and put the unverified ones back.
      b.disabled = !b.closest('li')?.dataset.verified;
    }
    section.querySelector('.player-error')?.remove();
    const p = document.createElement('p');
    p.className = 'feedback error player-error';
    p.textContent = message;
    section.prepend(p);
    // Nothing is playing after a failure, so the line is free and the rows the
    // sweep abandoned when Play was pressed can be finished off.
    startSweep();
  };

  /*
   * Something is being worked through, and the reader should not have to guess.
   *
   * Distinct from fail() in the two ways that matter: nothing is torn down, and
   * the buttons keep saying Stop, because the channel they pressed is still the
   * channel they are going to get. The player calls this while it rebuilds itself
   * around a stream that changed shape or a connection that dropped -- roughly ten
   * seconds during which a frozen picture with no message reads as a dead page.
   *
   * Same element and same class as fail() on purpose, so a notice and an error can
   * never stack up two paragraphs deep; whichever came last is the true one.
   */
  const notice = (message) => {
    section.querySelector('.player-error')?.remove();
    if (!message) return;
    const p = document.createElement('p');
    p.className = 'feedback player-error';
    p.textContent = message;
    section.prepend(p);
  };

  /*
   * Play is offered per row, once that row's channel has answered.
   *
   * The button ships disabled from the server for a different reason -- this
   * browser might have no Media Source Extensions -- and now stays disabled for a
   * second one: nothing has established that the provider is actually sending
   * this channel. Both are answered before it lights up, so a button that can be
   * pressed is one that works.
   */
  const enableRow = (li) => {
    const button = li.querySelector('button[data-play]');
    if (button) button.disabled = false;
  };

  /*
   * Restartable, because the sweep is abandoned every time playback starts.
   *
   * Without this, a reader who presses Play while the list is still being checked
   * leaves every unchecked row disabled for the life of the page -- the buttons
   * would never be handed their answer, and stopping the stream would not bring
   * them back.
   */
  const startSweep = () => {
    sweep = new AbortController();
    checkOwnChannels(section, enableRow, sweep.signal);
  };
  startSweep();

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      // Whatever is left of the sweep stops here: the line permits one connection
      // and the reader has just said what they want it used for.
      sweep.abort();
      section.querySelector('.player-error')?.remove();

      // Pressing the channel that is already playing stops it. Without this the
      // only way to release the connection is to leave the page.
      if (button.dataset.playing) {
        generation += 1;
        button.dataset.playing = '';
        button.textContent = 'Play here';
        teardown();
        // The line is free again, so anything the sweep never reached can be
        // checked now.
        startSweep();
        return;
      }

      generation += 1;
      const mine = generation;

      // The old channel goes before the new one is asked for: its <video> comes
      // out of the page and its connection is dropped here rather than being left
      // for the server to evict, which it now would.
      teardown();
      for (const b of buttons) {
        b.dataset.playing = '';
        b.textContent = 'Play here';
      }

      button.disabled = true;
      button.textContent = 'Starting…';

      let player;
      try {
        player = await loadPlayerBundle(src);
      } catch {
        button.disabled = false;
        button.textContent = 'Play here';
        fail('The player could not be loaded. Try VLC, or reload the page.');
        return;
      }

      // Somebody pressed a different channel while the bundle was arriving. That
      // press owns the player now; this one puts its own button back and leaves.
      if (mine !== generation) {
        button.disabled = false;
        button.textContent = 'Play here';
        return;
      }

      button.disabled = false;

      if (!player.supported()) {
        for (const b of buttons) b.remove();
        fail('This browser cannot play these streams. Open the channel in VLC instead.');
        return;
      }

      stage = document.createElement('div');
      stage.className = 'player-stage';
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      // Muted, and not as a preference. Every browser refuses to autoplay audible
      // video without a gesture, and the refusal arrives as a rejected play() that
      // leaves a black rectangle -- which reads as a broken stream rather than a
      // blocked one. The reader unmutes with the control.
      video.muted = true;
      stage.append(video);
      button.closest('li')?.after(stage);

      stop = player.attach(video, button.dataset.play, fail, notice);
      button.dataset.playing = '1';
      button.textContent = 'Stop';
    });
  }

  // Leaving the page must drop the provider connection rather than wait for a
  // socket to time out. pagehide rather than unload: it is the one that fires on
  // iOS and on a back/forward navigation.
  window.addEventListener('pagehide', teardown);
}
