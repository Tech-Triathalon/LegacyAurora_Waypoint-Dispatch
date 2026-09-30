// API Integration tests for Operations, Offline Batch Sync, Shortage Flags, Receipts, and Telemetry.
const test = require('node:test');
const assert = require('node:assert');
const express = require('../server/node_modules/express');

function createOpsPrismaMock() {
  let vehicles = [
    { id: 1, vehicleId: 'VEH035', depot: 'Peliyagoda', temp: 'reefer', type: 'van', status: 'available', telemetryStale: false },
    { id: 2, vehicleId: 'VEH008', depot: 'Peliyagoda', temp: 'ambient', type: 'truck', status: 'available', telemetryStale: false },
  ];

  let orders = [
    { id: 10, orderRef: 'ORD-0010', outletId: 'OUT001', brand: 'Fresh', status: 'allocated' },
    { id: 11, orderRef: 'ORD-0011', outletId: 'OUT001', brand: 'Fresh', status: 'allocated' },
  ];

  let events = [];
  let flags = [];
  const trips = [
    {
      id: 1,
      vehicleId: 1,
      tripNo: 1,
      brand: 'Fresh',
      district: 'Colombo',
      depot: 'Peliyagoda',
      status: 'planned',
      stops: [
        { seq: 1, orderId: 10, plannedArrival: '06:00', order: orders[0] },
      ],
      vehicle: vehicles[0],
    },
  ];

  return {
    vehicle: {
      findUnique: async ({ where }) => vehicles.find((v) => v.vehicleId === where.vehicleId || v.id === where.id) || null,
      findMany: async () => vehicles,
      update: async ({ where, data }) => {
        const v = vehicles.find((item) => item.vehicleId === where.vehicleId || item.id === where.id);
        if (v) Object.assign(v, data);
        return v;
      },
    },
    order: {
      findMany: async ({ where } = {}) => orders.filter((o) => (!where || !where.outletId || o.outletId === where.outletId)),
      update: async ({ where, data }) => {
        const o = orders.find((item) => item.id === where.id);
        if (o) Object.assign(o, data);
        return o;
      },
    },
    trip: {
      findMany: async ({ where } = {}) => trips.filter((t) => (!where || !where.vehicleId || t.vehicleId === where.vehicleId)),
    },
    deliveryEvent: {
      create: async ({ data }) => {
        if (events.some((e) => e.eventId === data.eventId)) {
          const err = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const record = { id: events.length + 1, ...data, serverTimestamp: new Date() };
        events.push(record);
        return record;
      },
      findMany: async ({ where } = {}) => {
        if (where && where.orderId && where.orderId.in) {
          return events.filter((e) => where.orderId.in.includes(e.orderId));
        }
        return events;
      },
    },
    shortageFlag: {
      create: async ({ data }) => {
        const record = { id: flags.length + 1, ...data, status: 'open', createdAt: new Date() };
        flags.push(record);
        return record;
      },
      findMany: async ({ where } = {}) => {
        return flags
          .filter((f) => (!where || !where.orderId || f.orderId === where.orderId) && (!where || !where.status || f.status === where.status))
          .map((f) => ({ ...f, order: orders.find((o) => o.id === f.orderId) || { outletId: 'OUT001' } }));
      },
      update: async ({ where, data }) => {
        const f = flags.find((item) => item.id === where.id);
        if (f) Object.assign(f, data);
        return f;
      },
    },
    deferralLedger: {
      findMany: async () => [],
    },
  };
}

function createOpsApp(mockPrisma) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // GET /api/health
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'waypoint-api', time: new Date().toISOString() }));

  // POST /api/events/batch
  app.post('/api/events/batch', async (req, res) => {
    const events = (req.body && Array.isArray(req.body.events)) ? req.body.events : [];
    if (events.length === 0) return res.status(400).json({ error: 'events[] required' });
    if (events.length > 200) return res.status(413).json({ error: 'batch too large (max 200)' });

    const VALID = ['loaded', 'departed', 'arrived', 'pod', 'issue', 'receipt'];
    const results = [];
    const seen = new Set();

    for (const e of events) {
      if (!e.eventId || !VALID.includes(e.type)) {
        results.push({ eventId: e.eventId || null, status: 'conflict', detail: 'invalid event' });
        continue;
      }
      if (seen.has(e.eventId)) {
        results.push({ eventId: e.eventId, status: 'duplicate' });
        continue;
      }
      seen.add(e.eventId);
      try {
        await mockPrisma.deliveryEvent.create({
          data: {
            eventId: e.eventId,
            type: e.type,
            orderId: e.orderId ? Number(e.orderId) : null,
            vehicleId: e.vehicleId ? Number(e.vehicleId) : null,
            payload: e.payload || {},
            clientTimestamp: new Date(e.clientTimestamp || Date.now()),
            syncedFlag: true,
          },
        });
        if (e.type === 'pod' && e.orderId) {
          await mockPrisma.order.update({ where: { id: Number(e.orderId) }, data: { status: 'delivered' } });
        }
        results.push({ eventId: e.eventId, status: 'accepted' });
      } catch (err) {
        if (err && err.code === 'P2002') {
          results.push({ eventId: e.eventId, status: 'duplicate' });
        } else {
          results.push({ eventId: e.eventId, status: 'conflict', detail: 'rejected' });
        }
      }
    }
    return res.json({ results });
  });

  // POST /api/flags
  app.post('/api/flags', async (req, res) => {
    const { orderId, itemDesc, qty, reason, photoBase64 } = req.body || {};
    if (!orderId || !itemDesc || !reason) {
      return res.status(400).json({ error: 'orderId, itemDesc and reason required' });
    }
    if (photoBase64 && photoBase64.length > 400000) {
      return res.status(413).json({ error: 'photo too large (compress to ≤300KB)' });
    }
    const flag = await mockPrisma.shortageFlag.create({
      data: { orderId: Number(orderId), itemDesc, qty: Number(qty) || 0, reason, photoPath: photoBase64 ? 'photo.jpg' : null, createdBy: 'loader' },
    });
    return res.json({ ok: true, flag: { id: flag.id, status: flag.status } });
  });

  // GET /api/flags
  app.get('/api/flags', async (req, res) => {
    const flags = await mockPrisma.shortageFlag.findMany();
    return res.json({ flags });
  });

  // POST /api/receipt
  app.post('/api/receipt', async (req, res) => {
    const { orderId, claim, qtyDelta, note } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    await mockPrisma.deliveryEvent.create({
      data: {
        eventId: `receipt-${orderId}-${Date.now()}`,
        type: 'receipt',
        orderId: Number(orderId),
        payload: { claim: claim || 'confirmed', qtyDelta: qtyDelta || 0, note: note || '' },
        clientTimestamp: new Date(),
        syncedFlag: true,
      },
    });
    const flags = await mockPrisma.shortageFlag.findMany({ where: { orderId: Number(orderId), status: 'open' } });
    for (const f of flags) {
      await mockPrisma.shortageFlag.update({ where: { id: f.id }, data: { status: 'acknowledged' } });
    }
    return res.json({ ok: true, matchedFlags: flags.length, claim: claim || 'confirmed' });
  });

  // GET /api/outlet/:id/timeline
  app.get('/api/outlet/:id/timeline', async (req, res) => {
    const outletId = req.params.id;
    const orders = await mockPrisma.order.findMany({ where: { outletId } });
    const orderIds = orders.map((o) => o.id);
    const events = await mockPrisma.deliveryEvent.findMany({ where: { orderId: { in: orderIds } } });
    return res.json({ outletId, orders, events });
  });

  // POST /api/telemetry/outage
  app.post('/api/telemetry/outage', async (req, res) => {
    const { vehicleCode, stale } = req.body || {};
    const v = await mockPrisma.vehicle.findUnique({ where: { vehicleId: vehicleCode } });
    if (!v) return res.status(404).json({ error: 'vehicle not found' });
    await mockPrisma.vehicle.update({ where: { vehicleId: vehicleCode }, data: { telemetryStale: !!stale } });
    return res.json({ vehicleCode, telemetryStale: !!stale });
  });

  // GET /api/telemetry/fleet
  app.get('/api/telemetry/fleet', async (req, res) => {
    const fleet = await mockPrisma.vehicle.findMany();
    return res.json({ fleet: fleet.map((v) => ({ vehicleCode: v.vehicleId, telemetryStale: v.telemetryStale })) });
  });

  return app;
}

test('GET /api/health: liveness probe returns ok', async () => {
  const app = createOpsApp(createOpsPrismaMock());
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'waypoint-api');
  } finally {
    server.close();
  }
});

test('POST /api/events/batch: processes events, dedupes replayed IDs, and updates POD order status', async () => {
  const mockPrisma = createOpsPrismaMock();
  const app = createOpsApp(mockPrisma);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. Batch upload with arrived and pod event
    const res = await fetch(`http://127.0.0.1:${port}/api/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          { eventId: 'evt-arr-10', type: 'arrived', orderId: 10, vehicleId: 1 },
          { eventId: 'evt-pod-10', type: 'pod', orderId: 10, vehicleId: 1, payload: { signature: 'sig_base64_data' } },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].status, 'accepted');
    assert.equal(body.results[1].status, 'accepted');

    // Verify order 10 updated to 'delivered'
    const updatedOrder = (await mockPrisma.order.findMany()).find((o) => o.id === 10);
    assert.equal(updatedOrder.status, 'delivered');

    // 2. Replayed duplicate event is handled gracefully with status: 'duplicate'
    const replayRes = await fetch(`http://127.0.0.1:${port}/api/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          { eventId: 'evt-pod-10', type: 'pod', orderId: 10 },
          { eventId: 'evt-new-11', type: 'arrived', orderId: 11 },
        ],
      }),
    });
    const replayBody = await replayRes.json();
    assert.equal(replayBody.results[0].status, 'duplicate');
    assert.equal(replayBody.results[1].status, 'accepted');
  } finally {
    server.close();
  }
});

test('POST /api/flags & POST /api/receipt: loader shortage flags are auto-matched on store receipt', async () => {
  const mockPrisma = createOpsPrismaMock();
  const app = createOpsApp(mockPrisma);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. Loader logs a shortage flag for Order 10
    const flagRes = await fetch(`http://127.0.0.1:${port}/api/flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 10,
        itemDesc: 'Fresh Milk 1L Crate',
        qty: 2,
        reason: 'Damaged during staging',
      }),
    });
    assert.equal(flagRes.status, 200);
    const flagBody = await flagRes.json();
    assert.equal(flagBody.ok, true);
    assert.equal(flagBody.flag.status, 'open');

    // 2. Store Manager submits Goods Receipt for Order 10
    const receiptRes = await fetch(`http://127.0.0.1:${port}/api/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 10,
        claim: 'shortage',
        qtyDelta: -2,
        note: '2 crates damaged as noted by dock',
      }),
    });
    assert.equal(receiptRes.status, 200);
    const receiptBody = await receiptRes.json();
    assert.equal(receiptBody.ok, true);
    assert.equal(receiptBody.matchedFlags, 1, '1 open shortage flag matched and acknowledged');

    // Verify flag status is now 'acknowledged'
    const openFlags = await mockPrisma.shortageFlag.findMany({ where: { orderId: 10, status: 'open' } });
    assert.equal(openFlags.length, 0, 'no open flags remain');
  } finally {
    server.close();
  }
});

test('POST /api/telemetry/outage: toggles telemetry stale flag on vehicle', async () => {
  const mockPrisma = createOpsPrismaMock();
  const app = createOpsApp(mockPrisma);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/telemetry/outage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleCode: 'VEH035', stale: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.telemetryStale, true);

    const fleetRes = await fetch(`http://127.0.0.1:${port}/api/telemetry/fleet`);
    const fleetBody = await fleetRes.json();
    const v = fleetBody.fleet.find((item) => item.vehicleCode === 'VEH035');
    assert.equal(v.telemetryStale, true);
  } finally {
    server.close();
  }
});
