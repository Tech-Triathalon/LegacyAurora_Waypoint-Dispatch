// Vercel serverless entry: wraps the same Express app used by docker/dev.
// No listens — Vercel provides the HTTP context.
require('../server/src/env').loadEnv();

const { createApp } = require('../server/src/app');

const app = createApp();

module.exports = (req, res) => {
  // Normalize URL when Vercel serverless functions rewrite req.url to /api/index.js
  const matchedPath = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'];
  if (matchedPath && (req.url === '/api/index.js' || req.url === '/index.js' || req.url === '/' || req.url === '/api')) {
    req.url = matchedPath;
  }
  return app(req, res);
};

