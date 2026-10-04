const { loadEnv } = require('./env');
loadEnv();

const { PrismaClient } = require('@prisma/client');

// Singleton PrismaClient — one connection pool per process.
// Global cache for serverless environments (e.g. Vercel) to reuse client across lambdas.
const prisma = globalThis.__waypoint_prisma__ || new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

if (process.env.NODE_ENV !== 'production' || process.env.VERCEL) {
  globalThis.__waypoint_prisma__ = prisma;
}

// Surface async pool failures without crashing the process; /api/health stays truthful.
process.on('unhandledRejection', (err) => {
  console.error('[prisma] unhandled rejection:', err && err.code ? err.code : '', err && err.message);
});

async function dbHealth() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.code || 'DB_UNREACHABLE', latencyMs: Date.now() - started };
  }
}

module.exports = prisma;
module.exports.dbHealth = dbHealth;
module.exports.default = prisma;

