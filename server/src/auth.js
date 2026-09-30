// Auth: bcrypt password hashing + JWT in an httpOnly cookie + role middleware.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
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

router.post('/login', async (req, res) => {
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

router.get('/me', requireAuth, (req, res) => {
  return res.json(req.user);
});

module.exports = { router, requireAuth, requireRole };
