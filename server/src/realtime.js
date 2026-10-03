// Realtime fan-out: in-process pub/sub + Server-Sent Events endpoint.
//
// Every DB write of consequence (plan commit, driver event, shortage flag,
// receipt, new order) publishes here; portals subscribe by channel:
//   dispatcher             — all operational events (queue, fleet, exceptions)
//   driver:{vehicleId}     — plan commits / manifest changes for one vehicle
//   loader:{vehicleId}     — committed load plans for one vehicle (plus role-level 'loader')
//   store:{outletId}       — delivery progress for one outlet
//
// Transport is SSE (not WebSocket): same-origin GET, survives the serverless
// story better, needs no extra dependency, and auto-reconnects in the browser.
// Envelope on the wire: data: {"type","data","channel","ts"}
const express = require('express');
const prisma = require('./prisma');
const { requireAuth } = require('./auth');

function createRealtimeBus(prisma) {
  const router = express.Router();

  let nextClientId = 1;
  const clients = new Map(); // id -> { res, channels:Set<string> }

  function sseWrite(res, chunk) {
    try { res.write(chunk); } catch { /* client vanished mid-write */ }
  }

  function clientCount() {
    return clients.size;
  }

  // publish(channel, type, data) → deliveries. Fire-and-forget; write failures are ignored.
  function publish(channel, type, data = {}) {
    const envelope = `data: ${JSON.stringify({ type, data, channel, ts: new Date().toISOString() })}\n\n`;
    let delivered = 0;
    for (const c of clients.values()) {
      if (c.channels.has(channel)) {
        sseWrite(c.res, envelope);
        delivered += 1;
      }
    }
    return delivered;
  }

  function publishAll(channels, type, data = {}) {
    let n = 0;
    for (const ch of channels) n += publish(ch, type, data);
    return n;
  }

  // Channels a user may watch. DB lookup resolves driver→vehicle and manager→outlet;
  // if the DB is unreachable we degrade to role-level channels so streams still open.
  async function allowedChannels(user) {
    if (!user) return [];
    try {
      if (user.role === 'dispatcher') return ['dispatcher'];
      if (user.role === 'loader') return ['loader'];
      if (user.role === 'driver') {
        const u = await prisma.user.findUnique({ where: { username: user.username }, include: { vehicle: true } });
        if (!u || !u.vehicle) return [];
        return [`driver:${u.vehicle.id}`, `driver:${u.vehicle.vehicleId}`];
      }
      if (user.role === 'manager') {
        const u = await prisma.user.findUnique({ where: { username: user.username }, include: { outlet: true } });
        if (!u || !u.outlet) return [];
        return [`store:${u.outlet.outletId}`];
      }
      return [];
    } catch (err) {
      console.error('[realtime] channel lookup failed, using role fallback:', err.code || err.message);
      if (user.role === 'dispatcher') return ['dispatcher'];
      if (user.role === 'loader') return ['loader'];
      return [];
    }
  }

  // GET /api/stream?channels=a,b — SSE. Authenticated; channels are intersected
  // with the role's allow-list so a driver can never watch another vehicle.
  router.get('/stream', requireAuth, async (req, res) => {
    const allowed = await allowedChannels(req.user);
    const requested = String(req.query.channels || '').split(',').map((s) => s.trim()).filter(Boolean);
    const channels = requested.length ? requested.filter((ch) => allowed.includes(ch)) : allowed;
    if (channels.length === 0) {
      return res.status(403).json({ error: 'no channels available for this account' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();

    const id = nextClientId++;
    clients.set(id, { res, channels: new Set(channels) });

    sseWrite(res, `retry: 3000\n\n`);
    sseWrite(res, `data: ${JSON.stringify({ type: 'hello', data: { channels }, channel: 'meta', ts: new Date().toISOString() })}\n\n`);

    // Comment heartbeat keeps proxies from closing the idle connection.
    const heartbeat = setInterval(() => sseWrite(res, ':hb\n\n'), 25000);

    // Vercel serverless functions have a hard response-time limit (10 s Hobby,
    // 25 s Pro). Close the SSE stream gracefully just before that limit so the
    // browser's EventSource auto-reconnects instead of hitting a hard error.
    // The `retry` header above tells the client to wait 3 s before reconnecting.
    const SSE_TIMEOUT_MS = Number(process.env.SSE_TIMEOUT_MS) || 24000; // 24 s default
    const timeout = setTimeout(() => {
      sseWrite(res, `data: ${JSON.stringify({ type: 'reconnect', data: {}, channel: 'meta', ts: new Date().toISOString() })}\n\n`);
      clearInterval(heartbeat);
      clients.delete(id);
      res.end();
    }, SSE_TIMEOUT_MS);

    req.on('close', () => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      clients.delete(id);
    });
  });

  return { router, publish, publishAll, allowedChannels, clientCount };
}

// Default bus used by every route module (shared registry via require cache).
const defaultBus = createRealtimeBus(prisma);
const router = defaultBus.router;
const publish = defaultBus.publish;
const publishAll = defaultBus.publishAll;
const allowedChannels = defaultBus.allowedChannels;
const clientCount = defaultBus.clientCount;

module.exports = { createRealtimeBus, router, publish, publishAll, allowedChannels, clientCount };
