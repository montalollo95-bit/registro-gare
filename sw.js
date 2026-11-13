// Notifiche dell'app AICS: mostra le notifiche ricevute e apre l'app quando le tocchi.
// Non salva niente in memoria, così gli aggiornamenti dell'app arrivano sempre subito.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (_) { p = {data: {body: e.data ? e.data.text() : ''}}; }
  const d = p.data || {}, n = p.notification || {};
  e.waitUntil(self.registration.showNotification(d.title || n.title || 'AICS', {
    body: d.body || n.body || '',
    icon: 'icon-aics.png',
    badge: 'icon-aics.png',
    tag: d.tag || undefined,
    data: {url: d.url || './'}
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        return c.focus().then(w => (w && 'navigate' in w) ? w.navigate(url) : w).catch(() => c);
      }
    }
    return self.clients.openWindow(url);
  }));
});
