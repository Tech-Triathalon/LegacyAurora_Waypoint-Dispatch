// Express app assembly. Serves the API under /api and the static client (judge mode:
// one origin, one process). Listens only when run directly (src/index.js or serverless).
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { router: authRouter } = require('./auth');
const { router: ordersRouter } = require('./routes/orders');
const { router: opsRouter } = require('./routes/ops');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api/auth', authRouter);
  app.use('/api', ordersRouter);
  app.use('/api', opsRouter);

  // Static client last — /api/* never falls through to files.
  const clientDir = path.join(__dirname, '..', '..', 'client');
  app.use(express.static(clientDir));

  // JSON 404 for unknown API routes (HTML 404 otherwise via static).
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

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
