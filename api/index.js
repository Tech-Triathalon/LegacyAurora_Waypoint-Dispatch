// Vercel serverless entry: wraps Express app with lazy initialization & error boundary.
let appInstance = null;
let initError = null;

function getApp() {
  if (appInstance) return appInstance;
  if (initError) throw initError;
  try {
    try {
      require('../server/src/env').loadEnv();
    } catch (e) {
      console.warn('[vercel] loadEnv non-fatal:', e.message);
    }
    const { createApp } = require('../server/src/app');
    appInstance = createApp();
    return appInstance;
  } catch (err) {
    initError = err;
    console.error('[vercel-init-error]', err);
    throw err;
  }
}

module.exports = (req, res) => {
  try {
    const app = getApp();
    // Normalize URL when Vercel serverless functions rewrite req.url to /api/index.js
    const matchedPath = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'];
    if (matchedPath && (req.url === '/api/index.js' || req.url === '/index.js' || req.url === '/' || req.url === '/api')) {
      req.url = matchedPath;
    }
    return app(req, res);
  } catch (err) {
    console.error('[vercel-handler-error]', err);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Server initialization error',
        message: err.message || 'Unknown error',
      });
    }
  }
};


