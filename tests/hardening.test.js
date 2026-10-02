// Unit tests for the Phase-1 hardening layer: dependency-free validators,
// security headers, sliding-window rate limiter, and the idempotency store
// that makes offline mutation replays safe.
const test = require('node:test');
const assert = require('node:assert');
const express = require('../server/node_modules/express');

const { parseBody, parseBodyPartial, vString, vNumber, vEnum, vDate, vUuid } = require('../server/src/validate');
const { securityHeaders, createRateLimiter } = require('../server/src/security');
const idempotency = require('../server/src/idempotency');

// ---------- validators ----------
test('validate: parseBody accepts valid input and strips unknown keys', () => {
  const res = parseBody(
    { units: vNumber({ min: 1, max: 100, int: true }), temp: vEnum(['chilled', 'ambient']) },
    { units: '42', temp: 'chilled', evil: '<script>' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.value.units, 42);
  assert.deepEqual(Object.keys(res.value), ['units', 'temp']);
});

test('validate: parseBody aggregates per-field errors', () => {
  const res = parseBody(
    { units: vNumber({ min: 1, int: true }), temp: vEnum(['chilled']) },
    { units: -3, temp: 'hot' },
  );
  assert.equal(res.ok, false);
  assert.match(res.errors.units, /between/);
  assert.match(res.errors.temp, /one of/);
});

test('validate: parseBodyPartial ignores absent optional fields but rejects bad present ones', () => {
  const ok = parseBodyPartial({ note: vString({ max: 5 }) }, {});
  assert.equal(ok.ok, true);
  const bad = parseBodyPartial({ note: vString({ max: 5 }) }, { note: 'way too long' });
  assert.equal(bad.ok, false);
});

test('validate: window strings and dates follow dispatch formats', () => {
  assert.equal(vString({ pattern: /^([01]\d|2[0-3]):[0-5]\d$/ })('05:30').ok !== false, true);
  assert.equal(vString({ pattern: /^([01]\d|2[0-3]):[0-5]\d$/ })('25:99').err !== undefined, true);
  assert.equal(vDate({})('2026-06-25').value, '2026-06-25');
  assert.equal(vDate({ optional: true })(undefined).value, undefined);
  assert.equal(vDate({})(undefined).err !== undefined, true);
  assert.equal(vUuid({})('a4f9c2e1-77b2-4c1d-9e8a-123456789abc').value, 'a4f9c2e1-77b2-4c1d-9e8a-123456789abc');
  assert.equal(vUuid({})('not a uuid!').err !== undefined, true);
});

// ---------- security headers ----------
test('security: strict headers always applied; HSTS only over TLS', () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  securityHeaders({ headers: {} }, res, () => {});
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Strict-Transport-Security'], undefined);

  headers.StrictTransportSecurity = undefined;
  securityHeaders({ headers: { 'x-forwarded-proto': 'https' } }, res, () => {});
  assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);
});

// ---------- rate limiter ----------
function limiterApp(limiter) {
  const app = express();
  app.use(express.json());
  app.post('/hit', limiter, (req, res) => res.json({ ok: true }));
  return app;
}

test('security: rate limiter 429s after max then recovers on _reset', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  const app = limiterApp(limiter);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      // Unique IP per request would defeat the limiter; keep the default key.
      const res = await fetch(`http://127.0.0.1:${port}/hit`, { method: 'POST' });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    limiter._reset();
    const res = await fetch(`http://127.0.0.1:${port}/hit`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('security: rate limiter keys by user when authenticated', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 1 });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: `u${Math.random()}` }; next(); });
  app.post('/hit', limiter, (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const a = await fetch(`http://127.0.0.1:${port}/hit`, { method: 'POST' });
    const b = await fetch(`http://127.0.0.1:${port}/hit`, { method: 'POST' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200); // different user → separate bucket
  } finally {
    server.close();
  }
});

// ---------- idempotency middleware ----------
test('idempotency: replays the recorded response for the same clientRef', async () => {
  idempotency._reset();
  const app = express();
  app.use(express.json());
  let hits = 0;
  app.post('/pay', idempotency.middleware, (req, res) => {
    hits += 1;
    res.json({ ok: true, hits });
  });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const body = JSON.stringify({ clientRef: 'ref-1', amount: 10 });
    const first = await fetch(`http://127.0.0.1:${port}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const second = await fetch(`http://127.0.0.1:${port}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(hits, 1); // handler ran once
    assert.equal(first.headers.get('x-idempotent-replay'), null);
    assert.equal(second.headers.get('x-idempotent-replay'), 'true');
    assert.deepEqual(secondBody, firstBody);
  } finally {
    server.close();
  }
});

test('idempotency: distinct clientRefs are independent; requests without one pass through', async () => {
  idempotency._reset();
  const app = express();
  app.use(express.json());
  let hits = 0;
  app.post('/pay', idempotency.middleware, (req, res) => { hits += 1; res.json({ hits }); });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    await fetch(`http://127.0.0.1:${port}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRef: 'a' }) });
    await fetch(`http://127.0.0.1:${port}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRef: 'b' }) });
    await fetch(`http://127.0.0.1:${port}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(hits, 3);
    assert.equal(idempotency._size(), 2);
  } finally {
    server.close();
  }
});
