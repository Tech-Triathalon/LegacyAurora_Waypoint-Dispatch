// Security middleware: strict headers + in-memory sliding-window rate limiter.
// Dependency-free so the deployment story stays `npm ci` only.

// ---- Security headers (report Phase 1.4) ----
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  // HTTPS is terminated by the platform (Vercel/Render/proxy); HSTS only when
  // the request itself arrived over TLS so local http dev is not broken.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ---- In-memory sliding-window rate limiter ----
// Keyed by user id (when authenticated) else IP. Single-process only — plenty
// for the current single-container deployment; swap for Redis when scaling out.
function createRateLimiter({ windowMs, max, keyBy } = {}) {
  const hits = new Map(); // key -> number[] timestamps
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, stamps] of hits) {
      const alive = stamps.filter((t) => now - t < windowMs);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }

  function keyFor(req) {
    if (typeof keyBy === 'function') return keyBy(req);
    if (req.user && req.user.username) return `u:${req.user.username}`;
    const fwd = req.headers['x-forwarded-for'];
    return `ip:${(typeof fwd === 'string' ? fwd.split(',')[0].trim() : null) || req.socket.remoteAddress || 'unknown'}`;
  }

  function rateLimit(req, res, next) {
    const now = Date.now();
    sweep(now);
    const key = keyFor(req);
    const stamps = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (stamps.length >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - stamps[0])) / 1000));
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({ error: 'too many requests', retryAfterSeconds: retryAfterSec });
    }
    stamps.push(now);
    hits.set(key, stamps);
    return next();
  }

  // Test hook: reset all buckets.
  rateLimit._reset = () => hits.clear();
  return rateLimit;
}

module.exports = { securityHeaders, createRateLimiter };
