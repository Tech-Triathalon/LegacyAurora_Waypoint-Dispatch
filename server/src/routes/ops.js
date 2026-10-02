// Operational routes: manifests for driver/loader, offline sync batch (idempotent),
// shortage flags, store-manager timeline + receipt, telemetry outage simulation, health.
const express = require('express');
const prisma = require('../prisma');
const { publish } = require('../realtime');
const { requireAuth, requireRole } = require('../auth');
const { parseBodyPartial, vNumber, vString, vEnum, vBool, isPlainObject } = require('../validate');
const { createRateLimiter } = require('../security');
const idempotency = require('../idempotency');

const router = express.Router();

const readLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 240 });
const syncLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 }); // batch sync bursts after offline spells

// Drive trip + vehicle lifecycle off driver events:
//   departed  → trip.loading → departed (first leg), vehicle.assigned
//   pod (last stop) → trip.completed, vehicle.available again
async function advanceTripLifecycle(vehicleNumericId, type) {
  if (!vehicleNumericId || !['departed', 'arrived', 'pod'].includes(type)) return;
  try {
    const trips = await prisma.trip.findMany({ where: { vehicleId: vehicleNumericId }, include: { stops: { include: { order: true } } } });
    if (trips.length === 0) return;
    const active = trips.find((t) => t.status === 'departed' || t.status === 'loading') || trips.find((t) => t.status === 'planned') || trips[trips.length - 1];
    const patch = {};
    if (type === 'departed') {
      patch.status = 'departed';
      patch.vehicle = 'assigned';
    } else if (type === 'arrived') {
      patch.status = 'departed';
    } else if (type === 'pod') {
      const remaining = active.stops.filter((s) => s.order && s.order.status !== 'delivered').length;
      if (remaining === 0) {
        patch.status = 'completed';
        patch.vehicle = 'available';
      }
    }
    if (patch.status && active.status !== patch.status) {
      await prisma.trip.update({ where: { id: active.id }, data: { status: patch.status } });
      publish('dispatcher', 'trip-status', { tripId: active.id, vehicleId: vehicleNumericId, status: patch.status });
    }
    if (patch.vehicle) {
      const veh = await prisma.vehicle.findUnique({ where: { id: vehicleNumericId } });
      if (veh && veh.status !== patch.vehicle) {
        await prisma.vehicle.update({ where: { id: vehicleNumericId }, data: { status: patch.vehicle } });
        publish('dispatcher', 'vehicle-status', { vehicleId: vehicleNumericId, vehicleCode: veh.vehicleId, status: patch.vehicle });
      }
    }
  } catch (err) {
    console.error('[lifecycle]', err.code || '', err.message);
  }
}

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
// GET /api/trips — committed trips for all vehicles (dispatcher live runs board).
router.get('/trips', requireAuth, readLimiter, async (req, res) => {
  const trips = await prisma.trip.findMany({ include: { stops: { include: { order: true } }, vehicle: true } });
  trips.sort((a, b) => String(a.vehicle ? a.vehicle.vehicleId : '').localeCompare(String(b.vehicle ? b.vehicle.vehicleId : '')) || a.tripNo - b.tripNo);
  return res.json({ trips: trips.map(shapeTrip) });
});

router.get('/trips/for-driver', requireAuth, requireRole('driver'), readLimiter, async (req, res) => {
  const vehicle = await vehicleForUser(req.user);
  if (!vehicle) return res.status(404).json({ error: 'no vehicle assigned to driver' });
  const trips = await prisma.trip.findMany({
    where: { vehicleId: vehicle.id },
    include: { stops: { include: { order: true } }, vehicle: true },
    orderBy: { tripNo: 'asc' },
  });
  return res.json({ vehicle: vehicle.vehicleId, vehicleNumericId: vehicle.id, telemetryStale: vehicle.telemetryStale, trips: trips.map(shapeTrip) });
});

// GET /api/trips/:vehicleCode — loader manifest by vehicle code.
router.get('/trips/:vehicleCode', requireAuth, readLimiter, async (req, res) => {
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
// Drivers and loaders both sync here (loaded/departed/pod vs loaded dock events).
router.post('/events/batch', requireAuth, requireRole('driver', 'loader'), syncLimiter, async (req, res) => {
  const events = (req.body && Array.isArray(req.body.events)) ? req.body.events : [];
  if (events.length === 0) return res.status(400).json({ error: 'events[] required' });
  if (events.length > 200) return res.status(413).json({ error: 'batch too large (max 200)' });
  // Sanitize each event up-front: types are enum-checked, strings bounded, payload object-shaped.
  const VALID = ['loaded', 'departed', 'arrived', 'pod', 'issue', 'receipt'];
  const results = [];
  const seen = new Set();

  for (const raw of events) {
    const e = {
      eventId: raw && typeof raw.eventId === 'string' ? raw.eventId.slice(0, 64) : null,
      type: raw && VALID.includes(raw.type) ? raw.type : null,
      orderId: raw && Number.isFinite(Number(raw.orderId)) ? Number(raw.orderId) : null,
      vehicleId: raw && Number.isFinite(Number(raw.vehicleId)) ? Number(raw.vehicleId) : null,
      payload: (raw && raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload))
        ? { ...raw.payload, lat: Number.isFinite(Number(raw.payload.lat)) ? Number(raw.payload.lat) : undefined, lng: Number.isFinite(Number(raw.payload.lng)) ? Number(raw.payload.lng) : undefined }
        : {},
      clientTimestamp: raw && raw.clientTimestamp ? raw.clientTimestamp : Date.now(),
    };
    if (!e.eventId || !e.type) {
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
          orderId: e.orderId,
          vehicleId: e.vehicleId,
          payload: e.payload,
          clientTimestamp: new Date(e.clientTimestamp || Date.now()),
          syncedFlag: true,
        },
      });
      // Completed PODs bind to outlets, not sequence: POD arrives → order delivered (never re-mutated by re-sequencing).
      if (e.type === 'pod' && e.orderId) {
        await prisma.order.update({ where: { id: e.orderId }, data: { status: 'delivered' } }).catch(() => {});
      }
      await advanceTripLifecycle(e.vehicleId, e.type);
      results.push({ eventId: e.eventId, status: 'accepted' });

      // Realtime fan-out: dispatcher sees everything; the outlet behind the
      // order sees its own delivery progress. Flags stay dispatcher-side.
      let outletId = null;
      if (e.orderId) {
        const ord = await prisma.order.findUnique({ where: { id: e.orderId } }).catch(() => null);
        outletId = ord ? ord.outletId : null;
      }
      publish('dispatcher', 'driver-event', { ...e, outletId });
      if (outletId) publish(`store:${outletId}`, 'driver-event', e);
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
// Accepts `clientRef` for replay-safe offline queue flushes.
router.post('/flags', requireAuth, requireRole('loader'), syncLimiter, idempotency.middleware, async (req, res) => {
  const parsed = parseBodyPartial({
    orderId: vNumber({ min: 1, max: 10000000, int: true }),
    qty: vNumber({ min: 0, max: 100000, int: true }),
  }, req.body);
  if (!parsed.ok) return res.status(400).json({ error: 'invalid flag fields', detail: parsed.errors });
  const { orderId, qty } = parsed.value;
  const itemDesc = typeof req.body.itemDesc === 'string' ? req.body.itemDesc.slice(0, 300) : null;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.slice(0, 120) : null;
  if (!orderId || !itemDesc || !reason) {
    return res.status(400).json({ error: 'orderId, itemDesc and reason required' });
  }
  const photoBase64 = typeof req.body.photoBase64 === 'string' ? req.body.photoBase64 : null;
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
  const ord = await prisma.order.findUnique({ where: { id: Number(orderId) } }).catch(() => null);
  publish('dispatcher', 'shortage-flagged', {
    id: flag.id, orderId: flag.orderId, itemDesc: flag.itemDesc, qty: flag.qty, reason: flag.reason,
    outletId: ord ? ord.outletId : null, status: flag.status, createdBy: flag.createdBy,
  });
  if (ord) publish(`store:${ord.outletId}`, 'shortage-flagged', { orderId: flag.orderId, itemDesc: flag.itemDesc, qty: flag.qty, reason: flag.reason });
  return res.json({ ok: true, flag: { id: flag.id, status: flag.status } });
});

// GET /api/flags — open flags for matching at store receipt.
router.get('/flags', requireAuth, readLimiter, async (req, res) => {
  const take = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
  const flags = await prisma.shortageFlag.findMany({ include: { order: true }, orderBy: { createdAt: 'desc' }, take });
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
// Managers are scoped to their own outlet; dispatcher/hub may read any.
router.get('/outlet/:id/timeline', requireAuth, readLimiter, async (req, res) => {
  const outletId = String(req.params.id || '').slice(0, 32);
  if (req.user.role === 'manager') {
    const u = await prisma.user.findUnique({ where: { username: req.user.username }, include: { outlet: true } });
    if (!u || !u.outlet || u.outlet.outletId !== outletId) {
      return res.status(403).json({ error: 'managers can only view their own outlet timeline' });
    }
  }
  const orders = await prisma.order.findMany({ where: { outletId }, include: { outlet: true } });
  const orderIds = orders.map((o) => o.id);
  const events = await prisma.deliveryEvent.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: { serverTimestamp: 'asc' },
    take: 1000,
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
// Accepts `clientRef` for replay-safe offline queue flushes.
router.post('/receipt', requireAuth, requireRole('manager'), syncLimiter, idempotency.middleware, async (req, res) => {
  const parsed = parseBodyPartial({ orderId: vNumber({ min: 1, max: 10000000, int: true }) }, req.body);
  if (!parsed.ok) return res.status(400).json({ error: 'orderId required' });
  const orderId = parsed.value.orderId;
  const claimRaw = isPlainObject(req.body) ? req.body.claim : undefined;
  const claim = typeof claimRaw === 'string' ? claimRaw.slice(0, 40) : undefined;
  const qtyDeltaRaw = isPlainObject(req.body) ? req.body.qtyDelta : undefined;
  const qtyDelta = Number.isFinite(Number(qtyDeltaRaw)) ? Number(qtyDeltaRaw) : 0;
  const noteRaw = isPlainObject(req.body) ? req.body.note : undefined;
  const note = typeof noteRaw === 'string' ? noteRaw.slice(0, 500) : '';
  await prisma.deliveryEvent.create({
    data: {
      eventId: `receipt-${orderId}-${Date.now()}`,
      type: 'receipt',
      orderId: Number(orderId),
      payload: { claim: claim || 'confirmed', qtyDelta: qtyDelta || 0, note: note || '' },
      syncedFlag: true,
    },
  });
  // Auto-match: if the loader flagged this order, acknowledge the flag.
  const flags = await prisma.shortageFlag.findMany({ where: { orderId: Number(orderId), status: 'open' } });
  for (const f of flags) {
    await prisma.shortageFlag.update({ where: { id: f.id }, data: { status: 'acknowledged' } });
  }
  const ord = await prisma.order.findUnique({ where: { id: Number(orderId) } }).catch(() => null);
  publish('dispatcher', 'receipt-confirmed', { orderId: Number(orderId), claim: claim || 'confirmed', matchedFlags: flags.length, outletId: ord ? ord.outletId : null });
  if (ord) publish(`store:${ord.outletId}`, 'receipt-confirmed', { orderId: Number(orderId), claim: claim || 'confirmed' });
  return res.json({ ok: true, matchedFlags: flags.length, claim: claim || 'confirmed' });
});

// ---- Telemetry outage simulation (dispatcher console toggle, persisted server-side) ----

router.post('/telemetry/outage', requireAuth, requireRole('dispatcher'), readLimiter, async (req, res) => {
  const stale = vBool({})(req.body && req.body.stale);
  const code = vString({ min: 3, max: 24 })(req.body && req.body.vehicleCode);
  if (stale.err || code.err) return res.status(400).json({ error: 'vehicleCode and stale required' });
  const v = await prisma.vehicle.findUnique({ where: { vehicleId: code.value } });
  if (!v) return res.status(404).json({ error: 'vehicle not found' });
  await prisma.vehicle.update({ where: { vehicleId: code.value }, data: { telemetryStale: stale.value } });
  return res.json({ vehicleCode: code.value, telemetryStale: stale.value });
});

// GET /api/telemetry/fleet — fleet board state incl. stale flags.
router.get('/telemetry/fleet', requireAuth, readLimiter, async (req, res) => {
  const vehicles = await prisma.vehicle.findMany({ orderBy: { id: 'asc' } });
  return res.json({
    fleet: vehicles.map((v) => ({ vehicleCode: v.vehicleId, depot: v.depot, temp: v.temp, type: v.type, telemetryStale: v.telemetryStale, status: v.status })),
  });
});

// GET /api/flags/geo — latest GPS fix per vehicle (from departed/arrived/pod event payloads).
router.get('/flags/geo', requireAuth, readLimiter, async (req, res) => {
  const events = await prisma.deliveryEvent.findMany({
    where: { type: { in: ['departed', 'arrived', 'pod'] } },
    orderBy: { serverTimestamp: 'desc' },
    take: 400,
  });
  const latest = new Map(); // vehicleId → newest event carrying coordinates
  for (const e of events) {
    const vid = e.vehicleId || (e.payload && e.payload.vehicleId);
    const lat = e.payload && Number(e.payload.lat);
    const lng = e.payload && Number(e.payload.lng);
    if (vid && Number.isFinite(lat) && Number.isFinite(lng) && !latest.has(vid)) {
      latest.set(vid, { vehicleId: vid, type: e.type, orderId: e.orderId, lat, lng, at: e.serverTimestamp });
    }
  }
  return res.json({ positions: Array.from(latest.values()) });
});

// GET /api/health — liveness for uptime checks + CI smoke + hub status panel.
// Public: reveals nothing sensitive; db.latencyMs powers the hub system dashboard.
router.get('/health', async (req, res) => {
  const { dbHealth } = require('../prisma');
  const db = await dbHealth();
  return res.json({ ok: true, service: 'waypoint-api', time: new Date().toISOString(), db });
});

module.exports = { router };
