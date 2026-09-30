// Operational routes: manifests for driver/loader, offline sync batch (idempotent),
// shortage flags, store-manager timeline + receipt, telemetry outage simulation, health.
const express = require('express');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const router = express.Router();

// ---- Trips / manifests ----

// Resolve the current user's vehicle (driver) from the JWT.
async function vehicleForUser(user) {
  if (!user || user.role !== 'driver') return null;
  const u = await prisma.user.findUnique({ where: { username: user.username }, include: { vehicle: true } });
  return u ? u.vehicle : null;
}

function shapeTrip(t) {
  return {
    id: t.id,
    vehicleId: t.vehicleId,
    vehicleCode: t.vehicle ? t.vehicle.vehicleId : null,
    tripNo: t.tripNo,
    brand: t.brand,
    district: t.district,
    depot: t.depot,
    totalWeight: t.totalWeight,
    totalVolume: t.totalVolume,
    estMinutes: t.estMinutes,
    distanceKm: t.distanceKm,
    fuelLiters: t.fuelLiters,
    status: t.status,
    stops: t.stops
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({
        seq: s.seq,
        orderId: s.orderId,
        orderRef: `ORD-${String(s.orderId).padStart(4, '0')}`,
        outletId: s.order ? s.order.outletId : null,
        windowOpen: s.order ? s.order.windowOpen : null,
        windowClose: s.order ? s.order.windowClose : null,
        plannedArrival: s.plannedArrival,
        status: s.order ? s.order.status : null,
      })),
  };
}

// GET /api/trips/for-driver — manifest for the logged-in driver's vehicle.
router.get('/trips/for-driver', async (req, res) => {
  const vehicle = await vehicleForUser(req.user);
  if (!vehicle) return res.status(404).json({ error: 'no vehicle assigned to driver' });
  const trips = await prisma.trip.findMany({
    where: { vehicleId: vehicle.id },
    include: { stops: { include: { order: true } }, vehicle: true },
    orderBy: { tripNo: 'asc' },
  });
  return res.json({ vehicle: vehicle.vehicleId, telemetryStale: vehicle.telemetryStale, trips: trips.map(shapeTrip) });
});

// GET /api/trips/:vehicleCode — loader manifest by vehicle code.
router.get('/trips/:vehicleCode', async (req, res) => {
  const v = await prisma.vehicle.findUnique({ where: { vehicleId: req.params.vehicleCode }, include: { user: true } });
  if (!v) return res.status(404).json({ error: 'vehicle not found' });
  const trips = await prisma.trip.findMany({
    where: { vehicleId: v.id },
    include: { stops: { include: { order: true } }, vehicle: true },
    orderBy: { tripNo: 'asc' },
  });
  return res.json({ vehicle: v.vehicleId, trips: trips.map(shapeTrip) });
});

// ---- Offline sync: the idempotent batch endpoint ----

// POST /api/events/batch — accepts {events:[{eventId,type,orderId,payload,clientTimestamp}]}
// Dedupe on eventId (unique constraint): replayed syncs never double-record.
// Returns per-event accepted | duplicate | conflict for the driver's sync drawer.
router.post('/events/batch', async (req, res) => {
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
      await prisma.deliveryEvent.create({
        data: {
          eventId: e.eventId,
          type: e.type,
          orderId: e.orderId ? Number(e.orderId) : null,
          vehicleId: e.vehicleId ? Number(e.vehicleId) : null,
          payload: (e.payload && typeof e.payload === 'object') ? e.payload : {},
          clientTimestamp: new Date(e.clientTimestamp || Date.now()),
          syncedFlag: true,
        },
      });
      // Completed PODs bind to outlets, not sequence: POD arrives → order delivered (never re-mutated by re-sequencing).
      if (e.type === 'pod' && e.orderId) {
        await prisma.order.update({ where: { id: Number(e.orderId) }, data: { status: 'delivered' } }).catch(() => {});
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

// ---- Shortage flags (loader) ----

// POST /api/flags — loader shortage report; photo arrives as compressed base64 (≤300KB).
router.post('/flags', async (req, res) => {
  const { orderId, itemDesc, qty, reason, photoBase64 } = req.body || {};
  if (!orderId || !itemDesc || !reason) {
    return res.status(400).json({ error: 'orderId, itemDesc and reason required' });
  }
  let photoPath = null;
  if (photoBase64) {
    if (photoBase64.length > 400000) return res.status(413).json({ error: 'photo too large (compress to ≤300KB)' });
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    photoPath = `flag-${Date.now()}-${orderId}.jpg`;
    fs.writeFileSync(path.join(dir, photoPath), Buffer.from(photoBase64, 'base64'));
  }
  const flag = await prisma.shortageFlag.create({
    data: { orderId: Number(orderId), itemDesc, qty: Number(qty) || 0, reason, photoPath, createdBy: (req.user && req.user.username) || 'loader' },
  });
  return res.json({ ok: true, flag: { id: flag.id, status: flag.status } });
});

// GET /api/flags — open flags for matching at store receipt.
router.get('/flags', async (req, res) => {
  const flags = await prisma.shortageFlag.findMany({ include: { order: true }, orderBy: { createdAt: 'desc' } });
  return res.json({
    flags: flags.map((f) => ({
      id: f.id, orderId: f.orderId, orderRef: `ORD-${String(f.orderId).padStart(4, '0')}`,
      outletId: f.order.outletId, itemDesc: f.itemDesc, qty: f.qty, reason: f.reason,
      photoPath: f.photoPath, status: f.status,
    })),
  });
});

// ---- Store manager: timeline + receipt ----

// GET /api/outlet/:id/timeline — live delivery timeline for the manager's outlet.
router.get('/outlet/:id/timeline', async (req, res) => {
  const outletId = req.params.id;
  const orders = await prisma.order.findMany({ where: { outletId }, include: { outlet: true } });
  const orderIds = orders.map((o) => o.id);
  const events = await prisma.deliveryEvent.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: { serverTimestamp: 'asc' },
  });
  const deferrals = await prisma.deferralLedger.findMany({
    where: { order: { outletId } },
    include: { order: true },
    orderBy: { promisedAt: 'desc' },
  });
  return res.json({
    outletId,
    orders: orders.map((o) => ({ id: o.id, orderRef: `ORD-${String(o.id).padStart(4, '0')}`, status: o.status, windowOpen: o.windowOpen, windowClose: o.windowClose })),
    events: events.map((e) => ({ type: e.type, orderId: e.orderId, at: e.serverTimestamp, payload: e.payload })),
    deferrals: deferrals.map((d) => ({ reason: d.reason, promiseDate: d.promiseDate, orderRef: `ORD-${String(d.orderId).padStart(4, '0')}` })),
  });
});

// POST /api/receipt — confirm delivery or claim a discrepancy; auto-matches open dock flags.
router.post('/receipt', async (req, res) => {
  const { orderId, claim, qtyDelta, note } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  await prisma.deliveryEvent.create({
    data: {
      eventId: `receipt-${orderId}-${Date.now()}`,
      type: 'receipt',
      orderId: Number(orderId),
      payload: { claim: claim || 'confirmed', qtyDelta: qtyDelta || 0, note: note || '' },
      clientTimestamp: new Date(),
      syncedFlag: true,
    },
  });
  // Auto-match: if the loader flagged this order, acknowledge the flag.
  const flags = await prisma.shortageFlag.findMany({ where: { orderId: Number(orderId), status: 'open' } });
  for (const f of flags) {
    await prisma.shortageFlag.update({ where: { id: f.id }, data: { status: 'acknowledged' } });
  }
  return res.json({ ok: true, matchedFlags: flags.length, claim: claim || 'confirmed' });
});

// ---- Telemetry outage simulation (dispatcher console toggle, persisted server-side) ----

router.post('/telemetry/outage', async (req, res) => {
  const { vehicleCode, stale } = req.body || {};
  const v = await prisma.vehicle.findUnique({ where: { vehicleId: vehicleCode } });
  if (!v) return res.status(404).json({ error: 'vehicle not found' });
  await prisma.vehicle.update({ where: { vehicleId: vehicleCode }, data: { telemetryStale: !!stale } });
  return res.json({ vehicleCode, telemetryStale: !!stale });
});

// GET /api/telemetry/fleet — fleet board state incl. stale flags.
router.get('/telemetry/fleet', async (req, res) => {
  const vehicles = await prisma.vehicle.findMany({ orderBy: { id: 'asc' } });
  return res.json({
    fleet: vehicles.map((v) => ({ vehicleCode: v.vehicleId, depot: v.depot, temp: v.temp, type: v.type, telemetryStale: v.telemetryStale, status: v.status })),
  });
});

// GET /api/health — liveness for uptime checks + CI smoke.
router.get('/health', (req, res) => {
  return res.json({ ok: true, service: 'waypoint-api', time: new Date().toISOString() });
});

module.exports = { router };
