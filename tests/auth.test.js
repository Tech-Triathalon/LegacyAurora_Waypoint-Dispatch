// Unit tests for authentication, JWT lifecycle, and RBAC authorization middleware.
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('../server/node_modules/jsonwebtoken');
const { requireAuth, requireRole } = require('../server/src/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'waypoint-dev-secret';
const COOKIE_NAME = 'waypoint_token';

function createMockReq(token = null, role = null) {
  return {
    cookies: token ? { [COOKIE_NAME]: token } : {},
    user: role ? { username: 'testuser', role, sub: 1 } : null,
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    jsonData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.jsonData = data;
      return this;
    },
    cookie(name, val, opts) {
      this.headers[name] = { val, opts };
      return this;
    },
    clearCookie(name) {
      delete this.headers[name];
      return this;
    },
  };
  return res;
}

test('auth: valid JWT allows access through requireAuth middleware', () => {
  const token = jwt.sign({ sub: 10, username: 'dispatcher_pel', role: 'dispatcher', name: 'Peliyagoda Dispatcher' }, JWT_SECRET, { expiresIn: '1h' });
  const req = createMockReq(token);
  const res = createMockRes();
  let nextCalled = false;

  requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, 'next() should be called on valid token');
  assert.ok(req.user, 'req.user should be populated from JWT payload');
  assert.equal(req.user.username, 'dispatcher_pel');
  assert.equal(req.user.role, 'dispatcher');
});

test('auth: missing cookie rejects with 401 not authenticated', () => {
  const req = createMockReq(null);
  const res = createMockRes();
  let nextCalled = false;

  requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'next() should not be called');
  assert.equal(res.statusCode, 401);
  assert.equal(res.jsonData.error, 'not authenticated');
});

test('auth: invalid or expired token rejects with 401 session expired', () => {
  const badToken = 'invalid.jwt.token.string';
  const req = createMockReq(badToken);
  const res = createMockRes();
  let nextCalled = false;

  requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'next() should not be called');
  assert.equal(res.statusCode, 401);
  assert.equal(res.jsonData.error, 'session expired');
});

test('rbac: requireRole allows authorized roles', () => {
  const dispatcherMiddleware = requireRole('dispatcher', 'manager');
  const req = createMockReq(null, 'dispatcher');
  const res = createMockRes();
  let nextCalled = false;

  dispatcherMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, 'authorized role should pass');
});

test('rbac: requireRole blocks unauthorized roles with 403', () => {
  const dispatcherOnlyMiddleware = requireRole('dispatcher');
  const req = createMockReq(null, 'driver');
  const res = createMockRes();
  let nextCalled = false;

  dispatcherOnlyMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'unauthorized role should not proceed');
  assert.equal(res.statusCode, 403);
  assert.ok(res.jsonData.error.includes('requires role: dispatcher'));
});

test('rbac: requireRole blocks requests without req.user with 403', () => {
  const middleware = requireRole('loader');
  const req = createMockReq(null, null);
  const res = createMockRes();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});
