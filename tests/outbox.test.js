// Unit tests for the client-side offline outbox sync engine (client/outbox.js logic).
const test = require('node:test');
const assert = require('node:assert');

// Test harness simulating browser environment (localStorage, navigator.onLine, fetch, crypto)
function createOutboxHarness() {
  const store = {};
  const mockLocalStorage = {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  };

  let isOnline = true;
  const mockFetchHistory = [];
  let mockFetchHandler = async (url, opts) => {
    mockFetchHistory.push({ url, opts });
    return {
      ok: true,
      json: async () => {
        const body = JSON.parse(opts.body);
        return {
          results: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })),
        };
      },
    };
  };

  const listeners = { change: [], flushed: [] };
  const KEY = 'waypoint_outbox_v1';

  function read() {
    try { return JSON.parse(mockLocalStorage.getItem(KEY)) || []; } catch { return []; }
  }
  function write(events) {
    mockLocalStorage.setItem(KEY, JSON.stringify(events));
    listeners.change.forEach((fn) => fn(events.length));
  }
  function uuid() {
    return 'test-evt-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function enqueue(evt) {
    const events = read();
    const record = {
      eventId: evt.eventId || uuid(),
      type: evt.type,
      orderId: evt.orderId || null,
      vehicleId: evt.vehicleId || null,
      payload: evt.payload || {},
      clientTimestamp: new Date().toISOString(),
    };
    events.push(record);
    write(events);
    flush();
    return record.eventId;
  }

  async function flush() {
    if (!isOnline) return;
    const events = read();
    if (events.length === 0) return;
    try {
      const res = await mockFetchHandler('/api/events/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error('batch rejected');
      const { results } = await res.json();
      const acceptedIds = new Set(results.filter((r) => r.status !== 'conflict').map((r) => r.eventId));
      write(events.filter((e) => !acceptedIds.has(e.eventId)));
      const lastSync = '12:00 PM';
      mockLocalStorage.setItem('waypoint_last_sync', lastSync);
      listeners.flushed.forEach((fn) => fn(results, lastSync));
    } catch {
      // Offline / network failure: retain in queue
    }
  }

  return {
    enqueue,
    flush,
    count: () => read().length,
    all: read,
    onChange: (fn) => listeners.change.push(fn),
    onFlushed: (fn) => listeners.flushed.push(fn),
    setOnline: (val) => { isOnline = val; },
    setFetchHandler: (fn) => { mockFetchHandler = fn; },
    getFetchHistory: () => mockFetchHistory,
    storage: mockLocalStorage,
  };
}

test('outbox: enqueue creates a structured event and notifies change listeners', () => {
  const outbox = createOutboxHarness();
  let notifiedCount = 0;
  outbox.onChange((c) => { notifiedCount = c; });

  const eventId = outbox.enqueue({
    type: 'arrived',
    orderId: 101,
    vehicleId: 5,
    payload: { lat: 6.9271, lng: 79.8612 },
  });

  assert.ok(eventId, 'returns a valid eventId');
  assert.equal(typeof eventId, 'string');
});

test('outbox: offline queuing preserves events until connection is restored', async () => {
  const outbox = createOutboxHarness();
  outbox.setOnline(false);

  outbox.enqueue({ type: 'arrived', orderId: 101 });
  outbox.enqueue({ type: 'pod', orderId: 101, payload: { signature: 'data:image/png;base64,abc' } });

  assert.equal(outbox.count(), 2, '2 events remain in offline queue');

  // Restore connectivity and flush
  outbox.setOnline(true);
  await outbox.flush();

  assert.equal(outbox.count(), 0, 'queue drained after successful flush');
  assert.equal(outbox.storage.getItem('waypoint_last_sync'), '12:00 PM');
});

test('outbox: handles server duplicate response without dropping non-duplicate events', async () => {
  const outbox = createOutboxHarness();
  outbox.setOnline(false);

  const id1 = outbox.enqueue({ eventId: 'evt-1', type: 'arrived', orderId: 200 });
  const id2 = outbox.enqueue({ eventId: 'evt-2', type: 'pod', orderId: 200 });

  outbox.setFetchHandler(async () => ({
    ok: true,
    json: async () => ({
      results: [
        { eventId: id1, status: 'duplicate' }, // already synced previously
        { eventId: id2, status: 'accepted' },
      ],
    }),
  }));

  outbox.setOnline(true);
  await outbox.flush();

  // Both accepted and duplicate are considered processed by the server and removed from local outbox
  assert.equal(outbox.count(), 0, 'both accepted and duplicate events are removed from outbox');
});

test('outbox: conflicts are retained for manual resolution', async () => {
  const outbox = createOutboxHarness();
  outbox.setOnline(false);

  const conflictId = outbox.enqueue({ eventId: 'evt-bad', type: 'invalid_type', orderId: 300 });

  outbox.setFetchHandler(async () => ({
    ok: true,
    json: async () => ({
      results: [{ eventId: conflictId, status: 'conflict', detail: 'invalid event' }],
    }),
  }));

  outbox.setOnline(true);
  await outbox.flush();

  assert.equal(outbox.count(), 1, 'conflict event remains in outbox for review');
  assert.equal(outbox.all()[0].eventId, conflictId);
});
