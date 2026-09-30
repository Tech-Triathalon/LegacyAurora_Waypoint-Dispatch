// Travel-time + cost model built on the competition datasets.
//
// Effective travel time formula (documented in README):
//   minutes = freeflow_min × (100 / speed_index) × (100 / disruption_index)
// speed_index: district × hour × monsoon (traffic_speed.csv)
// disruption_index: district × date (road_conditions.csv), scaled around 100.
const { loadAll } = require('./data/datasets');

let cache = null;

function getDatasets() {
  if (!cache) cache = loadAll();
  return cache;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// Effective minutes for a freeflow-minutes leg in `district`, departing `date` at `hour`.
function effectiveMinutes({ district, date, hour, freeflowMin }) {
  const { traffic, road } = getDatasets();
  const monsoon = getMonsoon(date);
  const speedIdx = clamp(traffic[`${district}|${hour}|${monsoon}`] ?? 100, 20, 100);
  const disruption = clamp(road[`${district}|${date}`] ?? 100, 20, 100);
  return freeflowMin * (100 / speedIdx) * (100 / disruption);
}

function getMonsoon(date) {
  const { calendar } = getDatasets();
  return calendar[date] ? calendar[date].monsoon : 0;
}

function getCalendarRow(date) {
  return getDatasets().calendar[date] || null;
}

// Depot -> first stop (and last stop -> depot) legs.
function depotLegMinutes({ district, date, hour }) {
  const { travel } = getDatasets();
  const t = travel[district];
  if (!t) return { minutes: 0, km: 0 };
  return {
    minutes: effectiveMinutes({ district, date, hour, freeflowMin: t.depotToDistrictFreeflowMin }),
    km: t.depotToDistrictKm,
  };
}

// Between two stops in the same district.
function interStopMinutes({ district, date, hour }) {
  const { travel } = getDatasets();
  const t = travel[district];
  if (!t) return { minutes: 0, km: 0 };
  return {
    minutes: effectiveMinutes({ district, date, hour, freeflowMin: t.interStopFreeflowMin }),
    km: t.interStopKm,
  };
}

function serviceMinutes({ brand, dockType }) {
  const { service } = getDatasets();
  return service[`${brand}|${dockType}`] ?? 30;
}

function travelBetween({ fromDistrict, toDistrict, date, hour }) {
  if (fromDistrict === toDistrict) return interStopMinutes({ district: fromDistrict, date, hour });
  // Cross-district legs are approximated via depot distances (documented departure).
  const { travel } = getDatasets();
  const a = travel[fromDistrict];
  const b = travel[toDistrict];
  if (!a || !b) return { minutes: 30, km: 20 };
  const km = Math.abs(a.depotToDistrictKm - b.depotToDistrictKm) + a.interStopKm;
  const freeflowMin = (km / a.freeFlowKmh) * 60;
  return { minutes: effectiveMinutes({ district: fromDistrict, date, hour, freeflowMin }), km };
}

module.exports = {
  getDatasets,
  effectiveMinutes,
  getMonsoon,
  getCalendarRow,
  depotLegMinutes,
  interStopMinutes,
  serviceMinutes,
  travelBetween,
};
