// Waypoint offline outbox (driver page contract).
// Every driver action: enqueue first → optimistic render → flush to /api/events/batch
// when online. Replayed syncs are deduped server-side by eventId (unique constraint).
// Sync drawer contract: per-event status accepted | duplicate | conflict.
(function () {
  const KEY = 'waypoint_outbox_v1';
  const listeners = { change: [], flushed: [] };

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
  }
  function write(events) {
    localStorage.setItem(KEY, JSON.stringify(events));
    listeners.change.forEach((fn) => fn(events.length));
  }

  function uuid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'evt-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  // enqueue({type:'pod', orderId:12, payload:{...}}) → eventId
  function enqueue(evt) {
    const events = read();
    const record = {
      eventId: uuid(),
      type: evt.type,
      orderId: evt.orderId || null,
      vehicleId: evt.vehicleId || null,
      payload: evt.payload || {},
      clientTimestamp: new Date().toISOString(),
    };
    events.push(record);
    write(events);
    flush(); // opportunistic — no-op when offline
    return record.eventId;
  }

  async function flush() {
    if (!navigator.onLine) return;
    const events = read();
    if (events.length === 0) return;
    try {
      const res = await fetch('/api/events/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error('batch rejected');
      const { results } = await res.json();
      const acceptedIds = new Set(results.filter((r) => r.status !== 'conflict').map((r) => r.eventId));
      // Drop accepted/duplicated events; keep conflicts for the drawer.
      write(events.filter((e) => !acceptedIds.has(e.eventId)));
      const lastSync = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      localStorage.setItem('waypoint_last_sync', lastSync);
      listeners.flushed.forEach((fn) => fn(results, lastSync));
    } catch {
      // Still offline / server unreachable — queue persists, banner stays.
    }
  }

  window.addEventListener('online', flush);
  document.addEventListener('DOMContentLoaded', flush);

  window.WaypointOutbox = {
    enqueue,
    flush,
    count: () => read().length,
    all: read,
    onChange: (fn) => listeners.change.push(fn),
    onFlushed: (fn) => listeners.flushed.push(fn),
  };
})();
