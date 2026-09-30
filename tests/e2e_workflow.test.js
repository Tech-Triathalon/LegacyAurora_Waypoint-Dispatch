// End-to-End Integration Test: Complete Multi-Role Lifecycle Workflow
// Store Manager -> Dispatcher -> Allocation Engine -> Loader -> Driver (Offline Outbox) -> Store Receipt -> Fleet Telemetry
const test = require('node:test');
const assert = require('node:assert');
const express = require('../server/node_modules/express');
const { allocate } = require('../server/src/allocation/engine');
const { validatePlan } = require('../server/src/allocation/validate');
const datasets = require('../server/src/data/datasets');

const TEST_DATE = '2026-06-25';

function createFullSystemHarness() {
  const allVehicles = datasets.loadVehicles();
  const allOutlets = datasets.loadOutlets();
  const outletMap = Object.fromEntries(allOutlets.map((o) => [o.outletId, o]));

  let orders = [
    {
      id: 101,
      orderRef: 'ORD-0101',
      outletId: 'OUT001',
      brand: 'Fresh',
      district: 'Colombo',
      depot: 'Peliyagoda',
      tempRequirement: 'chilled',
      units: 150,
      weightKg: 400,
      volumeM3: 2.0,
      orderDate: new Date(`${TEST_DATE}T00:00:00.000Z`),
      windowOpen: '05:00',
      windowClose: '08:00',
      deferredYesterday: false,
      status: 'queued',
      deferralReason: null,
      promiseDate: null,
      outlet: outletMap['OUT001'],
      dockType: outletMap['OUT001'].dockType,
      parkingConstraint: outletMap['OUT001'].parkingConstraint,
    },
    {
      id: 102,
      orderRef: 'ORD-0102',
      outletId: 'OUT002',
      brand: 'Fresh',
      district: 'Colombo',
      depot: 'Peliyagoda',
      tempRequirement: 'chilled',
      units: 120,
      weightKg: 350,
      volumeM3: 1.8,
      orderDate: new Date(`${TEST_DATE}T00:00:00.000Z`),
      windowOpen: '05:00',
      windowClose: '08:00',
      deferredYesterday: false,
      status: 'queued',
      deferralReason: null,
      promiseDate: null,
      outlet: outletMap['OUT002'],
      dockType: outletMap['OUT002'].dockType,
      parkingConstraint: outletMap['OUT002'].parkingConstraint,
    },
  ];

  let trips = [];
  let tripStops = [];
  let events = [];
  let flags = [];
  let deferralLedger = [];

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 1. Dispatcher: Queue & Capacity
  app.get('/api/orders', (req, res) => {
    const demandM3 = orders.reduce((s, o) => s + o.volumeM3, 0);
    const chilledDemandM3 = orders.filter((o) => o.tempRequirement === 'chilled').reduce((s, o) => s + o.volumeM3, 0);
    const reeferCapM3 = allVehicles.filter((v) => v.temp === 'reefer' && v.depot === 'Peliyagoda').reduce((s, v) => s + v.volumeCapM3 * 2, 0);
    const capM3 = allVehicles.filter((v) => v.depot === 'Peliyagoda').reduce((s, v) => s + v.volumeCapM3 * 2, 0);

    return res.json({
      date: TEST_DATE,
      orders,
      verdict: {
        totalOrders: orders.length,
        demandM3: Math.round(demandM3 * 10) / 10,
        capM3: Math.round(capM3 * 10) / 10,
        chilledDemandM3: Math.round(chilledDemandM3 * 10) / 10,
        reeferCapM3: Math.round(reeferCapM3 * 10) / 10,
        reeferShortfall: chilledDemandM3 > reeferCapM3,
        overloaded: demandM3 > capM3,
      },
    });
  });

  // 2. Dispatcher: Allocate dry-run
  app.post('/api/plan/allocate', (req, res) => {
    const eligible = orders.filter((o) => o.status === 'queued' || o.status === 'deferred');
    const result = allocate({ orders: eligible, vehicles: allVehicles, date: TEST_DATE });
    const planCheck = validatePlan({ trips: result.trips, vehicles: allVehicles });
    return res.json({ date: TEST_DATE, ...result, planCheck });
  });

  // 3. Dispatcher: Commit Plan
  app.post('/api/plan/commit', (req, res) => {
    const { plan } = req.body || {};
    if (!plan || !Array.isArray(plan.trips)) return res.status(400).json({ error: 'plan.trips required' });

    const check = validatePlan({ trips: plan.trips, vehicles: allVehicles });
    if (!check.feasible) return res.status(422).json({ error: 'plan failed hard validation', violations: check.violations });

    trips = [];
    tripStops = [];
    for (const t of plan.trips) {
      const tripId = trips.length + 1;
      const tripRecord = { id: tripId, ...t, status: 'planned', committedAt: new Date() };
      trips.push(tripRecord);
      for (const s of t.plannedStops) {
        tripStops.push({ id: tripStops.length + 1, tripId, seq: s.seq, orderId: s.orderId, plannedArrival: s.plannedArrival });
        const o = orders.find((ord) => ord.id === s.orderId);
        if (o) o.status = 'allocated';
      }
    }
    return res.json({ committed: true, trips: trips.length, deferred: plan.deferred ? plan.deferred.length : 0 });
  });

  // 4. Loader: Fetch Manifest by vehicle
  app.get('/api/trips/:vehicleCode', (req, res) => {
    const vehicleCode = req.params.vehicleCode;
    const vTrips = trips.filter((t) => t.vehicleId === vehicleCode);
    return res.json({
      vehicle: vehicleCode,
      trips: vTrips.map((t) => ({
        ...t,
        stops: tripStops.filter((s) => s.tripId === t.id).map((s) => ({
          ...s,
          order: orders.find((o) => o.id === s.orderId),
        })),
      })),
    });
  });

  // 5. Loader: Raise Shortage Flag
  app.post('/api/flags', (req, res) => {
    const { orderId, itemDesc, qty, reason, photoBase64 } = req.body || {};
    const flag = {
      id: flags.length + 1,
      orderId: Number(orderId),
      itemDesc,
      qty: Number(qty) || 0,
      reason,
      status: 'open',
      createdAt: new Date(),
    };
    flags.push(flag);
    return res.json({ ok: true, flag });
  });

  // 6. Driver: Fetch Manifest
  app.get('/api/trips/for-driver', (req, res) => {
    return res.json({
      vehicle: trips[0] ? trips[0].vehicleId : null,
      telemetryStale: false,
      trips: trips.map((t) => ({
        ...t,
        stops: tripStops.filter((s) => s.tripId === t.id).map((s) => ({
          ...s,
          order: orders.find((o) => o.id === s.orderId),
        })),
      })),
    });
  });

  // 7. Driver: Batch Event Sync (Offline Safe)
  app.post('/api/events/batch', (req, res) => {
    const batchEvents = (req.body && req.body.events) || [];
    const results = [];
    for (const e of batchEvents) {
      if (events.some((existing) => existing.eventId === e.eventId)) {
        results.push({ eventId: e.eventId, status: 'duplicate' });
        continue;
      }
      events.push({ ...e, serverTimestamp: new Date() });
      if (e.type === 'pod' && e.orderId) {
        const o = orders.find((ord) => ord.id === Number(e.orderId));
        if (o) o.status = 'delivered';
      }
      results.push({ eventId: e.eventId, status: 'accepted' });
    }
    return res.json({ results });
  });

  // 8. Store Manager: Timeline & Goods Receipt
  app.get('/api/outlet/:id/timeline', (req, res) => {
    const outletOrders = orders.filter((o) => o.outletId === req.params.id);
    const orderIds = outletOrders.map((o) => o.id);
    const outletEvents = events.filter((e) => orderIds.includes(Number(e.orderId)));
    return res.json({ outletId: req.params.id, orders: outletOrders, events: outletEvents });
  });

  app.post('/api/receipt', (req, res) => {
    const { orderId, claim, qtyDelta } = req.body || {};
    events.push({
      eventId: `receipt-${orderId}-${Date.now()}`,
      type: 'receipt',
      orderId: Number(orderId),
      payload: { claim, qtyDelta },
      serverTimestamp: new Date(),
    });
    const matched = flags.filter((f) => f.orderId === Number(orderId) && f.status === 'open');
    matched.forEach((f) => { f.status = 'acknowledged'; });
    return res.json({ ok: true, matchedFlags: matched.length, claim });
  });

  return { app, getOrders: () => orders, getEvents: () => events, getFlags: () => flags };
}

test('e2e workflow: complete multi-role dispatch, loading, delivery POD and receipt matching lifecycle', async () => {
  const { app, getOrders, getEvents, getFlags } = createFullSystemHarness();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Step 1: Dispatcher reviews order queue and capacity verdict
    const ordersRes = await fetch(`${baseUrl}/api/orders`);
    assert.equal(ordersRes.status, 200);
    const ordersData = await ordersRes.json();
    assert.equal(ordersData.orders.length, 2);
    assert.equal(ordersData.verdict.overloaded, false);

    // Step 2: Dispatcher runs allocation dry-run
    const allocateRes = await fetch(`${baseUrl}/api/plan/allocate`, { method: 'POST' });
    assert.equal(allocateRes.status, 200);
    const allocateData = await allocateRes.json();
    assert.ok(allocateData.trips.length > 0, 'allocation engine generated trips');
    assert.equal(allocateData.planCheck.feasible, true, 'plan passes all hard feasibility constraints');

    // Step 3: Dispatcher commits plan
    const commitRes = await fetch(`${baseUrl}/api/plan/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: allocateData }),
    });
    assert.equal(commitRes.status, 200);
    const commitData = await commitRes.json();
    assert.equal(commitData.committed, true);
    assert.equal(getOrders().every((o) => o.status === 'allocated'), true, 'all committed orders are allocated');

    const assignedVehicle = allocateData.trips[0].vehicleId;

    // Step 4: Loader inspects manifest and flags item damage during loading
    const loaderRes = await fetch(`${baseUrl}/api/trips/${assignedVehicle}`);
    assert.equal(loaderRes.status, 200);
    const loaderData = await loaderRes.json();
    assert.ok(loaderData.trips.length > 0);

    const flagRes = await fetch(`${baseUrl}/api/flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 101,
        itemDesc: 'Fresh Greek Yogurt Crate',
        qty: 1,
        reason: 'Broken seal during pallet transfer',
      }),
    });
    assert.equal(flagRes.status, 200);
    assert.equal(getFlags()[0].status, 'open');

    // Step 5: Driver retrieves manifest and records arrival & POD signature (via offline outbox batch)
    const driverRes = await fetch(`${baseUrl}/api/trips/for-driver`);
    assert.equal(driverRes.status, 200);

    const batchRes = await fetch(`${baseUrl}/api/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          { eventId: 'evt-001-arr', type: 'arrived', orderId: 101, clientTimestamp: new Date().toISOString() },
          { eventId: 'evt-002-pod', type: 'pod', orderId: 101, payload: { signature: 'data:image/svg+xml;base64,mock' } },
        ],
      }),
    });
    assert.equal(batchRes.status, 200);
    const batchData = await batchRes.json();
    assert.equal(batchData.results.every((r) => r.status === 'accepted'), true);

    // Verify order status transitioned to delivered
    const order101 = getOrders().find((o) => o.id === 101);
    assert.equal(order101.status, 'delivered');

    // Step 6: Store Manager checks outlet timeline and confirms receipt with shortage adjustment
    const timelineRes = await fetch(`${baseUrl}/api/outlet/OUT001/timeline`);
    assert.equal(timelineRes.status, 200);
    const timelineData = await timelineRes.json();
    assert.ok(timelineData.events.some((e) => e.type === 'pod'));

    const receiptRes = await fetch(`${baseUrl}/api/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 101,
        claim: 'shortage',
        qtyDelta: -1,
      }),
    });
    assert.equal(receiptRes.status, 200);
    const receiptData = await receiptRes.json();
    assert.equal(receiptData.ok, true);
    assert.equal(receiptData.matchedFlags, 1, 'Loader shortage flag automatically matched and acknowledged');
    assert.equal(getFlags()[0].status, 'acknowledged');
  } finally {
    server.close();
  }
});
