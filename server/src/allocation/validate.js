// Hard feasibility validator — the complexity of the system lives here, not in the optimizer.
// Pure functions: no DB, no I/O. Shared by the engine, the unit tests, and the dispatcher UI
// (proposals failing validation are blocked from commit).
const { depotLegMinutes, interStopMinutes, serviceMinutes } = require('../travel');

// Brand day budgets (booklet Task 2B): Fresh trips must finish before 08:00 (270 min budget
// from a 03:30 start); Style/Tech run within the day at ≤ 480 min.
const BRAND_BUDGET_MIN = { Fresh: 270, Style: 480, Tech: 480 };

// Deterministic start-of-day baseline for trip time computations.
const DAY_START_MIN = 3 * 60 + 30; // 03:30 depot departure for Fresh trips

function t2m(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function m2t(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Validate a single proposed trip (list of orders, in visit order).
// Returns { feasible, violations: [{code, detail}], estMinutes, plannedStops, fuelLiters }
function validateTrip({ vehicle, orders, date, distanceKm }) {
  const violations = [];
  if (!orders || orders.length === 0) {
    return { feasible: false, violations: [{ code: 'EMPTY', detail: 'no stops' }], estMinutes: 0, plannedStops: [], fuelLiters: 0 };
  }

  const brand = orders[0].brand;
  const district = orders[0].district;

  // 1. Same brand + same district per trip.
  for (const o of orders) {
    if (o.brand !== brand) violations.push({ code: 'BRAND_MIX', detail: `${o.orderRef || o.outletId} breaks brand homogeneity` });
    if (o.district !== district) violations.push({ code: 'DISTRICT_MIX', detail: `${o.orderRef || o.outletId} breaks district homogeneity` });
  }

  // 2. Vehicle home depot must match order depot.
  if (vehicle.depot !== orders[0].depot) {
    violations.push({ code: 'DEPOT', detail: `${vehicle.vehicleId} not homed at ${orders[0].depot}` });
  }

  // 3. Temperature compatibility (chilled only on reefer).
  for (const o of orders) {
    if (o.tempRequirement === 'chilled' && vehicle.temp !== 'reefer') {
      violations.push({ code: 'TEMP', detail: `chilled order ${o.orderRef || o.outletId} on ambient vehicle` });
    }
  }

  // 4. van_only outlets require a van.
  for (const o of orders) {
    if (o.parkingConstraint === 'van_only' && vehicle.type !== 'van') {
      violations.push({ code: 'VAN_ONLY', detail: `van_only outlet ${o.outletId} served by ${vehicle.type}` });
    }
  }

  // 5. Weight / volume caps.
  const totalWeight = orders.reduce((s, o) => s + o.weightKg, 0);
  const totalVolume = orders.reduce((s, o) => s + o.volumeM3, 0);
  if (totalWeight > vehicle.weightCapKg) {
    violations.push({ code: 'WEIGHT', detail: `${Math.round(totalWeight)}kg > cap ${vehicle.weightCapKg}kg` });
  }
  if (totalVolume > vehicle.volumeCapM3) {
    violations.push({ code: 'VOLUME', detail: `${totalVolume.toFixed(1)}m³ > cap ${vehicle.volumeCapM3}m³` });
  }

  // 6. Time budget incl. depot legs + per-stop service allowances + inter-stop legs.
  const first = depotLegMinutes({ district, date, hour: Math.floor(DAY_START_MIN / 60) });
  const mid = interStopMinutes({ district, date, hour: 6 }); // evaluate inter-stop legs at 06:00 traffic
  const service = orders.reduce((s, o) => s + serviceMinutes({ brand: o.brand, dockType: o.dockType }), 0);
  const estMinutes = first.minutes + mid.minutes * (orders.length - 1) + service;
  const budget = BRAND_BUDGET_MIN[brand] ?? 480;
  if (estMinutes > budget) {
    violations.push({ code: 'TIME_BUDGET', detail: `${Math.round(estMinutes)}min > ${budget}min ${brand} budget` });
  }

  // 7. Outlet service windows — each stop must be reachable inside its window.
  let clock = DAY_START_MIN + first.minutes;
  const plannedStops = [];
  for (const o of orders) {
    const svc = serviceMinutes({ brand: o.brand, dockType: o.dockType });
    const arrival = clock;
    if (arrival > t2m(o.windowClose)) {
      violations.push({ code: 'WINDOW', detail: `${o.outletId} closes ${o.windowClose}, arrival ${m2t(arrival)}` });
    }
    plannedStops.push({ orderId: o.id, outletId: o.outletId, plannedArrival: m2t(arrival), serviceMin: svc });
    clock += svc + mid.minutes; // leave after service, drive to next stop
  }

  // 8. Fuel quota for this trip.
  const fuelLiters = distanceKm / vehicle.kmPerL;
  if (fuelLiters > vehicle.weeklyFuelQuotaL) {
    violations.push({ code: 'FUEL', detail: `${fuelLiters.toFixed(0)}L > weekly ${vehicle.weeklyFuelQuotaL}L` });
  }

  // 9. Distance must be provided and positive for fuel math.
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    violations.push({ code: 'DISTANCE', detail: 'trip distance missing or invalid' });
  }

  return {
    feasible: violations.length === 0,
    violations,
    estMinutes,
    plannedStops,
    fuelLiters,
    totalWeight,
    totalVolume,
  };
}

// Validate a whole plan: every trip feasible, ≤ 2 trips per vehicle, weekly fuel across trips.
function validatePlan({ trips, vehicles }) {
  const violations = [];
  const byVehicle = {};
  for (const trip of trips) {
    byVehicle[trip.vehicleId] = byVehicle[trip.vehicleId] || [];
    byVehicle[trip.vehicleId].push(trip);
  }

  const fuelUsed = {};
  for (const [vehicleId, vTrips] of Object.entries(byVehicle)) {
    if (vTrips.length > 2) {
      violations.push({ code: 'MAX_TRIPS', detail: `${vehicleId} has ${vTrips.length} trips (max 2)` });
    }
    const vehicle = vehicles.find((v) => v.vehicleId === vehicleId);
    if (!vehicle) {
      violations.push({ code: 'UNKNOWN_VEHICLE', detail: vehicleId });
      continue;
    }
    const used = vTrips.reduce((s, t) => s + (t.fuelLiters || 0), 0);
    fuelUsed[vehicleId] = used;
    if (used > vehicle.weeklyFuelQuotaL) {
      violations.push({ code: 'FUEL', detail: `${vehicleId}: ${used.toFixed(0)}L > weekly ${vehicle.weeklyFuelQuotaL}L` });
    }
  }

  return { feasible: violations.length === 0, violations, fuelUsed };
}

module.exports = { validateTrip, validatePlan, BRAND_BUDGET_MIN, DAY_START_MIN, t2m, m2t };
