// WaypointDispatch PWA service worker.
//
// Strategy map:
//   • App shell (pages, JS, CSS, icons, manifest) — precache at install,
//     serve cache-first with background refresh (stale-while-revalidate).
//   • GET /api/*  — network-first with cache fallback: fresh when online,
//     last-known snapshot when offline (portals render + banner "offline data").
//   • Non-GET /api/* — never cached; failures surface to the offline queue,
//     which replays them via the Background Sync API (plus online/interval
//     fallbacks) until the server accepts them.
//   • /api/stream (SSE) is bypassed entirely — the SDK owns reconnection.
const VERSION = 'waypoint-pwa-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;
const METADATA_URL = '/api/client-manifest';

// Everything a portal needs to boot and render with zero network.
const PRECACHE = [
  '/', '/index.html', '/hub.html',
  '/dispatcher.html', '/driver.html', '/loader.html', '/store.html',
  '/manifest.webmanifest',
  '/waypoint.js', '/outbox.js', '/offline.js', '/pwa.js',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch { /* optional */ }
    }
    await self.clients.claim();
  })());
});

// Ask all open clients for the hashed JS list (via /api/client-manifest) and
// precache any bundle files we do not have yet. Fetches use cache:'reload' so
// the shell cache never serves stale JS into itself.
async function precacheBundles() {
  const cache = await caches.open(SHELL_CACHE);
  let urls = [];
  try {
    const res = await fetch(METADATA_URL, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      urls = Object.keys((data && data.etags) || {});
    }
  } catch { /* offline: nothing new to learn */ }
  const missing = [];
  for (const url of urls) {
    if (/^\/(waypoint|outbox|offline|pwa)\.js$/.test(url)) continue; // always-precached SDK files
    const hit = await cache.match(url);
    if (!hit) missing.push(url);
  }
  await Promise.allSettled(missing.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'refresh-bundles') {
    event.waitUntil(precacheBundles());
  }
  if (event.data && event.data.type === 'ping' && event.source) {
    event.source.postMessage({ type: 'pong', version: VERSION });
  }
});

// ---- fetch strategies ----
function isApiGet(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/api/');
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || offlineFallback(request);
}

async function networkFirstApi(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && request.method === 'GET') cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-Waypoint-Offline', '1');
      return new Response(await cached.clone().arrayBuffer(), { status: cached.status, statusText: cached.statusText, headers });
    }
    return new Response(JSON.stringify({ error: 'offline', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'X-Waypoint-Offline': '1' },
    });
  }
}

function offlineFallback(request) {
  if (request.mode === 'navigate') {
    return caches.match('/index.html').then((hit) => hit || new Response('Offline', { status: 503 }));
  }
  return new Response('offline', { status: 503 });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // mutations: the offline queue owns them
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // CDNs pass through

  // SSE must never be intercepted — EventSource owns reconnection semantics.
  if (url.pathname.startsWith('/api/stream')) return;

  if (isApiGet(url)) {
    event.respondWith(networkFirstApi(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

// ---- Background Sync: replay the offline queue when connectivity returns ----
self.addEventListener('sync', (event) => {
  if (event.tag === 'waypoint-sync') {
    event.waitUntil((async () => {
      const clientList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const client of clientList) {
        client.postMessage({ type: 'sync-requested' });
      }
      // If no client answers (all tabs closed), the next opened tab replays on boot.
    })());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'waypoint-refresh') {
    event.waitUntil((async () => {
      await precacheBundles();
      const clientList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const client of clientList) client.postMessage({ type: 'sync-requested' });
    })());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const client of list) if ('focus' in client) return client.focus();
    return self.clients.openWindow('/hub.html');
  }));
});
