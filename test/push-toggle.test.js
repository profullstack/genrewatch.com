import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

/**
 * The notification toggle, driven through the states that used to hang it.
 *
 * public/app.js is a plain script that runs its own init calls at the bottom, so it
 * is evaluated here inside a function scope with the handful of browser globals it
 * touches replaced by stubs. Nothing is monkey-patched onto this process.
 *
 * The bug being guarded: the button said "Waiting for your browser…" forever after
 * the permission had actually been allowed. Both awaits it sat on could stay pending
 * indefinitely, and neither had any way out.
 */

const APP_JS = new URL('../apps/web/public/app.js', import.meta.url).pathname;

/**
 * The push client app.js imports from /vendor-notifications.js in a browser. Here it
 * is the same file, resolved through the web app's dependencies the way the route
 * that serves it resolves it.
 */
const CLIENT = Bun.resolveSync(
  '@profullstack/notifications/client',
  new URL('../apps/web/', import.meta.url).pathname,
);

/** A real VAPID public key shape: 65 bytes, base64url. */
const VAPID =
  'BDU8swQU1kEMnNVJE94M3RF4XG9iSi-F1rbVR3H_KA4Krsmpzw39O9oJT_UwPt04QnzqvQAiARZr3M8ZaVZcgzc';

const el = () => ({
  hidden: true,
  disabled: false,
  textContent: '',
  className: '',
  listeners: {},
  addEventListener(type, fn) {
    this.listeners[type] = this.listeners[type] ?? [];
    this.listeners[type].push(fn);
  },
  click() {
    return Promise.all((this.listeners.click ?? []).map((fn) => fn()));
  },
});

/**
 * Load app.js with stubbed globals and return the pieces a test drives.
 *
 * The deadlines are shortened by rewriting the two named constants, because a test
 * that genuinely waits 20 seconds for the subscribe timeout is a test nobody runs.
 */
async function loadApp({ notification, pushManager, fetchImpl, brave = false, key = VAPID }) {
  // The client caches the key per page; every test here is a fresh page.
  (await import(CLIENT)).clearKeyCache();
  let src = await readFile(APP_JS, 'utf8');
  src = src
    .replace('const PERMISSION_DEADLINE_MS = 90_000;', 'const PERMISSION_DEADLINE_MS = 600;')
    .replace('const SUBSCRIBE_DEADLINE_MS = 20_000;', 'const SUBSCRIBE_DEADLINE_MS = 300;')
    .replace('const READBACK_DEADLINE_MS = 3_000;', 'const READBACK_DEADLINE_MS = 100;')
    .replace('const SAVE_DEADLINE_MS = 15_000;', 'const SAVE_DEADLINE_MS = 300;')
    .replace('const PERMISSION_POLL_MS = 400;', 'const PERMISSION_POLL_MS = 25;')
    .replace("import('/vendor-notifications.js')", `import(${JSON.stringify(CLIENT)})`);

  const box = el();
  const btn = el();
  const label = el();
  const msg = el();
  const nodes = {
    'push-optin': box,
    'enable-push': btn,
    'push-state': label,
    'push-msg': msg,
  };

  const document = {
    body: { dataset: {} },
    listeners: {},
    getElementById: (id) => nodes[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] ?? [];
      this.listeners[type].push(fn);
    },
  };

  const registration = { pushManager };
  const navigator = {
    // Brave, and only Brave, exposes this.
    brave: brave ? { isBrave: async () => true } : undefined,
    serviceWorker: {
      register: async () => registration,
      getRegistration: async () => registration,
      ready: Promise.resolve(registration),
    },
  };

  // The server's key endpoint, answered here so every test's fetch only sees the
  // calls it is about.
  const fetchAll = async (url, init) =>
    url === '/api/push/vapid-public-key'
      ? {
          ok: Boolean(key),
          status: key ? 200 : 503,
          text: async () => JSON.stringify({ publicKey: key }),
        }
      : fetchImpl(url, init);

  // The push client reads support off `window`: PushManager, Notification and a
  // navigator with a service worker are what it checks.
  const window = {
    isSecureContext: true,
    PushManager: function PushManager() {},
    Notification: notification,
    navigator,
    fetch: fetchAll,
  };
  const location = { href: 'https://genrewatch.com/following', origin: 'https://genrewatch.com' };

  const run = new Function(
    'window',
    'document',
    'navigator',
    'Notification',
    'fetch',
    'location',
    'console',
    src,
  );
  run(window, document, navigator, notification, fetchAll, location, {
    warn() {},
    error() {},
  });

  return { box, btn, label, msg, document };
}

/** Poll until a condition holds, so tests wait on the app rather than on a clock. */
async function until(predicate, ms = 2000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

const okJson = () => ({
  ok: true,
  redirected: false,
  status: 200,
  json: async () => ({ ok: true }),
});

describe('notification toggle', () => {
  test('says the server has no key instead of offering a button that cannot work', async () => {
    // The pairux.com failure: a key missing in production read as "this browser
    // does not support notifications". The key is asked for at runtime now, and a
    // server without one says so.
    const notification = { permission: 'default', requestPermission: async () => 'granted' };
    const { box, btn, label } = await loadApp({
      notification,
      key: null,
      pushManager: { getSubscription: async () => null, subscribe: async () => null },
      fetchImpl: async () => okJson(),
    });

    await until(() => !box.hidden);
    expect(btn.hidden).toBe(true);
    expect(label.textContent).toContain('not set up on this server');
    expect(label.textContent).not.toContain('browser');
  });

  test('finishes when the permission is allowed outside the page prompt', async () => {
    // Chrome shows the prompt quietly and lets the choice be made in site settings.
    // requestPermission() then never settles -- this is the reported hang.
    const notification = {
      permission: 'default',
      requestPermission: () => new Promise(() => {}),
    };

    let subscribed = false;
    const subscription = {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: async () => true,
    };
    const posted = [];
    const { btn, msg } = await loadApp({
      notification,
      pushManager: {
        getSubscription: async () => (subscribed ? subscription : null),
        subscribe: async () => {
          subscribed = true;
          return subscription;
        },
      },
      fetchImpl: async (url, init) => {
        posted.push([url, JSON.parse(init.body)]);
        return okJson();
      },
    });

    await until(() => btn.textContent === 'Turn on notifications');
    const clicked = btn.click();

    expect(msg.textContent).toBe('Waiting for your browser…');

    // The answer arrives in the browser, not in the promise the page is holding.
    notification.permission = 'granted';

    await clicked;
    expect(msg.textContent).toBe('Notifications are on.');
    expect(msg.className).toBe('feedback ok');
    expect(posted[0][0]).toBe('/api/push/subscribe');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Turn off notifications');
  });

  test('says so when the browser cannot reach its push service', async () => {
    const notification = { permission: 'granted', requestPermission: async () => 'granted' };

    const { btn, msg } = await loadApp({
      notification,
      pushManager: {
        getSubscription: async () => null,
        // Chrome leaves this pending forever when it has no push connection.
        subscribe: () => new Promise(() => {}),
      },
      fetchImpl: async () => okJson(),
    });

    await until(() => btn.textContent === 'Turn on notifications');
    await btn.click();

    expect(msg.className).toBe('feedback error');
    expect(msg.textContent).toContain('never finished subscribing');
    expect(btn.disabled).toBe(false);
  });

  test('names the Brave setting when Brave is the browser', async () => {
    // Brave keeps Google's push service off by default, and subscribe() then never
    // settles. Saying "unreachable" is true but leaves nothing to act on.
    const notification = { permission: 'granted', requestPermission: async () => 'granted' };

    const { btn, msg } = await loadApp({
      notification,
      brave: true,
      pushManager: {
        getSubscription: async () => null,
        subscribe: () => new Promise(() => {}),
      },
      fetchImpl: async () => okJson(),
    });

    await until(() => btn.textContent === 'Turn on notifications');
    await btn.click();

    expect(msg.className).toBe('feedback error');
    expect(msg.textContent).toContain('brave://settings/privacy');
    expect(btn.disabled).toBe(false);
  });

  test('does not claim success when the save never lands', async () => {
    // The POST is bounded too: an aborted or failed save used to be the one await
    // left that could sit on a message with no ceiling.
    const notification = { permission: 'granted', requestPermission: async () => 'granted' };
    let dropped = false;
    let subscribed = false;
    const subscription = {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: async () => {
        dropped = true;
        subscribed = false;
        return true;
      },
    };

    const { btn, msg } = await loadApp({
      notification,
      pushManager: {
        // The client drops a subscription by reading it back from the push manager.
        getSubscription: async () => (subscribed ? subscription : null),
        subscribe: async () => {
          subscribed = true;
          return subscription;
        },
      },
      fetchImpl: async () => {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      },
    });

    await until(() => btn.textContent === 'Turn on notifications');
    await btn.click();

    expect(msg.className).toBe('feedback error');
    expect(msg.textContent).toContain('Could not reach the server');
    expect(dropped).toBe(true);
    expect(btn.disabled).toBe(false);
  });

  test('reports a lost session instead of claiming success', async () => {
    // A signed-out POST is redirected to the sign-in page, and fetch follows it: the
    // 200 that comes back used to read as a saved subscription.
    const notification = { permission: 'granted', requestPermission: async () => 'granted' };
    let dropped = false;
    let subscribed = false;
    const subscription = {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: async () => {
        dropped = true;
        subscribed = false;
        return true;
      },
    };

    const { btn, msg } = await loadApp({
      notification,
      pushManager: {
        // The client drops a subscription by reading it back from the push manager.
        getSubscription: async () => (subscribed ? subscription : null),
        subscribe: async () => {
          subscribed = true;
          return subscription;
        },
      },
      fetchImpl: async () => ({
        ok: true,
        redirected: true,
        status: 200,
        json: async () => ({}),
      }),
    });

    await until(() => btn.textContent === 'Turn on notifications');
    await btn.click();

    expect(msg.className).toBe('feedback error');
    expect(msg.textContent).toContain('signed out');
    expect(dropped).toBe(true);
    expect(btn.disabled).toBe(false);
  });
});
