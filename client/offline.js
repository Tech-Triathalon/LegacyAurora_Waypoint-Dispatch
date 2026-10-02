// Waypoint offline core — the cross-role offline + sync engine.
//
// Reads  : `WaypointOffline.snapshot(url)` — cached last-known GET response,
//          transparently hydrated by the service worker when the network dies.
// Writes : every mutating call goes through `WaypointOffline.mutate()`:
//            online  → sent immediately (with `clientRef` idempotency key);
//            offline → persisted to localStorage and replayed, in order, when
//            connectivity returns (online event · SW background sync · interval).
//
// Replay-safety: each queued mutation carries a clientRef; the server records
// the first response for 24h and replays it on retry, so a sync that died
// mid-flight never double-applies (deliveries, receipts, flags, orders).
//
// Driver page keeps using WaypointOutbox (event-batch contract with per-event
// dedupe) — this module handles dispatcher / loader / store-manager mutations.
(function () {
  const QUEUE_KEY = 'waypoint_mutation_queue_v1';
  const MAX_QUEUE = 500;
  const listeners = { change: [], flushed: [], state: [] };

  let online = navigator.onLine;
  let flushing = false;

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; }
  }
  function writeQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* storage full */ }
    listeners.change.forEach((fn) => { try { fn(q.length); } catch {} });
  }

  function uuid() {
    return (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'ref-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function setState(patch) {
    online = patch.online !== undefined ? patch.online : online;
    const snap = { online, queued: readQueue().length, flushing };
    listeners.state.forEach((fn) => { try { fn(snap); } catch {} });
  }

  // ---------- snapshots (read-side offline) ----------
  // The SW already serves cached GETs with X-Waypoint-Offline: 1 — this just
  // exposes the flag to portals so they can badge "last known" data.
  function lastResponseWasOffline(res) {
    return !!(res && res.headers && res.headers.get && res.headers.get('x-waypoint-offline'));
  }

  // ---------- mutation queue (write-side offline) ----------
  function enqueueMutation({ url, method = 'POST', body, label }) {
    const q = readQueue();
    const record = {
      id: uuid(),
      clientRef: uuid(), // server idempotency key
      url,
      method,
      body: body || {},
      label: label || url,
      queuedAt: new Date().toISOString(),
      attempts: 0,
    };
    q.push(record);
    while (q.length > MAX_QUEUE) q.shift(); // bound storage; oldest mutations drop first
    writeQueue(q);
    flush(); // opportunistic: if actually online, this fires right away
    return record;
  }

  function replayBody(record) {
    // server idempotency middleware keys on body.clientRef
    return JSON.stringify({ ...(record.body || {}), clientRef: record.clientRef });
  }

  async function flushOnce() {
    const q = readQueue();
    if (q.length === 0) return { sent: 0, results: [] };
    const results = [];
    let sent = 0;
    let blocked = false; // 4xx that will never succeed on retry → stop flushing it
    const remaining = [];
    for (const record of q) {
      if (blocked) { remaining.push(record); continue; }
      try {
        const res = await fetch(record.url, {
          method: record.method || 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: replayBody(record),
          credentials: 'same-origin',
        });
        if (res.status === 401) {
          blocked = true; // session expired: keep queue, stop hammering, banner asks re-login
          remaining.push(record);
          continue;
        }
        if (res.status >= 400 && res.status < 500) {
          // Permanent rejection (validation, role, gone) — drop from queue, surface in drawer.
          const data = await res.json().catch(() => ({}));
          results.push({ id: record.id, label: record.label, status: 'rejected', detail: data.error || `HTTP ${res.status}` });
          sent += 1;
          continue;
        }
        if (res.status >= 500) {
          record.attempts = (record.attempts || 0) + 1;
          if (record.attempts > 20) {
            results.push({ id: record.id, label: record.label, status: 'rejected', detail: 'server unavailable after 20 attempts' });
          } else {
            remaining.push(record);
          }
          continue;
        }
        const data = await res.json().catch(() => ({}));
        results.push({ id: record.id, label: record.label, status: 'accepted', data });
        sent += 1;
      } catch {
        record.attempts = (record.attempts || 0) + 1;
        remaining.push(record); // offline / network error — retry next flush
      }
    }
    writeQueue(remaining);
    if (results.length) {
      const lastSync = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      try { localStorage.setItem('waypoint_last_sync', lastSync); } catch {}
      listeners.flushed.forEach((fn) => { try { fn(results, lastSync); } catch {} });
    }
    return { sent, results, blocked };
  }

  async function flush() {
    if (flushing || !navigator.onLine) return { sent: 0, results: [] };
    flushing = true;
    setState({});
    try {
      return await flushOnce();
    } finally {
      flushing = false;
      setState({});
    }
  }

  // ---------- connectivity plumbing ----------
  window.addEventListener('online', () => { setState({ online: true }); flush(); });
  window.addEventListener('offline', () => { setState({ online: false }); });

  // Service worker background-sync wake-up: the SW can't touch localStorage,
  // so it pings live clients and whoever receives it flushes the queue.
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'sync-requested') flush();
    });
  }

  // Belt-and-braces periodic sweep (tab left open across connectivity changes).
  setInterval(() => { if (navigator.onLine) flush(); }, 30000);

  // Register the SW + request the background-sync permission-less hook.
  async function init() {
    if (!navigator.serviceWorker) return null;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      // Ask the SW to top up hashed JS bundles in the background.
      if (reg.active) reg.active.postMessage({ type: 'refresh-bundles' });
      navigator.serviceWorker.ready.then((r) => {
        if (r.sync) {
          // Queue a sync tag: fires 'sync' when the browser regains connectivity.
          r.sync.register('waypoint-sync').catch(() => {});
        }
      }).catch(() => {});
      return reg;
    } catch {
      return null;
    }
  }

  window.WaypointOffline = {
    init,
    mutate: enqueueMutation,
    flush,
    count: () => readQueue().length,
    queue: readQueue,
    isOnline: () => navigator.onLine,
    lastResponseWasOffline,
    onChange: (fn) => listeners.change.push(fn),
    onFlushed: (fn) => listeners.flushed.push(fn),
    onState: (fn) => { listeners.state.push(fn); fn({ online, queued: readQueue().length, flushing }); },
  };
})();
