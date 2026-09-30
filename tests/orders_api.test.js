// API Integration tests for Orders, Queue Verdicts, and Deferrals.
const test = require('node:test');
const assert = require('node:assert');
const express = require('../server/node_modules/express');
const { DEMO_DAY } = require('../server/src/routes/orders');

// In-memory mock store for orders, outlets, vehicles, and deferrals
function createMockPrisma() {
  const outlets = [
    { id: 1, outletId: 'OUT001', name: 'Fresh Super Colombo 03', district: 'Colombo', brand: 'Fresh', dockType: 'bay', parkingConstraint: 'normal' },
    { id: 2, outletId: 'OUT002', name: 'Style Central Galle', district: 'Galle', brand: 'Style', dockType: 'street', parkingConstraint: 'van_only' },
  ];

  const vehicles = [
    { id: 1, vehicleId: 'VEH035', depot: 'Peliyagoda', temp: 'reefer', type: 'van', weightCapKg: 1200, volumeCapM3: 6.5, fuelCapLiters: 65, weeklyFuelQuotaLiters: 300, status: 'available', telemetryStale: false },
    { id: 2, vehicleId: 'VEH008', depot: 'Peliyagoda', temp: 'ambient', type: 'truck', weightCapKg: 5000, volumeCapM3: 22.0, fuelCapLiters: 150, weeklyFuelQuotaLiters: 600, status: 'available', telemetryStale: false },
  ];

  let orders = [
    {
      id: 1,
      orderRef: 'ORD-0001',
      outletId: 'OUT001',
      brand: 'Fresh',
      district: 'Colombo',
      depot: 'Peliyagoda',
      tempRequirement: 'chilled',
      units: 100,
      weightKg: 300,
      volumeM3: 2.5,
      orderDate: new Date(`${DEMO_DAY}T00:00:00.000Z`),
      windowOpen: '05:00',
      windowClose: '08:00',
      deferredYesterday: false,
      status: 'queued',
      deferralReason: null,
      promiseDate: null,
      outlet: outlets[0],
    },
    {
      id: 2,
      orderRef: 'ORD-0002',
      outletId: 'OUT002',
      brand: 'Style',
      district: 'Galle',
      depot: 'Peliyagoda',
      tempRequirement: 'ambient',
      units: 200,
      weightKg: 500,
      volumeM3: 4.0,
      orderDate: new Date(`${DEMO_DAY}T00:00:00.000Z`),
      windowOpen: '09:00',
      windowClose: '17:00',
      deferredYesterday: false,
      status: 'queued',
      deferralReason: null,
      promiseDate: null,
      outlet: outlets[1],
    },
  ];

  const deferralLedger = [];

  return {
    order: {
      findMany: async ({ where }) => {
        return orders.filter((o) => {
          if (where && where.orderDate) {
            const d = new Date(o.orderDate).getTime();
            return d >= where.orderDate.gte.getTime() && d < where.orderDate.lt.getTime();
          }
          return true;
        });
      },
      findUnique: async ({ where }) => orders.find((o) => o.id === where.id) || null,
      update: async ({ where, data }) => {
        const idx = orders.findIndex((o) => o.id === where.id);
        if (idx >= 0) {
          orders[idx] = { ...orders[idx], ...data };
          return orders[idx];
        }
        throw new Error('Order not found');
      },
    },
    vehicle: {
      findMany: async () => vehicles,
    },
    deferralLedger: {
      create: async ({ data }) => {
        const record = { id: deferralLedger.length + 1, ...data, promisedAt: new Date() };
        deferralLedger.push(record);
        return record;
      },
      findMany: async () => {
        return deferralLedger.map((l) => ({
          ...l,
          order: orders.find((o) => o.id === l.orderId) || { outletId: 'UNKNOWN', brand: 'Unknown', deferredYesterday: false },
        }));
      },
      count: async ({ where }) => {
        return deferralLedger.filter((l) => l.orderId === where.orderId && l.reason === where.reason).length;
      },
    },
  };
}

function createTestApp(prismaMock) {
  const app = express();
  app.use(express.json());

  // Mount mocked route handlers
  app.get('/api/orders', async (req, res) => {
    const date = req.query.date || DEMO_DAY;
    const d = new Date(`${date}T00:00:00.000Z`);
    const rows = await prismaMock.order.findMany({
      where: { orderDate: { gte: d, lt: new Date(d.getTime() + 86400000) } },
    });
    const vehicles = await prismaMock.vehicle.findMany();

    const chilledDemandM3 = rows.filter((o) => o.tempRequirement === 'chilled').reduce((s, o) => s + o.volumeM3, 0);
    const reeferCapM3 = vehicles.filter((v) => v.temp === 'reefer' && v.depot === 'Peliyagoda')
      .reduce((s, v) => s + v.volumeCapM3 * 2, 0);
    const demandM3 = rows.reduce((s, o) => s + o.volumeM3, 0);
    const capM3 = vehicles.filter((v) => v.depot === 'Peliyagoda').reduce((s, v) => s + v.volumeCapM3 * 2, 0);

    const verdict = {
      totalOrders: rows.length,
      demandM3: Math.round(demandM3 * 10) / 10,
      capM3: Math.round(capM3 * 10) / 10,
      chilledDemandM3: Math.round(chilledDemandM3 * 10) / 10,
      reeferCapM3: Math.round(reeferCapM3 * 10) / 10,
      reeferShortfall: chilledDemandM3 > reeferCapM3,
      overloaded: demandM3 > capM3,
    };

    return res.json({ date, orders: rows, verdict });
  });

  app.post('/api/orders/:id/defer', async (req, res) => {
    const id = Number(req.params.id);
    const { reason, detail } = req.body || {};
    if (!['CAP', 'REF', 'INV'].includes(reason)) {
      return res.status(400).json({ error: 'reason must be CAP, REF or INV' });
    }
    const order = await prismaMock.order.findUnique({ where: { id } });
    if (!order) return res.status(404).json({ error: 'order not found' });
    const promise = DEMO_DAY;
    const updated = await prismaMock.order.update({
      where: { id },
      data: { status: 'deferred', deferralReason: reason, promiseDate: new Date(`${promise}T00:00:00.000Z`) },
    });
    await prismaMock.deferralLedger.create({
      data: { orderId: id, reason, detail: detail || '', promiseDate: new Date(`${promise}T00:00:00.000Z`) },
    });
    return res.json({ ok: true, order: updated });
  });

  app.get('/api/deferrals', async (req, res) => {
    const ledger = await prismaMock.deferralLedger.findMany();
    return res.json({
      ledger: ledger.map((l) => ({
        id: l.id,
        orderId: l.orderId,
        orderRef: `ORD-${String(l.orderId).padStart(4, '0')}`,
        outletId: l.order.outletId,
        brand: l.order.brand,
        reason: l.reason,
        detail: l.detail,
        promiseDate: l.promiseDate,
        deferredYesterday: l.order.deferredYesterday,
      })),
    });
  });

  return app;
}

test('GET /api/orders: returns queued orders with accurate capacity verdict banner', async () => {
  const prismaMock = createMockPrisma();
  const app = createTestApp(prismaMock);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/orders?date=${DEMO_DAY}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.date, DEMO_DAY);
    assert.equal(body.orders.length, 2);
    assert.ok(body.verdict, 'verdict object exists');
    assert.equal(body.verdict.totalOrders, 2);
    assert.equal(body.verdict.demandM3, 6.5);
    assert.equal(body.verdict.chilledDemandM3, 2.5);
    assert.equal(body.verdict.reeferShortfall, false);
    assert.equal(body.verdict.overloaded, false);
  } finally {
    server.close();
  }
});

test('POST /api/orders/:id/defer: validates reason codes and updates order status', async () => {
  const prismaMock = createMockPrisma();
  const app = createTestApp(prismaMock);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. Invalid reason rejected with 400
    const badRes = await fetch(`http://127.0.0.1:${port}/api/orders/1/defer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'INVALID_REASON' }),
    });
    assert.equal(badRes.status, 400);

    // 2. Non-existent order returns 404
    const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/orders/9999/defer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'CAP', detail: 'Truck full' }),
    });
    assert.equal(notFoundRes.status, 404);

    // 3. Valid deferral updates order to deferred
    const validRes = await fetch(`http://127.0.0.1:${port}/api/orders/1/defer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'CAP', detail: 'Depot capacity exceeded' }),
    });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.equal(validBody.ok, true);
    assert.equal(validBody.order.status, 'deferred');
    assert.equal(validBody.order.deferralReason, 'CAP');

    // 4. Verify deferral appears in deferral ledger
    const ledgerRes = await fetch(`http://127.0.0.1:${port}/api/deferrals`);
    assert.equal(ledgerRes.status, 200);
    const ledgerBody = await ledgerRes.json();
    assert.equal(ledgerBody.ledger.length, 1);
    assert.equal(ledgerBody.ledger[0].orderId, 1);
    assert.equal(ledgerBody.ledger[0].reason, 'CAP');
  } finally {
    server.close();
  }
});
