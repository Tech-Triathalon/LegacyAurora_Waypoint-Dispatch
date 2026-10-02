// Singleton PrismaClient — one connection pool per process.
// Every module imports this instead of constructing its own client
// (previously auth.js, routes/orders.js, routes/ops.js and realtime.js
// each spawned one, exhausting Supabase pooler connections under load).
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

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
