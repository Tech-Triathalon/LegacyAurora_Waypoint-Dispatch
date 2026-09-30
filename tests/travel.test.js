// Unit tests for travel-time model, traffic speeds, weather conditions, and datasets.
const test = require('node:test');
const assert = require('node:assert');
const {
  getDatasets,
  effectiveMinutes,
  getMonsoon,
  getCalendarRow,
  depotLegMinutes,
  interStopMinutes,
  serviceMinutes,
  travelBetween,
} = require('../server/src/travel');
const datasets = require('../server/src/data/datasets');

const TEST_DATE = '2026-06-25';

test('travel datasets: all raw CSV files load and parse successfully', () => {
  const data = getDatasets();
  assert.ok(data.calendar, 'calendar dataset loaded');
  assert.ok(data.travel, 'travel matrix loaded');
  assert.ok(data.traffic, 'traffic speed index loaded');
  assert.ok(data.road, 'road condition index loaded');
  assert.ok(data.service, 'service allowance loaded');
  assert.ok(Array.isArray(data.outlets), 'outlets array loaded');
  assert.ok(Array.isArray(data.vehicles), 'vehicles array loaded');
});

test('calendar: correctly determines monsoon season and operating days', () => {
  const calRow = getCalendarRow(TEST_DATE);
  assert.ok(calRow, 'calendar row exists for test date');
  assert.equal(typeof calRow.isOperating, 'boolean');
  assert.equal(typeof calRow.monsoon, 'number');

  const monsoon = getMonsoon(TEST_DATE);
  assert.ok(monsoon === 0 || monsoon === 1, 'monsoon is binary indicator (0 or 1)');
});

test('effectiveMinutes: speed index and disruption index increase travel duration', () => {
  const freeflowMin = 30;
  const standardTime = effectiveMinutes({
    district: 'Colombo',
    date: TEST_DATE,
    hour: 4,
    freeflowMin,
  });

  // Effective time should always be >= freeflowMin since speed_index and disruption_index are <= 100
  assert.ok(
    standardTime >= freeflowMin,
    `effective time (${standardTime}) should be >= freeflow (${freeflowMin})`
  );
  assert.ok(Number.isFinite(standardTime), 'computed travel time is a valid number');
});

test('effectiveMinutes: fallback when district/date not indexed', () => {
  // Freeflow with unindexed district
  const minResult = effectiveMinutes({
    district: 'NonExistentDistrict',
    date: '2099-01-01', // unindexed future date falls back to 100/100
    hour: 12,
    freeflowMin: 20,
  });
  assert.equal(minResult, 20, 'fallback indices (100, 100) return base freeflow time');
});

test('depotLegMinutes: computes valid distance and minutes for valid districts', () => {
  const leg = depotLegMinutes({ district: 'Colombo', date: TEST_DATE, hour: 5 });
  assert.ok(leg.km > 0, 'depot leg distance is positive');
  assert.ok(leg.minutes > 0, 'depot leg travel time is positive');

  const invalidLeg = depotLegMinutes({ district: 'NonExistentDistrict', date: TEST_DATE, hour: 5 });
  assert.deepEqual(invalidLeg, { minutes: 0, km: 0 });
});

test('interStopMinutes: computes intra-district stop distance and travel time', () => {
  const stopLeg = interStopMinutes({ district: 'Gampaha', date: TEST_DATE, hour: 6 });
  assert.ok(stopLeg.km > 0, 'inter-stop distance is positive');
  assert.ok(stopLeg.minutes > 0, 'inter-stop minutes is positive');

  const unknown = interStopMinutes({ district: 'Unknown', date: TEST_DATE, hour: 6 });
  assert.deepEqual(unknown, { minutes: 0, km: 0 });
});

test('serviceMinutes: returns calibrated dock unloading allowances by brand and dock type', () => {
  const freshBay = serviceMinutes({ brand: 'Fresh', dockType: 'bay' });
  const styleStreet = serviceMinutes({ brand: 'Style', dockType: 'street' });
  const unknownService = serviceMinutes({ brand: 'UnknownBrand', dockType: 'ramp' });

  assert.ok(typeof freshBay === 'number' && freshBay > 0, 'Fresh bay service time is positive');
  assert.ok(typeof styleStreet === 'number' && styleStreet > 0, 'Style street service time is positive');
  assert.equal(unknownService, 30, 'unknown combination falls back to default 30 mins');
});

test('travelBetween: returns intra-district time when districts match', () => {
  const same = travelBetween({ fromDistrict: 'Colombo', toDistrict: 'Colombo', date: TEST_DATE, hour: 7 });
  const inter = interStopMinutes({ district: 'Colombo', date: TEST_DATE, hour: 7 });
  assert.deepEqual(same, inter);
});

test('travelBetween: approximates cross-district travel distance and duration', () => {
  const cross = travelBetween({ fromDistrict: 'Colombo', toDistrict: 'Kandy', date: TEST_DATE, hour: 7 });
  assert.ok(cross.km > 0, 'cross district distance is positive');
  assert.ok(cross.minutes > 0, 'cross district time is positive');
});
