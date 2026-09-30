// Unit tests: hard feasibility rules + engine determinism. Zero external deps (node --test).
const test = require('node:test');
const assert = require('node:assert');
const { validateTrip, validatePlan } = require('../server/src/allocation/validate');
const { allocate, priorityKey } = require('../server/src/allocation/engine');
const datasets = require('../server/src/data/datasets');

const DATE = '2026-06-25';
const vehicles = datasets.loadVehicles();
const outlets = Object.fromEntries(datasets.loadOutlets().map((o) => [o.outletId, o]));

function mkOrder(over = {}) {
  return {
    id: Math.floor(Math.random() * 1e6),
    orderRef: 'TEST',
    outletId: 'OUT001',
    brand: 'Fresh',
    district: 'Colombo',
    depot: 'Peliyagoda',
    tempRequirement: 'ambient',
    units: 100,
    weightKg: 300,
    volumeM3: 1.5,
    orderDate: DATE,
    windowOpen: '05:00',
    windowClose: '08:00',
    deferredYesterday: false,
    dockType: 'street',
    parkingConstraint: 'normal',
    ...over,
  };
}

const reeferVan = vehicles.find((v) => v.vehicleId === 'VEH035'); // van reefer Peliyagoda
const ambientTruck = vehicles.find((v) => v.vehicleId === 'VEH008'); // truck ambient Peliyagoda

test('validator: chilled order on ambient vehicle is a hard fail', () => {
  const trip = validateTrip({ vehicle: ambientTruck, orders: [mkOrder({ tempRequirement: 'chilled' })], date: DATE, distanceKm: 30 });
  assert.equal(trip.feasible, false);
  assert.ok(trip.violations.some((v) => v.code === 'TEMP'));
});

test('validator: van_only outlet on truck is a hard fail', () => {
  const trip = validateTrip({ vehicle: ambientTruck, orders: [mkOrder({ parkingConstraint: 'van_only' })], date: DATE, distanceKm: 30 });
  assert.equal(trip.feasible, false);
  assert.ok(trip.violations.some((v) => v.code === 'VAN_ONLY'));
});

test('validator: weight cap violation is a hard fail', () => {
  const trip = validateTrip({ vehicle: reeferVan, orders: [mkOrder({ weightKg: 2000 })], date: DATE, distanceKm: 30 });
  assert.equal(trip.feasible, false);
  assert.ok(trip.violations.some((v) => v.code === 'WEIGHT'));
});

test('validator: mixing brands in one trip is a hard fail', () => {
  const trip = validateTrip({ vehicle: ambientTruck, orders: [mkOrder(), mkOrder({ brand: 'Tech', outletId: 'OUT023' })], date: DATE, distanceKm: 30 });
  assert.equal(trip.feasible, false);
  assert.ok(trip.violations.some((v) => v.code === 'BRAND_MIX'));
});

test('validator: vehicle homed at wrong depot is a hard fail', () => {
  const kandyTruck = vehicles.find((v) => v.depot === 'Kandy' && v.type === 'truck' && v.temp === 'ambient');
  const trip = validateTrip({ vehicle: kandyTruck, orders: [mkOrder()], date: DATE, distanceKm: 30 });
  assert.equal(trip.feasible, false);
  assert.ok(trip.violations.some((v) => v.code === 'DEPOT'));
});

test('validator: trip past window close is a hard fail', () => {
  // OUT005 window closes 07:45; a Fresh trip starting 03:30 with long service should still fit;
  // force failure with many stops so the clock overruns the last window.
  const orders = Array.from({ length: 6 }, (_, i) => mkOrder({ id: i + 1, outletId: 'OUT005', windowClose: '04:30', weightKg: 10, volumeM3: 0.1 }));
  const trip = validateTrip({ vehicle: reeferVan, orders, date: DATE, distanceKm: 30 });
  assert.equal(trip.feasible, false);
  assert.ok(trip.violations.some((v) => v.code === 'WINDOW'));
});

test('validator: a well-formed Fresh trip passes', () => {
  const trip = validateTrip({ vehicle: reeferVan, orders: [mkOrder({ windowClose: '07:30' })], date: DATE, distanceKm: 30 });
  assert.equal(trip.feasible, true, JSON.stringify(trip.violations));
});

test('plan validator: more than 2 trips per vehicle is a hard fail', () => {
  const t = (n) => ({ vehicleId: 'VEH008', tripNo: n, fuelLiters: 5, orders: [], plannedStops: [] });
  const check = validatePlan({ trips: [t(1), t(2), t(3)], vehicles });
  assert.equal(check.feasible, false);
  assert.ok(check.violations.some((v) => v.code === 'MAX_TRIPS'));
});

test('plan validator: weekly fuel exceeded across trips is a hard fail', () => {
  const trip = { vehicleId: 'VEH008', tripNo: 1, fuelLiters: 500, orders: [], plannedStops: [] };
  const check = validatePlan({ trips: [trip], vehicles });
  assert.equal(check.feasible, false);
  assert.ok(check.violations.some((v) => v.code === 'FUEL'));
});

test('priority policy: chilled sorts before deferredYesterday before window before volume', () => {
  const chilled = mkOrder({ id: 1, tempRequirement: 'chilled', windowClose: '08:00', volumeM3: 1 });
  const deferred = mkOrder({ id: 2, deferredYesterday: true, tempRequirement: 'ambient', windowClose: '07:00', volumeM3: 9 });
  const tight = mkOrder({ id: 3, windowClose: '05:00', volumeM3: 9 });
  const big = mkOrder({ id: 4, windowClose: '08:00', volumeM3: 8 });
  const sorted = [big, tight, deferred, chilled].sort((a, b) => {
    const ka = priorityKey(a), kb = priorityKey(b);
    for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
    return 0;
  });
  assert.deepEqual(sorted.map((o) => o.id), [1, 2, 3, 4]);
});

test('engine: deterministic output — two runs produce identical plans', () => {
  function mkDataset() {
    const orders = [];
    for (let i = 0; i < 20; i++) {
      const outlet = outlets['OUT001'];
      orders.push(mkOrder({ id: i + 1, outletId: outlet.outletId, weightKg: 200 + i * 10, volumeM3: 1 + (i % 4) }));
    }
    for (let i = 0; i < 6; i++) {
      const outlet = outlets['OUT015']; // Style mall
      orders.push(mkOrder({ id: 100 + i, outletId: 'OUT015', brand: 'Style', windowOpen: '09:00', windowClose: '17:00', weightKg: 400, volumeM3: 3 }));
    }
    return orders;
  }
  const r1 = allocate({ orders: mkDataset(), vehicles, date: DATE });
  const r2 = allocate({ orders: mkDataset(), vehicles, date: DATE });
  // generatedAt is wall-clock; compare the plan itself.
  assert.deepEqual({ trips: r1.trips, deferred: r1.deferred }, { trips: r2.trips, deferred: r2.deferred });
  assert.equal(typeof r1.generatedAt, 'string');
});

test('engine: every produced trip is feasible', () => {
  const orders = [];
  const freshIds = ['OUT001', 'OUT002', 'OUT003', 'OUT004'];
  for (let i = 0; i < 24; i++) {
    const o = outlets[freshIds[i % freshIds.length]];
    orders.push(mkOrder({ id: i + 1, outletId: o.outletId, parkingConstraint: o.parkingConstraint, weightKg: 250, volumeM3: 1.2 }));
  }
  const result = allocate({ orders, vehicles, date: DATE });
  for (const trip of result.trips) {
    assert.equal(trip.feasible, true, `trip ${trip.vehicleId}#${trip.tripNo}: ${JSON.stringify(trip.violations)}`);
  }
});

test('engine: overloaded day produces deferrals with reason codes', () => {
  const orders = [];
  for (let i = 0; i < 30; i++) {
    // 45 m³ exceeds every vehicle cap (max 38 m³) → nothing fits → CAP deferrals.
    orders.push(mkOrder({ id: i + 1, weightKg: 900, volumeM3: 45 }));
  }
  const result = allocate({ orders, vehicles, date: DATE });
  assert.ok(result.deferred.length > 0, 'expected deferrals on an overloaded day');
  for (const d of result.deferred) {
    assert.ok(['CAP', 'REF', 'INV'].includes(d.reason), `reason ${d.reason} must be a known code`);
  }
});
