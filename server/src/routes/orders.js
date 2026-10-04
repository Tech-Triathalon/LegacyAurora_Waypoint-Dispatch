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
  brand: vEnum(['Fresh', 'Style', 'Tech', 'fresh', 'style', 'tech'], { optional: true }),
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
  const { brand, tempRequirement, units, weightKg, volumeM3, orderDate, windowOpen, windowClose } = parsed.value;
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
  const chosenBrand = brand ? (brand.charAt(0).toUpperCase() + brand.slice(1).toLowerCase()) : outlet.brand;

  const order = await prisma.order.create({
    data: {
      outletId: outlet.outletId,
      brand: chosenBrand,
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

  // Wake the dispatcher desk — a new drop landed in their queue in real time.
  publish('dispatcher', 'new-order', {
    id: order.id, 
    orderRef: `ORD-${String(order.id).padStart(4, '0')}`, 
    outletId: outlet.outletId,
    brand: order.brand, 
    district: order.district, 
    tempRequirement: order.tempRequirement,
    units: order.units, 
    weightKg: order.weightKg, 
    volumeM3: order.volumeM3,
    windowOpen: order.windowOpen, 
    windowClose: order.windowClose, 
    status: order.status, 
    note: note || null,
  });

  // Notify store subscribers as well
  publish(`store:${outlet.outletId}`, 'new-order', {
    id: order.id,
    orderRef: `ORD-${String(order.id).padStart(4, '0')}`,
    brand: order.brand,
    tempRequirement: order.tempRequirement,
    units: order.units,
    status: order.status,
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

// Plan difference state tracking across commits
let lastPlanSnapshots = {};
let lastPlanDiffs = {};

function computePlanDiff(prevTrips, newTrips, newDeferred, depot) {
  if (!prevTrips || prevTrips.length === 0) {
    return {
      hasChanges: false,
      message: 'Initial plan baseline established. No prior changes recorded.',
      timestamp: new Date().toISOString(),
      changes: [
        { type: 'baseline', description: `Initial baseline loaded: ${newTrips.length} runs allocated for ${depot || 'all depots'}.`, severity: 'green' }
      ]
    };
  }

  const changes = [];
  const prevOrderMap = new Map(); // orderId -> { vehicleCode, tripNo, seq, weight, brand, depot }
  const prevVehicleWeight = new Map();

  for (const t of prevTrips) {
    if (depot && depot !== 'all' && t.depot !== depot) continue;
    const vCode = t.vehicle ? t.vehicle.vehicleId : `VEH-${t.vehicleId}`;
    prevVehicleWeight.set(vCode, (prevVehicleWeight.get(vCode) || 0) + (t.totalWeight || 0));
    for (const s of (t.stops || [])) {
      prevOrderMap.set(s.orderId, {
        vehicleCode: vCode,
        tripNo: t.tripNo,
        seq: s.seq,
        weight: (s.order && s.order.weightKg) || 0,
        brand: (s.order && s.order.brand) || t.brand,
        outletId: (s.order && s.order.outletId) || null,
        depot: t.depot,
      });
    }
  }

  const newOrderMap = new Map();
  const newVehicleWeight = new Map();

  for (const t of newTrips) {
    if (depot && depot !== 'all' && t.depot !== depot) continue;
    const vCode = t.vehicleId;
    newVehicleWeight.set(vCode, (newVehicleWeight.get(vCode) || 0) + (t.totalWeight || 0));
    for (const s of (t.plannedStops || [])) {
      newOrderMap.set(s.orderId, {
        vehicleCode: vCode,
        tripNo: t.tripNo,
        seq: s.seq || 1,
        weight: s.weightKg || 0,
        brand: t.brand,
        outletId: s.outletId,
        depot: t.depot,
      });
    }
  }

  // 1. Check for newly added orders
  for (const [orderId, info] of newOrderMap.entries()) {
    if (!prevOrderMap.has(orderId)) {
      changes.push({
        type: 'added',
        orderId,
        orderRef: `ORD-${String(orderId).padStart(4, '0')}`,
        vehicleCode: info.vehicleCode,
        description: `Order ORD-${String(orderId).padStart(4, '0')} (${info.outletId || ''}) added to ${info.vehicleCode}`,
        severity: 'green'
      });
    } else {
      const prev = prevOrderMap.get(orderId);
      if (prev.vehicleCode !== info.vehicleCode) {
        changes.push({
          type: 'reassigned',
          orderId,
          orderRef: `ORD-${String(orderId).padStart(4, '0')}`,
          fromVehicle: prev.vehicleCode,
          toVehicle: info.vehicleCode,
          description: `Order ORD-${String(orderId).padStart(4, '0')} reassigned: ${prev.vehicleCode} ➔ ${info.vehicleCode}`,
          severity: 'amber'
        });
      } else if (prev.seq !== info.seq) {
        changes.push({
          type: 'sequence_shift',
          orderId,
          orderRef: `ORD-${String(orderId).padStart(4, '0')}`,
          vehicleCode: info.vehicleCode,
          description: `Drop sequence updated on ${info.vehicleCode}: Stop #${prev.seq} ➔ #${info.seq}`,
          severity: 'amber'
        });
      }
    }
  }

  // 2. Check for removed orders
  for (const [orderId, info] of prevOrderMap.entries()) {
    if (!newOrderMap.has(orderId)) {
      const isDef = (newDeferred || []).some(d => d.order && d.order.id === orderId);
      changes.push({
        type: isDef ? 'deferred' : 'removed',
        orderId,
        orderRef: `ORD-${String(orderId).padStart(4, '0')}`,
        vehicleCode: info.vehicleCode,
        description: isDef 
          ? `Order ORD-${String(orderId).padStart(4, '0')} deferred to next cycle`
          : `Order ORD-${String(orderId).padStart(4, '0')} removed from ${info.vehicleCode}`,
        severity: isDef ? 'amber' : 'black'
      });
    }
  }

  // 3. Check for vehicle weight changes
  for (const [vCode, newW] of newVehicleWeight.entries()) {
    const oldW = prevVehicleWeight.get(vCode) || 0;
    const delta = Math.round(newW - oldW);
    if (Math.abs(delta) > 5) {
      changes.push({
        type: 'weight_adj',
        vehicleCode: vCode,
        deltaKg: delta,
        description: `${vCode} payload weight adjusted: ${delta > 0 ? '+' : ''}${delta} kg (New: ${Math.round(newW)} kg)`,
        severity: delta > 0 ? 'green' : 'black'
      });
    }
  }

  const hasChanges = changes.length > 0;
  return {
    hasChanges,
    message: hasChanges ? `${changes.length} change(s) detected since last dispatch plan` : 'No change in plan.',
    timestamp: new Date().toISOString(),
    changes
  };
}

// GET /api/plan/diff?depot=Peliyagoda|Kandy|all — returns dynamic plan diff
router.get('/plan/diff', requireAuth, readLimiter, async (req, res) => {
  const depot = req.query.depot || 'Peliyagoda';
  const diff = lastPlanDiffs[depot] || lastPlanDiffs['all'];
  if (diff) {
    return res.json(diff);
  }
  return res.json({
    hasChanges: false,
    message: 'No change in plan.',
    timestamp: new Date().toISOString(),
    changes: []
  });
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

  // Capture previous plan snapshot before deleting for dynamic diffing
  const prevTrips = await prisma.trip.findMany({
    include: { stops: { include: { order: true } }, vehicle: true },
  });

  const vehicleRows = await prisma.vehicle.findMany();
  const vIdMap = Object.fromEntries(vehicleRows.map((v) => [v.vehicleId, v.id]));

  // Compute real plan diffs
  lastPlanDiffs['all'] = computePlanDiff(prevTrips, proposal.trips, proposal.deferred, 'all');
  lastPlanDiffs['Peliyagoda'] = computePlanDiff(prevTrips, proposal.trips, proposal.deferred, 'Peliyagoda');
  lastPlanDiffs['Kandy'] = computePlanDiff(prevTrips, proposal.trips, proposal.deferred, 'Kandy');

  // Sequential writes instead of an interactive transaction: Supabase production runs through
  // the transaction-mode pooler (PgBouncer/Supavisor), which does not support session-pinned
  // interactive transactions. Commit is a single dispatcher action and re-commits reset the
  // plan, so per-statement idempotency (below) is sufficient here.
  await prisma.tripStop.deleteMany({});
  await prisma.trip.deleteMany({});

  const allStopsToCreate = [];
  const allocatedOrderIds = [];

  for (const trip of proposal.trips) {
    const vNumericId = vIdMap[trip.vehicleId];
    if (!vNumericId) continue;
    const created = await prisma.trip.create({
      data: {
        vehicleId: vNumericId,
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
    for (const stop of (trip.plannedStops || [])) {
      if (stop.orderId) {
        allStopsToCreate.push({
          tripId: created.id,
          seq: seq++,
          orderId: stop.orderId,
          plannedArrival: stop.plannedArrival || '08:00',
        });
        allocatedOrderIds.push(stop.orderId);
      }
    }
  }

  if (allStopsToCreate.length > 0) {
    await prisma.tripStop.createMany({ data: allStopsToCreate });
  }

  if (allocatedOrderIds.length > 0) {
    await prisma.order.updateMany({
      where: { id: { in: allocatedOrderIds } },
      data: { status: 'allocated' },
    });
  }

  // Deferred orders from the proposal are persisted with reason + promise date.
  if (Array.isArray(proposal.deferred) && proposal.deferred.length > 0) {
    const promiseIso = nextOperatingDay(date);
    const promiseDate = new Date(`${promiseIso}T00:00:00.000Z`);
    for (const d of proposal.deferred) {
      if (d.order && d.order.id) {
        await prisma.order.update({
          where: { id: d.order.id },
          data: { status: 'deferred', deferralReason: d.reason, promiseDate },
        });
        const existing = await prisma.deferralLedger.count({ where: { orderId: d.order.id, reason: d.reason, kept: null } });
        if (existing === 0) {
          await prisma.deferralLedger.create({
            data: { orderId: d.order.id, reason: d.reason, detail: d.detail || '', promiseDate },
          });
        }
      }
    }
  }

  const trips = await prisma.trip.findMany({ include: { stops: true } });

  // Realtime fan-out: every vehicle with a fresh plan wakes its driver and loader;
  // the dispatcher board and any open hub refresh too.
  publishAll(['dispatcher', 'loader'], 'plan-committed', { date, trips: trips.length, diffSummary: lastPlanDiffs['all'].message });
  for (const t of trips) {
    publish(`driver:${t.vehicleId}`, 'plan-committed', { date, tripId: t.id, tripNo: t.tripNo });
    publish(`loader:${t.vehicleId}`, 'plan-committed', { date, tripId: t.id, tripNo: t.tripNo });
  }

  return res.json({
    committed: true,
    trips: trips.length,
    deferred: Array.isArray(proposal.deferred) ? proposal.deferred.length : 0,
    planDiff: lastPlanDiffs['all']
  });
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

// POST /api/orders/:id/allocate — manually allocate an order to a vehicle, dock bay, day, and trip.
router.post('/orders/:id/allocate', requireAuth, requireRole('dispatcher'), writeLimiter, idempotency.middleware, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid order id' });
  
  const { vehicleCode, vehicleId, dockBay, date, tripNo } = req.body || {};
  const targetDate = date || DEMO_DAY;
  const targetTripNo = Number(tripNo) || 1;
  const targetBay = dockBay || 'Bay 2';

  const order = await prisma.order.findUnique({ where: { id }, include: { outlet: true } });
  if (!order) return res.status(404).json({ error: 'order not found' });

  // Resolve vehicle
  let vehicle = null;
  if (vehicleCode) {
    vehicle = await prisma.vehicle.findUnique({ where: { vehicleId: vehicleCode } });
  } else if (vehicleId) {
    vehicle = await prisma.vehicle.findUnique({ where: { id: Number(vehicleId) } });
  } else {
    vehicle = await prisma.vehicle.findFirst({
      where: {
        depot: order.depot || 'Peliyagoda',
        temp: order.tempRequirement === 'chilled' ? 'reefer' : undefined,
      },
    });
  }

  if (!vehicle) {
    return res.status(404).json({ error: 'no matching vehicle found for allocation' });
  }

  // Find or create trip for this vehicle and date
  let trip = await prisma.trip.findFirst({
    where: {
      vehicleId: vehicle.id,
      tripNo: targetTripNo,
    },
    include: { stops: true },
  });

  if (!trip) {
    trip = await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        tripNo: targetTripNo,
        brand: order.brand,
        district: order.district,
        depot: order.depot || vehicle.depot,
        totalWeight: order.weightKg,
        totalVolume: order.volumeM3,
        estMinutes: 120,
        distanceKm: 35.0,
        fuelLiters: 8.5,
        status: 'planned',
        committedAt: new Date(),
      },
      include: { stops: true },
    });
  } else {
    await prisma.trip.update({
      where: { id: trip.id },
      data: {
        totalWeight: (trip.totalWeight || 0) + order.weightKg,
        totalVolume: Math.round(((trip.totalVolume || 0) + order.volumeM3) * 10) / 10,
        status: trip.status === 'completed' ? 'planned' : trip.status,
      },
    });
  }

  // Remove existing stop if any for this order
  await prisma.tripStop.deleteMany({ where: { orderId: id } });

  const nextSeq = (trip.stops ? trip.stops.length : 0) + 1;
  await prisma.tripStop.create({
    data: {
      tripId: trip.id,
      seq: nextSeq,
      orderId: id,
      plannedArrival: order.windowOpen || '08:30',
    },
  });

  // Update order status to allocated
  const updatedOrder = await prisma.order.update({
    where: { id },
    data: {
      status: 'allocated',
      deferralReason: null,
    },
  });

  const eventPayload = {
    orderId: id,
    orderRef: `ORD-${String(id).padStart(4, '0')}`,
    outletId: order.outletId,
    brand: order.brand,
    vehicleCode: vehicle.vehicleId,
    vehicleId: vehicle.id,
    dockBay: targetBay,
    date: targetDate,
    tripNo: targetTripNo,
    allocatedBy: (req.user && req.user.name) || 'Dispatcher',
    allocatedAt: new Date().toISOString(),
  };

  // Record delivery event
  await prisma.deliveryEvent.create({
    data: {
      eventId: `alloc-${id}-${Date.now()}`,
      type: 'loaded',
      orderId: id,
      payload: { isAllocation: true, ...eventPayload },
      clientTimestamp: new Date(),
      syncedFlag: true,
    },
  });

  // Realtime fan-out: dispatcher, driver, loader, store manager
  publish('dispatcher', 'order-allocated', eventPayload);
  publish('driver', 'order-allocated', eventPayload);
  publish(`driver:${vehicle.id}`, 'order-allocated', eventPayload);
  publish(`driver:${vehicle.vehicleId}`, 'order-allocated', eventPayload);
  publish('loader', 'order-allocated', eventPayload);
  publish(`loader:${vehicle.id}`, 'order-allocated', eventPayload);
  publish(`loader:${vehicle.vehicleId}`, 'order-allocated', eventPayload);
  if (order.outletId) {
    publish(`store:${order.outletId}`, 'order-allocated', eventPayload);
  }

  return res.json({
    ok: true,
    order: shapeOrder(updatedOrder),
    allocation: eventPayload,
  });
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
