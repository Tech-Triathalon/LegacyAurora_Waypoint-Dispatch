// Orders + planning routes: queue with capacity verdict, allocate (dry-run proposal), commit, defer.
const express = require('express');
const prisma = require('../prisma');
const { allocate } = require('../allocation/engine');
const { validatePlan } = require('../allocation/validate');
const { publish, publishAll } = require('../realtime');
const { requireAuth, requireRole } = require('../auth');
const { parseBody, parseBodyPartial, vEnum, vNumber, vString, vDate, isPlainObject } = require('../validate');
const { createRateLimiter } = require('../security');
const idempotency = require('../idempotency');

const router = express.Router();

// Rate limits tuned for console usage + offline replay bursts.
const writeLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
const readLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 240 });

const DEMO_DAY = '2026-06-25';

function dayBounds(date) {
  const d = new Date(`${date}T00:00:00.000Z`);
  return { gte: d, lt: new Date(d.getTime() + 86400000) };
}

function shapeOrder(o) {
  return {
    id: o.id,
    orderRef: `ORD-${String(o.id).padStart(4, '0')}`,
    outletId: o.outletId,
    brand: o.brand,
    district: o.district,
    depot: o.depot,
    tempRequirement: o.tempRequirement,
    units: o.units,
    weightKg: o.weightKg,
    volumeM3: o.volumeM3,
    orderDate: o.orderDate,
    windowOpen: o.windowOpen,
    windowClose: o.windowClose,
    deferredYesterday: o.deferredYesterday,
    status: o.status,
    deferralReason: o.deferralReason,
    promiseDate: o.promiseDate,
  };
}

async function loadOrders(date) {
  return prisma.order.findMany({
    where: { orderDate: dayBounds(date) },
    include: { outlet: true },
  });
}

function engineOrders(rows) {
  return rows.map((o) => ({
    ...shapeOrder(o),
    dockType: o.outlet.dockType,
    parkingConstraint: o.outlet.parkingConstraint,
  }));
}

async function loadVehicles() {
  return prisma.vehicle.findMany();
}

// GET /api/orders?date=YYYY-MM-DD — queue + server-computed capacity verdict banner.
// Any signed-in operator may read the queue; portals render it offline from snapshots.
router.get('/orders', requireAuth, readLimiter, async (req, res) => {
  const date = req.query.date || DEMO_DAY;
  const rows = await loadOrders(date);
  const vehicles = await loadVehicles();
  const orders = engineOrders(rows);

  const chilledDemandM3 = orders.filter((o) => o.tempRequirement === 'chilled').reduce((s, o) => s + o.volumeM3, 0);
  const reeferCapM3 = vehicles.filter((v) => v.temp === 'reefer' && v.depot === 'Peliyagoda')
    .reduce((s, v) => s + v.volumeCapM3 * 2, 0); // ×2 trips/day
  const demandM3 = orders.reduce((s, o) => s + o.volumeM3, 0);
  const capM3 = vehicles.filter((v) => v.depot === 'Peliyagoda').reduce((s, v) => s + v.volumeCapM3 * 2, 0);

  const verdict = {
    totalOrders: orders.length,
    demandM3: Math.round(demandM3 * 10) / 10,
    capM3: Math.round(capM3 * 10) / 10,
    chilledDemandM3: Math.round(chilledDemandM3 * 10) / 10,
    reeferCapM3: Math.round(reeferCapM3 * 10) / 10,
    reeferShortfall: chilledDemandM3 > reeferCapM3,
    overloaded: demandM3 > capM3,
  };

  return res.json({ date, orders: orders.map(shapeOrder), verdict });
});

// POST /api/orders — store manager places an order for their outlet (status queued).
// Accepts an optional `clientRef` (UUID) so queued offline replays are idempotent.
const orderShape = {
  tempRequirement: vEnum(['chilled', 'ambient']),
  units: vNumber({ min: 1, max: 100000, int: true }),
  weightKg: vNumber({ min: 0, max: 100000 }),
  volumeM3: vNumber({ min: 0, max: 1000 }),
  orderDate: vDate({ optional: true }),
  windowOpen: vString({ max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }),
  windowClose: vString({ max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }),
};

router.post('/orders', requireAuth, requireRole('manager'), writeLimiter, idempotency.middleware, async (req, res) => {
  const parsed = parseBodyPartial(orderShape, req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: 'invalid order fields', detail: parsed.errors });
  }
  const { tempRequirement, units, weightKg, volumeM3, orderDate, windowOpen, windowClose } = parsed.value;
  const note = isPlainObject(req.body) && typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : undefined;
  const unitsNum = Number(units);

  // Outlet binding: JWT claims carry only username/role, so resolve the manager's
  // outlet from the DB first; explicit outletId stays as a tooling fallback.
  let outlet = null;
  try {
    const acct = await prisma.user.findUnique({ where: { username: req.user.username }, include: { outlet: true } });
    outlet = acct ? acct.outlet : null;
  } catch (err) {
    console.error('[orders:POST]', err.code || '', err.message);
  }
  if (!outlet && req.user.outletId) {
    outlet = await prisma.outlet.findUnique({ where: { outletId: req.user.outletId } });
  }
  if (!outlet && req.body && req.body.outletId) {
    outlet = await prisma.outlet.findUnique({ where: { outletId: req.body.outletId } });
  }
  if (!outlet) return res.status(404).json({ error: 'no outlet linked to manager account' });

  const date = orderDate || DEMO_DAY;
  const order = await prisma.order.create({
    data: {
      outletId: outlet.outletId,
      brand: outlet.brand,
      district: outlet.district,
      depot: outlet.depot,
      tempRequirement,
      units: Math.round(unitsNum),
      weightKg: Number(weightKg) || Math.round(unitsNum * 0.5),
      volumeM3: Number(volumeM3) || Math.round(unitsNum * 0.005 * 10) / 10,
      orderDate: new Date(`${date}T00:00:00.000Z`),
      windowOpen: windowOpen || outlet.windowOpen,
      windowClose: windowClose || outlet.windowClose,
      status: 'queued',
    },
  });

  // Wake the dispatcher desk — a new drop landed in their queue.
  publish('dispatcher', 'new-order', {
    id: order.id, orderRef: `ORD-${String(order.id).padStart(4, '0')}`, outletId: outlet.outletId,
    brand: order.brand, district: order.district, tempRequirement: order.tempRequirement,
    units: order.units, weightKg: order.weightKg, volumeM3: order.volumeM3,
    windowOpen: order.windowOpen, windowClose: order.windowClose, status: order.status, note: note || null,
  });

  return res.json({ ok: true, order: shapeOrder(order) });
});

// POST /api/plan/allocate — dry-run proposal; nothing persisted until commit.
router.post('/plan/allocate', requireAuth, requireRole('dispatcher'), writeLimiter, async (req, res) => {
  const date = (req.body && req.body.date) || DEMO_DAY;
  const rows = await loadOrders(date);
  const eligible = rows.filter((o) => o.status === 'queued' || o.status === 'deferred');
  const vehicles = await loadVehicles();
  const result = allocate({ orders: engineOrders(eligible), vehicles, date });
  const planCheck = validatePlan({ trips: result.trips.map((t) => ({ ...t, vehicleId: t.vehicleId })), vehicles });
  return res.json({ date, ...result, planCheck });
});

// POST /api/plan/commit — validate then persist trips + stops; orders become allocated.
// Idempotent by design (delete + recreate); clientRef replay-safety on top.
router.post('/plan/commit', requireAuth, requireRole('dispatcher'), writeLimiter, idempotency.middleware, async (req, res) => {
  const date = (req.body && req.body.date) || DEMO_DAY;
  const proposal = req.body && req.body.plan;
  if (!proposal || !Array.isArray(proposal.trips)) {
    return res.status(400).json({ error: 'plan.trips required (run /api/plan/allocate first)' });
  }

  const vehicles = await loadVehicles();
  const check = validatePlan({ trips: proposal.trips, vehicles });
  if (!check.feasible) {
    return res.status(422).json({ error: 'plan failed hard validation', violations: check.violations });
  }

  const vehicleRows = await prisma.vehicle.findMany();
  const vIdMap = Object.fromEntries(vehicleRows.map((v) => [v.vehicleId, v.id]));

  // Sequential writes instead of an interactive transaction: Supabase production runs through
  // the transaction-mode pooler (PgBouncer/Supavisor), which does not support session-pinned
  // interactive transactions. Commit is a single dispatcher action and re-commits reset the
  // plan, so per-statement idempotency (below) is sufficient here.
  await prisma.trip.deleteMany({});
  await prisma.tripStop.deleteMany({});
  for (const trip of proposal.trips) {
    const created = await prisma.trip.create({
      data: {
        vehicleId: vIdMap[trip.vehicleId],
        tripNo: trip.tripNo,
        brand: trip.brand,
        district: trip.district,
        depot: trip.depot,
        totalWeight: trip.totalWeight,
        totalVolume: trip.totalVolume,
        estMinutes: trip.estMinutes,
        distanceKm: trip.distanceKm,
        fuelLiters: trip.fuelLiters,
        status: 'planned',
        committedAt: new Date(),
      },
    });
    let seq = 1;
    for (const stop of trip.plannedStops) {
      await prisma.tripStop.create({ data: { tripId: created.id, seq: seq++, orderId: stop.orderId, plannedArrival: stop.plannedArrival } });
      await prisma.order.update({ where: { id: stop.orderId }, data: { status: 'allocated' } });
    }
  }
  // Deferred orders from the proposal are persisted with reason + promise date.
  if (Array.isArray(proposal.deferred)) {
    for (const d of proposal.deferred) {
      const promise = nextOperatingDay(date);
      await prisma.order.update({
        where: { id: d.order.id },
        data: { status: 'deferred', deferralReason: d.reason, promiseDate: new Date(`${promise}T00:00:00.000Z`) },
      });
      // Guard so re-commits never duplicate ledger rows for the same order+reason.
      const existing = await prisma.deferralLedger.count({ where: { orderId: d.order.id, reason: d.reason, kept: null } });
      if (existing === 0) {
        await prisma.deferralLedger.create({
          data: { orderId: d.order.id, reason: d.reason, detail: d.detail || '', promiseDate: new Date(`${promise}T00:00:00.000Z`) },
        });
      }
    }
  }

  const trips = await prisma.trip.findMany({ include: { stops: true } });

  // Realtime fan-out: every vehicle with a fresh plan wakes its driver and loader;
  // the dispatcher board and any open hub refresh too.
  publishAll(['dispatcher', 'loader'], 'plan-committed', { date, trips: trips.length });
  for (const t of trips) {
    publish(`driver:${t.vehicleId}`, 'plan-committed', { date, tripId: t.id, tripNo: t.tripNo });
    publish(`loader:${t.vehicleId}`, 'plan-committed', { date, tripId: t.id, tripNo: t.tripNo });
  }

  return res.json({ committed: true, trips: trips.length, deferred: Array.isArray(proposal.deferred) ? proposal.deferred.length : 0 });
});

function nextOperatingDay(date) {
  const d = new Date(`${date}T00:00:00.000Z`);
  for (let i = 1; i <= 7; i++) {
    const cand = new Date(d.getTime() + i * 86400000);
    const iso = cand.toISOString().slice(0, 10);
    // calendar lookup via datasets (loaded lazily to avoid cycles)
    const { getCalendarRow } = require('../travel');
    const row = getCalendarRow(iso);
    if (row && row.isOperating) return iso;
  }
  return date;
}

// POST /api/orders/:id/defer — manual deferral by the dispatcher.
// Replay-safe: repeat defers of an already-deferred order do not double-write ledger rows.
router.post('/orders/:id/defer', requireAuth, requireRole('dispatcher'), writeLimiter, idempotency.middleware, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid order id' });
  const parsed = parseBody({ reason: vEnum(['CAP', 'REF', 'INV']) }, req.body, { allowExtra: true });
  if (!parsed.ok) return res.status(400).json({ error: 'reason must be CAP, REF or INV' });
  const { reason } = parsed.value;
  const detailRaw = isPlainObject(req.body) ? req.body.detail : undefined;
  const detail = typeof detailRaw === 'string' ? detailRaw.slice(0, 500) : '';
  const promiseRaw = isPlainObject(req.body) ? req.body.promiseDate : undefined;
  const promise = typeof promiseRaw === 'string' ? promiseRaw : nextOperatingDay(DEMO_DAY);
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) return res.status(404).json({ error: 'order not found' });

  // Guard so replays (offline queue flush, double-tap) never duplicate ledger rows.
  if (order.status === 'deferred' && order.deferralReason === reason) {
    return res.json({ ok: true, order: shapeOrder(order), alreadyDeferred: true });
  }
  const updated = await prisma.order.update({
    where: { id },
    data: { status: 'deferred', deferralReason: reason, promiseDate: new Date(`${promise}T00:00:00.000Z`) },
  });
  await prisma.deferralLedger.create({
    data: { orderId: id, reason, detail: detail || '', promiseDate: new Date(`${promise}T00:00:00.000Z`) },
  });
  return res.json({ ok: true, order: shapeOrder(updated) });
});

// GET /api/analytics/summary?date=YYYY-MM-DD — real KPIs for the dispatcher analytics screen.
// Delivery performance, capacity disposition and fleet effort for one operating day.
router.get('/analytics/summary', requireAuth, readLimiter, async (req, res) => {
  const date = req.query.date || DEMO_DAY;
  const rows = await loadOrders(date);
  const vehicles = await loadVehicles();

  const byStatus = { queued: 0, allocated: 0, deferred: 0, delivered: 0 };
  for (const o of rows) byStatus[o.status] = (byStatus[o.status] || 0) + 1;

  const orderIds = rows.map((o) => o.id);
  const events = orderIds.length
    ? await prisma.deliveryEvent.findMany({ where: { orderId: { in: orderIds }, type: { in: ['pod', 'issue'] } }, orderBy: { serverTimestamp: 'asc' } })
    : [];

  // On-time: POD inside the outlet's promised window (window strings are HH:MM local).
  const podByOrder = new Map();
  let onTime = 0;
  let pods = 0;
  const minuteOf = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
  const windowEdge = (s, fallback) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
  };
  for (const e of events) {
    if (e.type !== 'pod' || !e.orderId) continue;
    pods += 1;
    const ord = rows.find((o) => o.id === e.orderId);
    if (!ord) continue;
    const t = minuteOf(e.serverTimestamp);
    if (t >= windowEdge(ord.windowOpen, -Infinity) && t <= windowEdge(ord.windowClose, Infinity)) onTime += 1;
  }

  const trips = await prisma.trip.findMany();
  const tripsToday = trips.filter((t) => t.committedAt && t.committedAt >= dayBounds(date).gte && t.committedAt < dayBounds(date).lt);
  const totalFuel = tripsToday.reduce((s, t) => s + (t.fuelLiters || 0), 0);
  const totalKm = tripsToday.reduce((s, t) => s + (t.distanceKm || 0), 0);
  const estMinutes = tripsToday.reduce((s, t) => s + (t.estMinutes || 0), 0);

  const ledger = await prisma.deferralLedger.findMany({ where: { promiseDate: dayBounds(date) } });
  const kept = ledger.filter((l) => l.kept === true).length;
  const broken = ledger.filter((l) => l.kept === false).length;
  const openPromises = ledger.filter((l) => l.kept === null).length;

  return res.json({
    date,
    orders: {
      total: rows.length,
      queued: byStatus.queued,
      allocated: byStatus.allocated,
      deferred: byStatus.deferred,
      delivered: byStatus.delivered,
    },
    delivery: {
      pods,
      onTime,
      late: Math.max(0, pods - onTime),
      onTimePct: pods > 0 ? Math.round((onTime / pods) * 100) : null,
      issues: events.filter((e) => e.type === 'issue').length,
    },
    fleet: {
      vehicles: vehicles.length,
      tripsCommitted: tripsToday.length,
      plannedTrips: trips.filter((t) => t.status === 'planned').length,
      departedTrips: trips.filter((t) => t.status === 'departed').length,
      completedTrips: trips.filter((t) => t.status === 'completed').length,
      totalDistanceKm: Math.round(totalKm * 10) / 10,
      totalFuelL: Math.round(totalFuel * 10) / 10,
      totalEstMinutes: Math.round(estMinutes),
    },
    deferrals: {
      ledgerEntries: ledger.length,
      kept,
      broken,
      openPromises,
    },
  });
});

// GET /api/deferrals — ledger view with promise tracking.
router.get('/deferrals', requireAuth, readLimiter, async (req, res) => {
  const take = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000); // hard cap: no unbounded scans
  const ledger = await prisma.deferralLedger.findMany({
    include: { order: { include: { outlet: true } } },
    orderBy: { promisedAt: 'desc' },
    take,
  });
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
      kept: l.kept,
      deferredYesterday: l.order.deferredYesterday,
    })),
  });
});

module.exports = { router, DEMO_DAY };
