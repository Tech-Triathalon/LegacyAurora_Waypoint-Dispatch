// Waypoint driver offline shell: caches the five app pages + fonts so the driver
// console still loads with zero signal. Network-first for API, cache-first shell.
const CACHE = 'waypoint-shell-v1';
const SHELL = ['/', '/index.html', '/dispatcher.html', '/driver.html', '/loader.html', '/store.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // let fonts/CDN pass through

  if (url.pathname.startsWith('/api/')) {
    // Network-first for API; fail fast when offline (outbox handles the queue).
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Cache-first for the app shell.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('/driver.html')))
  );
});
