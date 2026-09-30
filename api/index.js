// Vercel serverless entry: wraps the same Express app used by docker/dev.
// No listens — Vercel provides the HTTP context.
const { createApp } = require('../server/src/app');

const app = createApp();

module.exports = app;
