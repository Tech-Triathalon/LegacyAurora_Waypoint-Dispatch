// Minimal CSV parser + loaders for the competition datasets (no external deps).
const fs = require('fs');
const path = require('path');

const RAW_DIR = path.join(__dirname, 'raw');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => {
      row[h] = cells[i] !== undefined ? cells[i].trim() : '';
    });
    return row;
  });
}

function loadCsv(name) {
  return parseCsv(fs.readFileSync(path.join(RAW_DIR, name), 'utf8'));
}

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadOutlets() {
  return loadCsv('outlets.csv').map((r) => ({
    outletId: r.outlet_id,
    brand: r.brand,
    district: r.district,
    depot: r.depot,
    dockType: r.dock_type,
    parkingConstraint: r.parking_constraint || 'normal',
    mallWindow: r.mall_window || null,
    windowOpen: r.window_open_time,
    windowClose: r.window_close_time,
  }));
}

function loadVehicles() {
  return loadCsv('vehicles.csv').map((r) => ({
    vehicleId: r.vehicle_id,
    type: r.type,
    temp: r.temp,
    weightCapKg: num(r.weight_cap_kg),
    volumeCapM3: num(r.volume_cap_m3),
    fuelType: r.fuel_type,
    kmPerL: num(r.km_per_l),
    weeklyFuelQuotaL: num(r.weekly_fuel_quota_l),
    depot: r.depot,
  }));
}

// district_travel.csv: keyed by district (single depot row per district in dataset)
function loadDistrictTravel() {
  const map = {};
  for (const r of loadCsv('district_travel.csv')) {
    if (r.district === 'district') continue; // guard against duplicated headers
    map[r.district] = {
      district: r.district,
      depot: r.depot,
      roadClass: r.road_class,
      freeFlowKmh: num(r.free_flow_kmh),
      depotToDistrictKm: num(r.depot_to_district_km),
      depotToDistrictFreeflowMin: num(r.depot_to_district_freeflow_min),
      interStopKm: num(r.inter_stop_km),
      interStopFreeflowMin: num(r.inter_stop_freeflow_min),
    };
  }
  return map;
}

// traffic_speed.csv: `${district}|${hour}|${monsoon}` -> speed_index
function loadTrafficSpeed() {
  const map = {};
  for (const r of loadCsv('traffic_speed.csv')) {
    map[`${r.district}|${r.hour}|${r.monsoon}`] = num(r.speed_index, 100);
  }
  return map;
}

// road_conditions.csv: `${district}|${date}` -> disruption_index
function loadRoadConditions() {
  const map = {};
  for (const r of loadCsv('road_conditions.csv')) {
    map[`${r.district}|${r.date}`] = num(r.disruption_index, 100);
  }
  return map;
}

// service_allowance.csv: `${brand}|${dock_type}` -> service_allowance_min
function loadServiceAllowance() {
  const map = {};
  for (const r of loadCsv('service_allowance.csv')) {
    map[`${r.brand}|${r.dock_type}`] = num(r.service_allowance_min);
  }
  return map;
}

// calendar.csv: date -> row
function loadCalendar() {
  const map = {};
  for (const r of loadCsv('calendar.csv')) {
    map[r.date] = {
      date: r.date,
      dow: num(r.dow),
      dowName: r.dow_name,
      isWeekend: r.is_weekend === '1',
      isoWeek: num(r.iso_week),
      isPayday: r.is_payday === '1',
      festival: r.festival || null,
      festivalRamp: num(r.festival_ramp),
      isHoliday: r.is_holiday === '1',
      monsoon: num(r.monsoon),
      isOperating: r.is_operating === '1',
    };
  }
  return map;
}

function loadAll() {
  return {
    outlets: loadOutlets(),
    vehicles: loadVehicles(),
    travel: loadDistrictTravel(),
    traffic: loadTrafficSpeed(),
    road: loadRoadConditions(),
    service: loadServiceAllowance(),
    calendar: loadCalendar(),
  };
}

module.exports = {
  parseCsv,
  loadAll,
  loadOutlets,
  loadVehicles,
  loadDistrictTravel,
  loadTrafficSpeed,
  loadRoadConditions,
  loadServiceAllowance,
  loadCalendar,
};
