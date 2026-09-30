// Allocation engine — greedy, deterministic, explainable. System proposes, dispatcher approves.
//
// Scoring policy (documented prioritization):
//   1. chilled first (cold-chain is scarcest)
//   2. deferredYesterday=1 (consecutive-skip protection)
//   3. tightest window (earliest close)
//   4. largest volume
// Two phases: Phase A assigns chilled orders to reefer vehicles; Phase B assigns ambient to any.
// Overflow becomes deferrals with reason codes CAP / REF / INV.
const { validateTrip } = require('./validate');
const { depotLegMinutes, interStopMinutes } = require('../travel');

const DAY_START_MIN = 3 * 60 + 30;

function tripDistanceKm(orders, district) {
  // n stops: depot->first + (n-1) inter + last->depot ≈ depot legs ×2 + inter ×(n-1)
  const first = depotLegMinutes({ district, date: orders[0].orderDate, hour: 3 });
  const mid = interStopMinutes({ district, date: orders[0].orderDate, hour: 6 });
  return first.km * 2 + mid.km * Math.max(0, orders.length - 1);
}

// Sort key implementing the documented policy. Lower sorts first.
function priorityKey(o) {
  const chilled = o.tempRequirement === 'chilled' ? 0 : 1;
  const deferred = o.deferredYesterday ? 0 : 1;
  const [h, m] = o.windowClose.split(':').map(Number);
  const windowClose = h * 60 + m;
  return [chilled, deferred, windowClose, -o.volumeM3, o.id];
}

function compareTuple(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Greedy first-fit over vehicles for one order, respecting hard feasibility.
function tryPlace(order, vehiclesState, vehicles, date) {
  const candidates = [];
  for (const state of vehiclesState) {
    const vehicle = vehicles.find((v) => v.vehicleId === state.vehicleId);
    // Temperature hard gate (cheaper than full validation for pruning, but validated again below)
    if (order.tempRequirement === 'chilled' && vehicle.temp !== 'reefer') continue;
    if (order.parkingConstraint === 'van_only' && vehicle.type !== 'van') continue;
    if (vehicle.depot !== order.depot) continue;
    for (const trip of state.trips) {
      const candidateOrders = [...trip.orders, order].sort((a, b) => compareTuple(priorityKey(a), priorityKey(b)));
      const distanceKm = tripDistanceKm(candidateOrders, trip.district);
      const check = validateTrip({ vehicle, orders: candidateOrders, date, distanceKm });
      if (check.feasible) {
        candidates.push({ state, trip, candidateOrders, distanceKm, check, deltaVolume: order.volumeM3 });
      }
    }
  }
  if (candidates.length === 0) return null;
  // Best-fit: least remaining volume after placement (ties → least fuel, then vehicleId for determinism)
  candidates.sort((a, b) => {
    const ra = b.trip.orders.reduce((s, o) => s + o.volumeM3, 0) + a.deltaVolume;
    const rb = a.trip.orders.reduce((s, o) => s + o.volumeM3, 0) + b.deltaVolume;
    if (ra !== rb) return rb - ra; // prefer larger resulting fill
    const fa = a.check.fuelLiters, fb = b.check.fuelLiters;
    if (fa !== fb) return fa - fb;
    return a.state.vehicleId < b.state.vehicleId ? -1 : 1;
  });
  return candidates[0];
}

function openNewTrip(state, order, date) {
  const trip = {
    vehicleId: state.vehicleId,
    tripNo: state.trips.length + 1,
    brand: order.brand,
    district: order.district,
    depot: order.depot,
    orders: [order],
    distanceKm: 0,
  };
  return trip;
}

function allocate({ orders, vehicles, date }) {
  // Deterministic input ordering by the documented policy.
  const sorted = [...orders].sort((a, b) => compareTuple(priorityKey(a), priorityKey(b)));

  const vehiclesState = vehicles.map((v) => ({ vehicleId: v.vehicleId, trips: [] }));
  const deferred = [];

  for (const order of sorted) {
    const placement = tryPlace(order, vehiclesState, vehicles, date);
    if (placement) {
      placement.trip.orders = placement.candidateOrders;
      placement.trip.distanceKm = placement.distanceKm;
      continue;
    }
    // Could not place — open a fresh trip if the vehicle has capacity for another one.
    const state = vehiclesState.find((s) => {
      const v = vehicles.find((vv) => vv.vehicleId === s.vehicleId);
      if (s.trips.length >= 2) return false;
      if (v.depot !== order.depot) return false;
      if (order.tempRequirement === 'chilled' && v.temp !== 'reefer') return false;
      if (order.parkingConstraint === 'van_only' && v.type !== 'van') return false;
      return true;
    });
    if (state) {
      const vehicle = vehicles.find((v) => v.vehicleId === state.vehicleId);
      const trip = openNewTrip(state, order, date);
      trip.distanceKm = tripDistanceKm(trip.orders, trip.district);
      const check = validateTrip({ vehicle, orders: trip.orders, date, distanceKm: trip.distanceKm });
      if (check.feasible) {
        state.trips.push(trip);
        continue;
      }
    }
    // Hard fail → deferral with reason code.
    let reason = 'CAP';
    if (order.tempRequirement === 'chilled' && !vehicles.some((v) => v.temp === 'reefer' && v.depot === order.depot)) {
      reason = 'REF';
    }
    if (order.parkingConstraint === 'van_only' && !vehicles.some((v) => v.type === 'van' && v.depot === order.depot)) {
      reason = 'INV';
    }
    deferred.push({ order, reason });
  }

  // Materialize validated trip summaries.
  const trips = [];
  for (const state of vehiclesState) {
    for (const trip of state.trips) {
      const vehicle = vehicles.find((v) => v.vehicleId === state.vehicleId);
      const distanceKm = trip.distanceKm || tripDistanceKm(trip.orders, trip.district);
      const check = validateTrip({ vehicle, orders: trip.orders, date, distanceKm });
      trips.push({
        vehicleId: state.vehicleId,
        tripNo: trip.tripNo,
        brand: trip.brand,
        district: trip.district,
        depot: trip.depot,
        orders: trip.orders.map((o) => o.id),
        orderRefs: trip.orders.map((o) => `${o.outletId}#${o.id}`),
        totalWeight: check.totalWeight,
        totalVolume: check.totalVolume,
        estMinutes: Math.round(check.estMinutes),
        distanceKm,
        fuelLiters: check.fuelLiters,
        plannedStops: check.plannedStops,
        feasible: check.feasible,
        violations: check.violations,
      });
    }
  }

  return { trips, deferred, generatedAt: new Date().toISOString() };
}

module.exports = { allocate, priorityKey, tripDistanceKm, DAY_START_MIN };
