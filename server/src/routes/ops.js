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
    vehicleType: t.vehicle ? t.vehicle.type : 'truck',
    vehicleTemp: t.vehicle ? t.vehicle.temp : 'ambient',
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
        brand: s.order ? s.order.brand : null,
        district: s.order ? s.order.district : null,
        units: s.order ? s.order.units : 0,
        weightKg: s.order ? s.order.weightKg : 0,
        volumeM3: s.order ? s.order.volumeM3 : 0,
        tempRequirement: s.order ? s.order.tempRequirement : 'ambient',
        windowOpen: s.order ? s.order.windowOpen : null,
        windowClose: s.order ? s.order.windowClose : null,
        plannedArrival: s.plannedArrival,
        status: s.order ? s.order.status : null,
      })),
  };
}

// GET /api/trips/for-driver — manifest for the logged-in driver's vehicle.
// GET /api/trips — committed trips for all vehicles (or by ?depot=Peliyagoda|Kandy).
router.get('/trips', requireAuth, readLimiter, async (req, res) => {
  const where = {};
  if (req.query.depot) {
    where.depot = req.query.depot;
  }
  const trips = await prisma.trip.findMany({ where, include: { stops: { include: { order: true } }, vehicle: true } });
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

// ---- Loader Operations: Checklist, Dock Notes, Scan/Weight, Final Check, Day Summary ----

// GET /api/checklist — returns map of checked order item statuses from DB events
router.get('/checklist', requireAuth, readLimiter, async (req, res) => {
  const events = await prisma.deliveryEvent.findMany({
    where: { type: 'loaded' },
    orderBy: { serverTimestamp: 'asc' },
    take: 1000,
  });
  const checkedMap = {};
  for (const e of events) {
    if (e.payload && e.payload.isChecklistItem && e.orderId) {
      checkedMap[e.orderId] = {
        checked: Boolean(e.payload.checked),
        checkedAt: e.serverTimestamp,
        checkedBy: e.payload.checkedBy || 'Loader',
        vehicleCode: e.payload.vehicleCode,
        tripId: e.payload.tripId,
        seq: e.payload.seq,
      };
    }
  }
  return res.json({ checkedMap });
});

// POST /api/checklist/toggle — loader checks/unchecks an item/stop; persists to DB
router.post('/checklist/toggle', requireAuth, requireRole('loader', 'dispatcher'), syncLimiter, async (req, res) => {
  const { orderId, tripId, vehicleCode, checked, seq, bay } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  const isChecked = Boolean(checked);
  const eventId = `chk-${orderId}-${isChecked ? 'on' : 'off'}-${Date.now()}`;
  
  const ord = await prisma.order.findUnique({ where: { id: Number(orderId) } }).catch(() => null);

  await prisma.deliveryEvent.create({
    data: {
      eventId,
      type: 'loaded',
      orderId: Number(orderId),
      payload: {
        isChecklistItem: true,
        checked: isChecked,
        tripId: tripId ? Number(tripId) : null,
        vehicleCode: vehicleCode || null,
        seq: Number(seq) || 1,
        bay: bay || 'Bay 2',
        checkedBy: (req.user && req.user.name) || (req.user && req.user.username) || 'Loader',
      },
      syncedFlag: true,
    },
  });

  // Count total items checked for this trip
  const tripEvents = await prisma.deliveryEvent.findMany({
    where: { type: 'loaded' },
    orderBy: { serverTimestamp: 'asc' },
  });
  const tripCheckedMap = {};
  for (const e of tripEvents) {
    if (e.payload && e.payload.isChecklistItem && e.payload.tripId === Number(tripId)) {
      tripCheckedMap[e.orderId] = Boolean(e.payload.checked);
    }
  }
  const totalChecked = Object.values(tripCheckedMap).filter(Boolean).length;

  publish('dispatcher', 'loader-check', {
    orderId: Number(orderId),
    orderRef: `ORD-${String(orderId).padStart(4, '0')}`,
    outletId: ord ? ord.outletId : null,
    tripId: tripId ? Number(tripId) : null,
    vehicleCode: vehicleCode || null,
    checked: isChecked,
    totalChecked,
    checkedBy: (req.user && req.user.name) || 'Loader',
  });

  return res.json({ ok: true, orderId: Number(orderId), checked: isChecked, totalChecked });
});

// GET /api/dock-notes — retrieve real dock notes from DB
router.get('/dock-notes', requireAuth, readLimiter, async (req, res) => {
  const events = await prisma.deliveryEvent.findMany({
    where: { type: 'loaded' },
    orderBy: { serverTimestamp: 'desc' },
    take: 200,
  });
  const notes = [];
  for (const e of events) {
    if (e.payload && e.payload.isDockNote && e.payload.note) {
      notes.push({
        id: e.id,
        note: e.payload.note,
        vehicleCode: e.payload.vehicleCode || 'All Vehicles',
        tripId: e.payload.tripId || null,
        depot: e.payload.depot || 'Peliyagoda',
        author: e.payload.author || 'Dock Loader',
        createdAt: e.serverTimestamp,
        orderId: e.orderId,
      });
    }
  }
  return res.json({ notes });
});

// POST /api/dock-notes — loader or dispatcher saves a dock note; notifies all roles
router.post('/dock-notes', requireAuth, requireRole('loader', 'dispatcher'), syncLimiter, async (req, res) => {
  const { tripId, orderId, vehicleCode, depot, note, author } = req.body || {};
  if (!note || typeof note !== 'string' || !note.trim()) {
    return res.status(400).json({ error: 'note content required' });
  }
  const cleanNote = note.trim().slice(0, 1000);
  const authorName = author || (req.user && req.user.name) || (req.user && req.user.username) || 'Loader';
  const eventId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  await prisma.deliveryEvent.create({
    data: {
      eventId,
      type: 'loaded',
      orderId: orderId ? Number(orderId) : null,
      payload: {
        isDockNote: true,
        note: cleanNote,
        vehicleCode: vehicleCode || null,
        tripId: tripId ? Number(tripId) : null,
        depot: depot || 'Peliyagoda',
        author: authorName,
      },
      syncedFlag: true,
    },
  });

  const notePayload = {
    note: cleanNote,
    vehicleCode: vehicleCode || 'Dock Bay',
    tripId: tripId ? Number(tripId) : null,
    depot: depot || 'Peliyagoda',
    author: authorName,
    createdAt: new Date().toISOString(),
  };

  publish('dispatcher', 'dock-note-added', notePayload);
  publish('driver', 'dock-note-added', notePayload);
  publish('loader', 'dock-note-added', notePayload);

  return res.json({ ok: true, note: notePayload });
});

// POST /api/trips/scan-weight — record scan verification and weight measurement
router.post('/trips/scan-weight', requireAuth, requireRole('loader', 'dispatcher'), syncLimiter, async (req, res) => {
  const { tripId, orderId, scannedCode, actualWeightKg, plannedWeightKg, bay } = req.body || {};
  if (!orderId || actualWeightKg === undefined) {
    return res.status(400).json({ error: 'orderId and actualWeightKg required' });
  }
  const actW = Number(actualWeightKg);
  const planW = Number(plannedWeightKg) || actW;
  const deltaKg = Math.round((actW - planW) * 10) / 10;
  const isDiscrepancy = planW > 0 && Math.abs(deltaKg) > (0.05 * planW);

  const eventId = `scan-${orderId}-${Date.now()}`;
  await prisma.deliveryEvent.create({
    data: {
      eventId,
      type: 'loaded',
      orderId: Number(orderId),
      payload: {
        isScanWeight: true,
        tripId: tripId ? Number(tripId) : null,
        scannedCode: scannedCode || `ORD-${String(orderId).padStart(4, '0')}`,
        actualWeightKg: actW,
        plannedWeightKg: planW,
        weightDeltaKg: deltaKg,
        isDiscrepancy,
        bay: bay || 'Bay 2',
        scannedBy: (req.user && req.user.name) || 'Loader',
      },
      syncedFlag: true,
    },
  });

  publish('dispatcher', 'weight-scanned', {
    orderId: Number(orderId),
    orderRef: `ORD-${String(orderId).padStart(4, '0')}`,
    tripId: tripId ? Number(tripId) : null,
    actualWeightKg: actW,
    plannedWeightKg: planW,
    weightDeltaKg: deltaKg,
    isDiscrepancy,
  });

  return res.json({ ok: true, actualWeightKg: actW, plannedWeightKg: planW, weightDeltaKg: deltaKg, isDiscrepancy });
});

// POST /api/trips/:id/final-check — finalize vehicle loading & handoff
router.post('/trips/:id/final-check', requireAuth, requireRole('loader', 'dispatcher'), syncLimiter, async (req, res) => {
  const tripId = Number(req.params.id);
  const { vehicleCode, sealNumber, bay, allLoaded, palletsSecured, balanced, tempChecked, confirmedBy, notes } = req.body || {};

  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { stops: true } });
  if (!trip) return res.status(404).json({ error: 'trip not found' });

  // Update trip status to loading or planned readiness
  await prisma.trip.update({ where: { id: tripId }, data: { status: 'planned' } }).catch(() => {});

  const eventId = `finchk-${tripId}-${Date.now()}`;
  await prisma.deliveryEvent.create({
    data: {
      eventId,
      type: 'loaded',
      payload: {
        isFinalCheck: true,
        tripId,
        vehicleCode: vehicleCode || (trip.vehicle ? trip.vehicle.vehicleId : null),
        sealNumber: sealNumber || `SEAL-${Math.floor(100000 + Math.random() * 900000)}`,
        bay: bay || 'Bay 2',
        allLoaded: Boolean(allLoaded !== false),
        palletsSecured: Boolean(palletsSecured !== false),
        balanced: Boolean(balanced !== false),
        tempChecked: Boolean(tempChecked !== false),
        confirmedBy: confirmedBy || (req.user && req.user.name) || 'Loader',
        notes: notes || '',
        confirmedAt: new Date().toISOString(),
      },
      syncedFlag: true,
    },
  });

  publish('dispatcher', 'final-check-completed', {
    tripId,
    vehicleCode: vehicleCode || trip.vehicleId,
    confirmedBy: confirmedBy || 'Loader',
    status: 'ready_for_departure',
  });

  publish(`driver:${trip.vehicleId}`, 'final-check-completed', {
    tripId,
    status: 'ready_for_departure',
  });

  return res.json({ ok: true, tripId, status: 'ready_for_departure' });
});

// GET /api/loader/day-summary — computed summary of loading operations
router.get('/loader/day-summary', requireAuth, readLimiter, async (req, res) => {
  const depot = req.query.depot || 'Peliyagoda';
  const where = depot && depot !== 'all' ? { depot } : {};

  const trips = await prisma.trip.findMany({
    where,
    include: { stops: { include: { order: true } }, vehicle: true },
  });

  const totalTrips = trips.length;
  const tripsReleased = trips.filter(t => t.status === 'departed' || t.status === 'completed').length;
  
  let totalOrdersLoaded = 0;
  let totalWeightLoaded = 0;
  let totalVolumeLoaded = 0;

  for (const t of trips) {
    totalWeightLoaded += (t.totalWeight || 0);
    totalVolumeLoaded += (t.totalVolume || 0);
    totalOrdersLoaded += (t.stops ? t.stops.length : 0);
  }

  const flags = await prisma.shortageFlag.findMany({
    where: { status: 'open' },
  });

  const events = await prisma.deliveryEvent.findMany({
    where: { type: 'loaded' },
  });
  const notesCount = events.filter(e => e.payload && e.payload.isDockNote).length;

  return res.json({
    depot: depot || 'All Facilities',
    totalTrips,
    tripsReleased,
    tripsPending: Math.max(0, totalTrips - tripsReleased),
    totalOrdersLoaded,
    totalWeightLoaded: Math.round(totalWeightLoaded),
    totalVolumeLoaded: Math.round(totalVolumeLoaded * 10) / 10,
    shortagesFlagged: flags.length,
    notesCount,
    updatedAt: new Date().toISOString(),
  });
});

// POST /api/loader/day-summary — transmits dock day summary to Dispatcher
router.post('/loader/day-summary', requireAuth, requireRole('loader', 'dispatcher'), syncLimiter, async (req, res) => {
  const { depot, totalTrips, tripsReleased, totalOrdersLoaded, totalWeightLoaded, totalVolumeLoaded, shortagesFlagged, notesCount } = req.body || {};
  
  const payload = {
    depot: depot || 'Peliyagoda',
    totalTrips: Number(totalTrips) || 0,
    tripsReleased: Number(tripsReleased) || 0,
    totalOrdersLoaded: Number(totalOrdersLoaded) || 0,
    totalWeightLoaded: Number(totalWeightLoaded) || 0,
    totalVolumeLoaded: Number(totalVolumeLoaded) || 0,
    shortagesFlagged: Number(shortagesFlagged) || 0,
    notesCount: Number(notesCount) || 0,
    sentAt: new Date().toISOString(),
    sentBy: (req.user && req.user.name) || 'Loader',
  };

  const eventId = `daysum-${Date.now()}`;
  await prisma.deliveryEvent.create({
    data: {
      eventId,
      type: 'loaded',
      payload: { isDaySummary: true, ...payload },
      syncedFlag: true,
    },
  });

  publish('dispatcher', 'loader-day-summary', payload);

  return res.json({ ok: true, summary: payload });
});

// GET /api/health — liveness for uptime checks + CI smoke + hub status panel.
// Public: reveals nothing sensitive; db.latencyMs powers the hub system dashboard.
router.get('/health', async (req, res) => {
  const { dbHealth } = require('../prisma');
  const db = await dbHealth();
  return res.json({ ok: true, service: 'waypoint-api', time: new Date().toISOString(), db });
});

module.exports = { router };

