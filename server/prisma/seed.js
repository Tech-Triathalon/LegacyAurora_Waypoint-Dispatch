// Deterministic seed: loads datasets, generates one overloaded Peliyagoda delivery day
// (2026-06-25 — Thursday, operating, monsoon, payday), verifies with the real engine that
// the day forces deferrals, then writes everything to Postgres.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { loadAll } = require('../src/data/datasets');
const { allocate } = require('../src/allocation/engine');

require('../src/env').loadEnv(); // plain `node prisma/seed.js` gets DATABASE_URL from server/.env

const DEMO_DAY = '2026-06-25';

// Small deterministic PRNG (mulberry32) so the seed is byte-identical on every machine.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260625);
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }
function between(lo, hi) { return lo + rng() * (hi - lo); }
function intBetween(lo, hi) { return Math.floor(between(lo, hi + 1)); }

function buildOrders(datasets) {
  const outlets = datasets.outlets.filter((o) => o.depot === 'Peliyagoda');
  const fresh = outlets.filter((o) => o.brand === 'Fresh');
  const style = outlets.filter((o) => o.brand === 'Style');
  const tech = outlets.filter((o) => o.brand === 'Tech');
  const orders = [];
  let seq = 1;

  function add(outlet, { temp, unitsLo, unitsHi, kgPerUnit, m3PerUnit }) {
    const units = intBetween(unitsLo, unitsHi);
    orders.push({
      outletId: outlet.outletId,
      brand: outlet.brand,
      district: outlet.district,
      depot: outlet.depot,
      dockType: outlet.dockType,
      parkingConstraint: outlet.parkingConstraint,
      tempRequirement: temp,
      units,
      weightKg: Math.round(units * kgPerUnit * between(0.9, 1.1)),
      volumeM3: Math.round(units * m3PerUnit * between(0.9, 1.1) * 10) / 10,
      orderDate: DEMO_DAY,
      windowOpen: outlet.windowOpen,
      windowClose: outlet.windowClose,
      deferredYesterday: false,
    });
    seq += 1;
  }

  // ~30 Fresh orders — a mix of chilled and ambient across Colombo/Gampaha/Kalutara.
  for (let i = 0; i < 30; i++) {
    const outlet = fresh[Math.floor(rng() * fresh.length)];
    const chilled = rng() < 0.45; // ~13-14 chilled orders
    add(outlet, {
      temp: chilled ? 'chilled' : 'ambient',
      unitsLo: chilled ? 120 : 200,
      unitsHi: chilled ? 480 : 700,
      kgPerUnit: chilled ? 0.9 : 0.35,
      m3PerUnit: chilled ? 0.006 : 0.004,
    });
  }

  // ~14 Style orders (heavy/bulky, 09:00-17:00 or mall windows).
  for (let i = 0; i < 14; i++) {
    const outlet = style[Math.floor(rng() * style.length)];
    add(outlet, { temp: 'ambient', unitsLo: 40, unitsHi: 130, kgPerUnit: 4.2, m3PerUnit: 0.05 });
  }

  // ~12 Tech orders (dense, high value).
  for (let i = 0; i < 12; i++) {
    const outlet = tech[Math.floor(rng() * tech.length)];
    add(outlet, { temp: 'ambient', unitsLo: 20, unitsHi: 70, kgPerUnit: 2.8, m3PerUnit: 0.015 });
  }

  // Two deliberate consecutive-deferral candidates (deferredYesterday=1).
  const pre1 = fresh[Math.floor(rng() * fresh.length)];
  add(pre1, { temp: 'chilled', unitsLo: 400, unitsHi: 520, kgPerUnit: 0.9, m3PerUnit: 0.006 });
  orders[orders.length - 1].deferredYesterday = true;
  const pre2 = style[Math.floor(rng() * style.length)];
  add(pre2, { temp: 'ambient', unitsLo: 100, unitsHi: 160, kgPerUnit: 4.2, m3PerUnit: 0.05 });
  orders[orders.length - 1].deferredYesterday = true;

  // Assign stable deterministic ids for engine run + reference.
  orders.forEach((o, i) => { o.id = i + 1; o.orderRef = `ORD-${String(i + 1).padStart(4, '0')}`; });
  return orders;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('Loading datasets...');
    const datasets = loadAll();
    const cal = datasets.calendar[DEMO_DAY];
    if (!cal || !cal.isOperating) throw new Error(`Demo day ${DEMO_DAY} is not an operating day in calendar.csv`);

    console.log('Verifying the demo day forces deferrals (dry-run engine)...');
    const orders = buildOrders(datasets); // build ONCE — RNG is sequential; dry-run must match insert
    const dry = allocate({ orders, vehicles: datasets.vehicles, date: DEMO_DAY });
    if (dry.deferred.length === 0) throw new Error('Seed day failed to produce deferrals — adjust order volumes');
    if (!dry.trips.every((t) => t.feasible)) throw new Error('Engine produced infeasible trips on the seed day');
    console.log(`Dry-run OK: ${dry.trips.length} feasible trips, ${dry.deferred.length} deferrals (demo storyline intact)`);

    console.log('Clearing existing demo data...');
    await prisma.deferralLedger.deleteMany({});
    await prisma.shortageFlag.deleteMany({});
    await prisma.deliveryEvent.deleteMany({});
    await prisma.tripStop.deleteMany({});
    await prisma.trip.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.vehicle.deleteMany({});
    await prisma.outlet.deleteMany({});

    console.log('Inserting outlets + vehicles...');
    await prisma.outlet.createMany({ data: datasets.outlets });
    await prisma.vehicle.createMany({
      data: datasets.vehicles.map((v) => ({
        vehicleId: v.vehicleId, type: v.type, temp: v.temp, weightCapKg: v.weightCapKg,
        volumeCapM3: v.volumeCapM3, fuelType: v.fuelType, kmPerL: v.kmPerL,
        weeklyFuelQuotaL: v.weeklyFuelQuotaL, depot: v.depot,
      })),
    });

    console.log('Inserting orders...');
    await prisma.order.createMany({
      data: orders.map((o) => ({
        outletId: o.outletId, brand: o.brand, district: o.district, depot: o.depot,
        tempRequirement: o.tempRequirement, units: o.units, weightKg: o.weightKg,
        volumeM3: o.volumeM3, orderDate: new Date(`${DEMO_DAY}T00:00:00.000Z`),
        windowOpen: o.windowOpen, windowClose: o.windowClose,
        deferredYesterday: o.deferredYesterday, status: 'queued',
      })),
    });

    const dbVehicles = await prisma.vehicle.findMany();
    const vIdMap = Object.fromEntries(dbVehicles.map((v) => [v.vehicleId, v.id]));
    const dbOrders = await prisma.order.findMany({ orderBy: { id: 'asc' } });
    const orderIdMap = Object.fromEntries(orders.map((o, idx) => [o.id, dbOrders[idx] ? dbOrders[idx].id : dbOrders[0].id]));

    console.log('Creating initial baseline committed trips & stops...');
    for (let i = 0; i < Math.min(dry.trips.length, 6); i++) {
      const dt = dry.trips[i];
      const createdTrip = await prisma.trip.create({
        data: {
          vehicleId: vIdMap[dt.vehicleId] || dbVehicles[i % dbVehicles.length].id,
          tripNo: dt.tripNo,
          brand: dt.brand,
          district: dt.district,
          depot: dt.depot,
          totalWeight: dt.totalWeight,
          totalVolume: dt.totalVolume,
          estMinutes: dt.estMinutes,
          distanceKm: dt.distanceKm,
          fuelLiters: dt.fuelLiters,
          status: i === 0 ? 'departed' : 'planned',
          committedAt: new Date(`${DEMO_DAY}T06:00:00.000Z`),
        },
      });

      let seq = 1;
      for (const st of dt.plannedStops) {
        const realOrderId = orderIdMap[st.orderId] || dbOrders[0].id;
        await prisma.tripStop.create({
          data: {
            tripId: createdTrip.id,
            seq: seq++,
            orderId: realOrderId,
            plannedArrival: st.plannedArrival || '08:30',
          },
        });
        await prisma.order.update({
          where: { id: realOrderId },
          data: { status: 'allocated' },
        }).catch(() => {});
      }
    }

    console.log('Inserting seed deferral ledger records for pagination demonstration...');
    const defReasons = ['CAP', 'REF', 'INV'];
    for (let i = 0; i < 18; i++) {
      const ord = dbOrders[i % dbOrders.length];
      const r = defReasons[i % defReasons.length];
      const isPast = i > 6;
      const pDate = isPast ? '2026-06-24' : '2026-06-26';
      await prisma.deferralLedger.create({
        data: {
          orderId: ord.id,
          reason: r,
          detail: r === 'REF' ? 'Chilled Reefer Capacity Constraint' : (r === 'CAP' ? 'Axle Weight Payload Limit' : 'Inventory Staging Delay'),
          promiseDate: new Date(`${pDate}T00:00:00.000Z`),
          kept: isPast ? (i % 2 === 0 ? true : false) : null,
          promisedAt: new Date(Date.now() - i * 3600000),
        },
      });
    }

    console.log('Inserting initial shortage flags & dock notes...');
    await prisma.shortageFlag.createMany({
      data: [
        { orderId: dbOrders[0].id, qty: 12, itemDesc: 'Anchor Fresh Milk 1L', reason: 'damaged_pallet', status: 'open', createdBy: 'G. Sloan' },
        { orderId: dbOrders[1].id, qty: 6, itemDesc: 'Highland Butter 200g', reason: 'supplier_short', status: 'open', createdBy: 'G. Sloan' },
        { orderId: dbOrders[2].id, qty: 4, itemDesc: 'Cotton Crew T-Shirts L', reason: 'label_mismatch', status: 'resolved', createdBy: 'G. Sloan' },
      ],
    });

    await prisma.deliveryEvent.create({
      data: {
        eventId: `note-seed-1`,
        type: 'loaded',
        orderId: dbOrders[0].id,
        payload: {
          isDockNote: true,
          note: 'Dock Bay 2: Chilled pre-cooling verified at 4°C. Pallet straps secured for Mountain Run.',
          vehicleCode: 'VEH035',
          depot: 'Peliyagoda',
          author: 'G. Sloan (Loader)',
        },
        clientTimestamp: new Date(),
        syncedFlag: true,
      },
    });

    console.log('Creating users (dispatch/driver/loader/manager)...');
    const driverVehicle = await prisma.vehicle.findUnique({ where: { vehicleId: 'VEH035' } });
    const managerOutlet = await prisma.outlet.findUnique({ where: { outletId: 'OUT012' } });
    const password = await bcrypt.hash('dispatch123', 10);
    const mkHash = async (p) => (p === 'dispatch123' ? password : bcrypt.hash(p, 10));
    await prisma.user.createMany({
      data: [
        { username: 'dispatcher', passwordHash: await mkHash('dispatch123'), role: 'dispatcher', name: 'A. Patel' },
        { username: 'driver', passwordHash: await mkHash('drive123'), role: 'driver', name: 'Marcus K.', vehicleId: driverVehicle ? driverVehicle.id : null },
        { username: 'loader', passwordHash: await mkHash('load123'), role: 'loader', name: 'G. Sloan' },
        { username: 'manager', passwordHash: await mkHash('manage123'), role: 'manager', name: 'Store Manager Vance', outletId: managerOutlet ? managerOutlet.outletId : null },
      ],
    });

    console.log(`SEED COMPLETE. Total Orders: ${dbOrders.length} | Baseline Trips: 6 | Deferrals: 18 | Shortages: 3`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
