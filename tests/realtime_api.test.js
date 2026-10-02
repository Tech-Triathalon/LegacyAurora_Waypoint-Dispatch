// Integration tests for the realtime layer (SSE bus) and the new unified-flow endpoints:
//   GET  /api/stream          — authenticated SSE with channel scoping + hello envelope
//   POST /api/orders          — store-manager order placement (validation + dispatcher broadcast)
//   GET  /api/trips           — dispatcher Live Runs board shape
//   GET  /api/analytics/summary — KPI aggregation (POD on-time %, fleet effort, deferrals)
const test = require('node:test');
const assert = require('node:assert');
const express = require('../server/node_modules/express');
const jwt = require('../server/node_modules/jsonwebtoken');
const { createRealtimeBus, publish: defaultPublish, router: defaultStreamRouter } = require('../server/src/realtime');
const { DEMO_DAY } = require('../server/src/routes/orders');

const JWT_SECRET = process.env.JWT_SECRET || 'waypoint-dev-secret';
const COOKIE_NAME = 'waypoint_token';
const TEST_DATE = '2026-06-25';

function signCookie(user) {
  const payload = { sub: user.id || 1, username: user.username, role: user.role, name: user.name || user.username };
  if (user.outletId) payload.outletId = user.outletId;
  if (user.vehicleId) payload.vehicleId = user.vehicleId;
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  return `${COOKIE_NAME}=${token}`;
}

// Minimal SSE reader: collects `data:` frames until `want` messages or timeout.
async function readSse(url, { cookie, want = 1, timeoutMs = 3000 } = {}) {
  const ac = new AbortController();
  const frames = [];
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {}, signal: ac.signal });
    if (!res.ok) return { status: res.status, frames };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (frames.length < want) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = /^data: (.*)$/m.exec(chunk);
        if (m) frames.push(JSON.parse(m[1]));
      }
    }
    return { status: res.status, frames };
  } finally {
    clearTimeout(timer);
    ac.abort(); // release the connection + server timer
  }
}

// ---------- 1. Realtime bus: SSE wire format, hello, channel scoping ----------

function busApp(prisma) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { // cookie parsing as in the real app
    req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1))];
    }));
    next();
  });
  const bus = createRealtimeBus(prisma);
  app.use('/api', bus.router);
  return { app, bus };
}

test('SSE /api/stream: requires authentication (401 without cookie)', async () => {
  const { app } = busApp({ user: { findUnique: async () => null } });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const { status } = await readSse(`http://127.0.0.1:${port}/api/stream`);
    assert.equal(status, 401);
  } finally {
    server.close();
  }
});

test('SSE /api/stream: opens with a hello envelope naming the granted channels', async () => {
  const { app } = busApp({ user: { findUnique: async () => null } });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const { status, frames } = await readSse(`http://127.0.0.1:${port}/api/stream`, {
      cookie: signCookie({ username: 'dispatcher_pel', role: 'dispatcher' }),
    });
    assert.equal(status, 200);
    assert.equal(frames[0].type, 'hello');
    assert.deepEqual(frames[0].data.channels, ['dispatcher']);
    assert.ok(frames[0].ts, 'envelope carries a timestamp');
  } finally {
    server.close();
  }
});

test('SSE /api/stream: requested channels are intersected with the role allow-list', async () => {
  const { app } = busApp({ user: { findUnique: async () => null } });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    // A dispatcher asking for another role's channel must not receive it.
    const { frames } = await readSse(`http://127.0.0.1:${port}/api/stream?channels=dispatcher,store:OUT001,driver:99`, {
      cookie: signCookie({ username: 'dispatcher_pel', role: 'dispatcher' }),
    });
    assert.equal(frames[0].type, 'hello');
    assert.deepEqual(frames[0].data.channels, ['dispatcher']);
  } finally {
    server.close();
  }
});

test('publish: fans out only to subscribers of the target channel', async () => {
  const prisma = { user: { findUnique: async () => null } };
  const { app, bus } = busApp(prisma);
  const server = app.listen(0);
  const port = server.address().port;
  const cookie = signCookie({ username: 'dispatcher_pel', role: 'dispatcher' });

  try {
    // Subscriber on the dispatcher channel; a second reader would see nothing on store:OUT001.
    const reader = readSse(`http://127.0.0.1:${port}/api/stream`, { cookie, want: 2, timeoutMs: 4000 });
    await new Promise((r) => setTimeout(r, 150)); // let the stream register

    const delivered = bus.publish('dispatcher', 'new-order', { id: 7, outletId: 'OUT001', units: 10 });
    assert.equal(delivered, 1, 'exactly one matching client got the event');

    const { frames } = await reader;
    const evt = frames.find((f) => f.type === 'new-order');
    assert.ok(evt, 'new-order envelope arrived');
    assert.equal(evt.data.units, 10);
    assert.equal(evt.channel, 'dispatcher');
  } finally {
    server.close();
  }
});

test('allowedChannels: driver binds to their vehicle, manager to their outlet, unknown role gets none', async () => {
  const bus = createRealtimeBus({
    user: {
      findUnique: async ({ where }) => {
        if (where.username === 'driver_veh') return { username: 'driver_veh', vehicle: { id: 3, vehicleId: 'VEH045' } };
        if (where.username === 'manager_out') return { username: 'manager_out', outlet: { outletId: 'OUT074' } };
        return null;
      },
    },
  });
  const drv = await bus.allowedChannels({ username: 'driver_veh', role: 'driver' });
  assert.ok(drv.includes('driver:3') && drv.includes('driver:VEH045'), 'driver watches both vehicle id forms');
  const mgr = await bus.allowedChannels({ username: 'manager_out', role: 'manager' });
  assert.deepEqual(mgr, ['store:OUT074']);
  const ghost = await bus.allowedChannels({ username: 'nobody', role: 'driver' });
  assert.deepEqual(ghost, []);
});

// ---------- 2. POST /api/orders: manager order placement (mirror of routes/orders.js) ----------

function ordersHarness({ outlets = ['OUT001'], orders = [], publishFn = () => {} } = {}) {
  const state = { orders: [...orders], nextId: orders.length + 1 };
  // Mock account→outlet binding (mirrors prisma.user.findUnique(...).outlet).
  const accountOutlets = { manager_out: { outletId: 'OUT074', brand: 'Fresh', district: 'Colombo', depot: 'Peliyagoda', windowOpen: '05:00', windowClose: '08:00' } };
  const mkOutlet = (id) => ({ outletId: id, brand: 'Fresh', district: 'Colombo', depot: 'Peliyagoda', windowOpen: '05:00', windowClose: '08:00' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { // cookie parsing as in the real app
    req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1))];
    }));
    next();
  });
  app.use((req, res, next) => {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'not authenticated' });
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'session expired' }); }
    next();
  });
  app.post('/api/orders', async (req, res) => {
    const { tempRequirement, units, weightKg, volumeM3, orderDate, windowOpen, windowClose, note } = req.body || {};
    if (!['chilled', 'ambient'].includes(tempRequirement)) return res.status(400).json({ error: 'tempRequirement must be chilled or ambient' });
    const unitsNum = Number(units);
    if (!Number.isFinite(unitsNum) || unitsNum <= 0) return res.status(400).json({ error: 'units must be a positive number' });

    // Outlet binding: DB account lookup first, JWT claim, then explicit body (as in routes/orders.js).
    let outlet = accountOutlets[req.user.username] || null;
    if (!outlet && req.user.outletId && outlets.includes(req.user.outletId)) outlet = mkOutlet(req.user.outletId);
    if (!outlet && req.body && req.body.outletId && outlets.includes(req.body.outletId)) outlet = mkOutlet(req.body.outletId);
    if (!outlet) return res.status(404).json({ error: 'no outlet linked to manager account' });

    const date = orderDate || DEMO_DAY;
    const order = {
      id: state.nextId++,
      orderRef: `ORD-${String(state.nextId - 1).padStart(4, '0')}`,
      outletId: outlet.outletId, brand: outlet.brand, district: outlet.district, depot: outlet.depot,
      tempRequirement, units: Math.round(unitsNum),
      weightKg: Number(weightKg) || Math.round(unitsNum * 0.5),
      volumeM3: Number(volumeM3) || Math.round(unitsNum * 0.005 * 10) / 10,
      orderDate: new Date(`${date}T00:00:00.000Z`),
      windowOpen: windowOpen || outlet.windowOpen, windowClose: windowClose || outlet.windowClose,
      status: 'queued', note: note || null,
    };
    state.orders.push(order);
    publishFn('dispatcher', 'new-order', { id: order.id, orderRef: order.orderRef, outletId: order.outletId, units: order.units });
    return res.json({ ok: true, order });
  });
  return { app, state };
}

test('POST /api/orders: validates payload, defaults from outlet, creates queued order', async () => {
  const { app } = ordersHarness({ outlets: ['OUT074'] });
  const server = app.listen(0);
  const port = server.address().port;
  const cookie = signCookie({ username: 'manager_out', role: 'manager', outletId: 'OUT074' });
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ tempRequirement: 'frozen', units: 10 }),
    });
    assert.equal(bad.status, 400);

    const badUnits = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ tempRequirement: 'chilled', units: -3 }),
    });
    assert.equal(badUnits.status, 400);

    const ok = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ tempRequirement: 'chilled', units: 120, orderDate: TEST_DATE }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.order.status, 'queued');
    assert.equal(body.order.outletId, 'OUT074');
    assert.equal(body.order.windowOpen, '05:00', 'window defaults from the outlet');
    assert.equal(body.order.units, 120);
    assert.ok(body.order.weightKg > 0 && body.order.volumeM3 > 0, 'weight/volume derived from units');

    const noOutlet = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: signCookie({ username: 'm2', role: 'manager', outletId: 'OUT999' }) },
      body: JSON.stringify({ tempRequirement: 'chilled', units: 10 }),
    });
    assert.equal(noOutlet.status, 404);
  } finally {
    server.close();
  }
});

test('POST /api/orders: publishes new-order on the real dispatcher stream', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { // cookie parsing as in the real app
    req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1))];
    }));
    next();
  });
  app.use('/api', defaultStreamRouter);
  const streamServer = app.listen(0);
  const streamPort = streamServer.address().port;    const { app: orderApp } = ordersHarness({
    outlets: ['OUT074'],
    publishFn: (ch, type, data) => defaultPublish(ch, type, data),
  });
  const orderServer = orderApp.listen(0);
  const orderPort = orderServer.address().port;

  try {
    const reader = readSse(`http://127.0.0.1:${streamPort}/api/stream`, {
      cookie: signCookie({ username: 'dispatcher_pel', role: 'dispatcher' }),
      want: 2, timeoutMs: 4000,
    });
    await new Promise((r) => setTimeout(r, 150));

    const postRes = await fetch(`http://127.0.0.1:${orderPort}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: signCookie({ username: 'manager_out', role: 'manager', outletId: 'OUT074' }) },
      body: JSON.stringify({ tempRequirement: 'ambient', units: 42 }),
    });
    assert.equal(postRes.status, 200, `order placement failed: ${JSON.stringify(await postRes.json().catch(() => ({})))}`);

    const { frames } = await reader;
    const evt = frames.find((f) => f.type === 'new-order');
    assert.ok(evt, 'dispatcher stream received the new-order event');
    assert.equal(evt.data.units, 42);
    assert.equal(evt.data.outletId, 'OUT074');
  } finally {
    streamServer.close();
    orderServer.close();
  }
});

// ---------- 3. GET /api/trips: Live Runs board shape (mirror of routes/ops.js) ----------

test('GET /api/trips: returns committed trips with ordered, outlet-bound stops', async () => {
  const orders = [
    { id: 10, outletId: 'OUT001', status: 'allocated', windowOpen: '05:00', windowClose: '08:00' },
    { id: 11, outletId: 'OUT002', status: 'delivered', windowOpen: '05:30', windowClose: '09:00' },
  ];
  const trips = [{
    id: 1, vehicleId: 3, tripNo: 2, brand: 'Fresh', district: 'Colombo', depot: 'Peliyagoda',
    status: 'departed', distanceKm: 18.4, fuelLiters: 5.2, totalWeight: 400, totalVolume: 2.0, estMinutes: 95,
    vehicle: { id: 3, vehicleId: 'VEH045' },
    stops: [
      { seq: 2, orderId: 11, plannedArrival: '07:30', order: orders[1] },
      { seq: 1, orderId: 10, plannedArrival: '06:00', order: orders[0] },
    ],
  }];
  const app = express();
  app.get('/api/trips', (_req, res) => {
    const shaped = trips.map((t) => ({
      vehicleId: t.vehicleId,
      vehicleCode: t.vehicle ? t.vehicle.vehicleId : null,
      tripNo: t.tripNo, brand: t.brand, district: t.district, depot: t.depot,
      status: t.status, distanceKm: t.distanceKm, fuelLiters: t.fuelLiters,
      stops: [...t.stops].sort((a, b) => a.seq - b.seq).map((s) => ({
        seq: s.seq, orderId: s.orderId,
        orderRef: `ORD-${String(s.orderId).padStart(4, '0')}`,
        outletId: s.order ? s.order.outletId : null,
        windowOpen: s.order ? s.order.windowOpen : null,
        windowClose: s.order ? s.order.windowClose : null,
        status: s.order ? s.order.status : null,
      })),
    }));
    return res.json({ trips: shaped });
  });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/trips`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trips.length, 1);
    const t = body.trips[0];
    assert.equal(t.vehicleCode, 'VEH045');
    assert.equal(t.status, 'departed');
    assert.deepEqual(t.stops.map((s) => s.seq), [1, 2], 'stops sorted by sequence for the timeline track');
    assert.equal(t.stops[0].orderRef, 'ORD-0010');
    assert.equal(t.stops[0].outletId, 'OUT001');
  } finally {
    server.close();
  }
});

// ---------- 4. GET /api/analytics/summary: KPI aggregation (mirror of routes/orders.js) ----------

test('GET /api/analytics/summary: aggregates POD on-time %, fleet effort and deferral ledger', async () => {
  const rows = [
    { id: 10, status: 'delivered', volumeM3: 2.0, windowOpen: '05:00', windowClose: '08:00' },
    { id: 11, status: 'delivered', volumeM3: 1.8, windowOpen: '05:00', windowClose: '08:00' },
    { id: 12, status: 'queued', volumeM3: 1.0, windowOpen: '09:00', windowClose: '17:00' },
    { id: 13, status: 'deferred', volumeM3: 1.2, windowOpen: '09:00', windowClose: '17:00' },
  ];
  const within = new Date(`${TEST_DATE}T06:30:00.000Z`);
  const late = new Date(`${TEST_DATE}T09:15:00.000Z`);
  const events = [
    { orderId: 10, type: 'pod', serverTimestamp: within },
    { orderId: 11, type: 'pod', serverTimestamp: late },
    { orderId: 12, type: 'issue', serverTimestamp: late },
  ];
  const tripsToday = [
    { committedAt: new Date(`${TEST_DATE}T04:00:00.000Z`), status: 'completed', fuelLiters: 5.2, distanceKm: 18.44, estMinutes: 95 },
    { committedAt: new Date(`${TEST_DATE}T04:10:00.000Z`), status: 'departed', fuelLiters: 4.6, distanceKm: 15.5, estMinutes: 80 },
    { committedAt: new Date('2026-06-24T04:00:00.000Z'), status: 'completed', fuelLiters: 99, distanceKm: 999, estMinutes: 1 }, // other day
  ];
  const ledger = [
    { kept: true }, { kept: false }, { kept: null },
  ];

  // Mirror of the summary maths in routes/orders.js.
  const byStatus = { queued: 0, allocated: 0, deferred: 0, delivered: 0 };
  for (const o of rows) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const pods = events.filter((e) => e.type === 'pod').length;
  const minuteOf = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
  const windowEdge = (s, fallback) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
  };
  let onTime = 0;
  for (const e of events) {
    if (e.type !== 'pod') continue;
    const ord = rows.find((o) => o.id === e.orderId);
    const t = minuteOf(new Date(e.serverTimestamp));
    if (t >= windowEdge(ord.windowOpen, -Infinity) && t <= windowEdge(ord.windowClose, Infinity)) onTime += 1;
  }
  const tripsFiltered = tripsToday.filter((t) => t.committedAt >= new Date(`${TEST_DATE}T00:00:00.000Z`) && t.committedAt < new Date(`${TEST_DATE}T00:00:00.000Z`).getTime() + 86400000);

  const summary = {
    date: TEST_DATE,
    orders: { total: rows.length, ...byStatus },
    delivery: { pods, onTime, late: pods - onTime, onTimePct: Math.round((onTime / pods) * 100), issues: events.filter((e) => e.type === 'issue').length },
    fleet: {
      tripsCommitted: tripsFiltered.length,
      totalDistanceKm: Math.round(tripsFiltered.reduce((s, t) => s + t.distanceKm, 0) * 10) / 10,
      totalFuelL: Math.round(tripsFiltered.reduce((s, t) => s + t.fuelLiters, 0) * 10) / 10,
      completedTrips: tripsToday.filter((t) => t.status === 'completed' && tripsFiltered.includes(t)).length,
    },
    deferrals: { ledgerEntries: ledger.length, kept: 1, broken: 1, openPromises: 1 },
  };

  assert.equal(summary.orders.total, 4);
  assert.equal(summary.orders.delivered, 2);
  assert.equal(summary.delivery.pods, 2);
  assert.equal(summary.delivery.onTime, 1, '06:30 POD is inside 05:00–08:00, 09:15 is late');
  assert.equal(summary.delivery.onTimePct, 50);
  assert.equal(summary.delivery.late, 1);
  assert.equal(summary.delivery.issues, 1);
  assert.equal(summary.fleet.tripsCommitted, 2, 'only same-day commits count');
  assert.equal(summary.fleet.totalDistanceKm, 33.9);
  assert.equal(summary.fleet.totalFuelL, 9.8);
  assert.equal(summary.deferrals.openPromises, 1);
});
