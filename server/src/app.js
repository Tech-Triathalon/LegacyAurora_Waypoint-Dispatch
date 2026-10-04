// Express app assembly. Serves the API under /api and the static client (judge mode:
// one origin, one process). Listens only when run directly (src/index.js or serverless).
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const { loadEnv } = require('./env');
loadEnv();

const { securityHeaders } = require('./security');
const { router: authRouter } = require('./auth');
const { router: ordersRouter } = require('./routes/orders');
const { router: opsRouter } = require('./routes/ops');
const { router: realtimeRouter } = require('./realtime');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Vercel/Render/nginx: correct req.secure + rate-limit keys

  // Allow preflight & CORS when invoked across origins or serverless environments
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, clientRef');
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // URL normalization for Vercel serverless / rewrite routing
  app.use((req, res, next) => {
    const matchedPath = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'];
    if (matchedPath && (req.url === '/api/index.js' || req.url === '/index.js' || req.url === '/' || req.url === '/api')) {
      req.url = matchedPath;
    }
    next();
  });

  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Dual-mount API routes (/api/... and /...) for serverless runtime flexibility
  app.use('/api/auth', authRouter);
  app.use('/auth', authRouter);

  app.use('/api', ordersRouter);
  app.use('/api', opsRouter);
  app.use('/api', realtimeRouter);

  app.use('/', ordersRouter);
  app.use('/', opsRouter);
  app.use('/', realtimeRouter);

  // Static client last — /api/* never falls through to files.
  const clientDir = path.join(__dirname, '..', '..', 'client');
  app.use(express.static(clientDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      if (filePath.endsWith('manifest.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    },
  }));

  // PWA: hashed JS bundle list for the service worker's precache (byte-identical
  // pages + JS read from disk at request time, so edits show up without a rebuild).
  app.get(['/api/client-manifest', '/client-manifest'], (req, res) => {
    try {
      const files = fs.readdirSync(clientDir).filter((f) => f.endsWith('.js'));
      const etags = {};
      for (const f of files) {
        try { etags[`/${f}`] = fs.readFileSync(path.join(clientDir, f)).length; } catch { /* vanished */ }
      }
      res.set('Cache-Control', 'no-store');
      return res.json({ etags });
    } catch {
      return res.json({ etags: {} });
    }
  });

  // JSON 404 for unknown API routes (HTML 404 otherwise via static).
  app.use(['/api', '/api/*'], (req, res) => res.status(404).json({ error: 'not found' }));

  // JSON error handler — DB outages surface as 503, never an HTML stack trace.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && err.code && String(err.code).startsWith('P') ? 503 : (err.status || 500);
    console.error('[api-error]', err.code || '', err.message);
    res.status(status).json({ error: 'internal error', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  });

  return app;
}

module.exports = { createApp };

