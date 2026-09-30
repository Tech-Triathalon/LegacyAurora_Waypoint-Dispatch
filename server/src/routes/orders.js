// Orders + planning routes: queue with capacity verdict, allocate (dry-run proposal), commit, defer.
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { allocate } = require('../allocation/engine');
const { validatePlan } = require('../allocation/validate');

const prisma = new PrismaClient();
const router = express.Router();

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
router.get('/orders', async (req, res) => {
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

// POST /api/plan/allocate — dry-run proposal; nothing persisted until commit.
router.post('/plan/allocate', async (req, res) => {
  const date = (req.body && req.body.date) || DEMO_DAY;
  const rows = await loadOrders(date);
  const eligible = rows.filter((o) => o.status === 'queued' || o.status === 'deferred');
  const vehicles = await loadVehicles();
  const result = allocate({ orders: engineOrders(eligible), vehicles, date });
  const planCheck = validatePlan({ trips: result.trips.map((t) => ({ ...t, vehicleId: t.vehicleId })), vehicles });
  return res.json({ date, ...result, planCheck });
});

// POST /api/plan/commit — validate then persist trips + stops; orders become allocated.
router.post('/plan/commit', async (req, res) => {
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
router.post('/orders/:id/defer', async (req, res) => {
  const id = Number(req.params.id);
  const { reason, detail, promiseDate } = req.body || {};
  if (!['CAP', 'REF', 'INV'].includes(reason)) {
    return res.status(400).json({ error: 'reason must be CAP, REF or INV' });
  }
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) return res.status(404).json({ error: 'order not found' });
  const promise = promiseDate || nextOperatingDay(DEMO_DAY);
  const updated = await prisma.order.update({
    where: { id },
    data: { status: 'deferred', deferralReason: reason, promiseDate: new Date(`${promise}T00:00:00.000Z`) },
  });
  await prisma.deferralLedger.create({
    data: { orderId: id, reason, detail: detail || '', promiseDate: new Date(`${promise}T00:00:00.000Z`) },
  });
  return res.json({ ok: true, order: shapeOrder(updated) });
});

// GET /api/deferrals — ledger view with promise tracking.
router.get('/deferrals', async (req, res) => {
  const ledger = await prisma.deferralLedger.findMany({
    include: { order: { include: { outlet: true } } },
    orderBy: { promisedAt: 'desc' },
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
