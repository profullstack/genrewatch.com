/* Service worker. Its only job is notifications -- the site is server-rendered and
   works fine without it, so nothing here caches HTML and no stale page can be pinned. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-48x48.png',
      // Same tag for both reminders on one game, so the 1-minute alert replaces the
      // 1-hour one instead of stacking two notifications about the same match.
      tag: payload.tag,
      renotify: true,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/following';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an open tab rather than piling up new ones every time a game starts.
      for (const c of clients) if (c.url.includes(url) && 'focus' in c) return c.focus();
      return self.clients.openWindow(url);
    }),
  );
});
