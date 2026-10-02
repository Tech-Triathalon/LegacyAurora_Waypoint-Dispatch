// Auth: bcrypt password hashing + JWT in an httpOnly cookie + role middleware.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('./prisma');
const { createRateLimiter } = require('./security');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'waypoint-dev-secret';
const COOKIE = 'waypoint_token';

function sign(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '12h' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE] : null;
  if (!token) return res.status(401).json({ error: 'not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'session expired' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `requires role: ${roles.join('|')}` });
    }
    return next();
  };
}

router.post('/login', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  setAuthCookie(res, sign(user));
  return res.json({ username: user.username, role: user.role, name: user.name });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  return res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  // Enrich the JWT claims with the account's operational binding so portals can
  // self-configure (driver → vehicle code, manager → outlet id) in one round-trip.
  try {
    const user = await prisma.user.findUnique({ where: { username: req.user.username }, include: { vehicle: true, outlet: true } });
    if (!user) return res.json(req.user);
    return res.json({
      ...req.user,
      vehicleCode: user.vehicle ? user.vehicle.vehicleId : null,
      vehicleNumericId: user.vehicle ? user.vehicle.id : null,
      outletId: user.outlet ? user.outlet.outletId : null,
      outletBrand: user.outlet ? user.outlet.brand : null,
      outletName: user.outlet ? `${user.outlet.brand} · ${user.outlet.district}` : null,
    });
  } catch (err) {
    console.error('[auth/me]', err.code || '', err.message);
    return res.json(req.user); // degrade to raw claims rather than failing portals
  }
});

module.exports = { router, requireAuth, requireRole };
