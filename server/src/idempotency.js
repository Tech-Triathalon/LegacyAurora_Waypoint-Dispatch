// In-memory idempotency store for queued offline mutations.
//
// The client offline queue stamps every queued write with a `clientRef` (UUID).
// When the connection returns, the queue replays: if the first attempt actually
// reached the server (response lost in flight), a naive retry would double-apply.
// The store remembers the response for each clientRef for 24h and replays it.
//
// Bounded: max 10k entries, LRU eviction — enough for offline fleet days while
// keeping memory flat. Swap for Redis when running multi-instance.
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10000;

const store = new Map(); // clientRef -> { at, status, body }

function sweep(now) {
  for (const [key, entry] of store) {
    if (now - entry.at > TTL_MS) store.delete(key);
  }
}

function middleware(req, res, next) {
  const clientRef = req.body && typeof req.body.clientRef === 'string' ? req.body.clientRef : null;
  if (!clientRef) return next();

  const now = Date.now();
  const hit = store.get(clientRef);
  if (hit && now - hit.at <= TTL_MS) {
    // Move to end (LRU) and replay the recorded response verbatim.
    store.delete(clientRef);
    store.set(clientRef, hit);
    res.setHeader('X-Idempotent-Replay', 'true');
    return res.status(hit.status).json(hit.body);
  }

  // Capture the first real response for this clientRef.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) {
      try {
        if (store.size >= MAX_ENTRIES) {
          const oldest = store.keys().next().value;
          if (oldest !== undefined) store.delete(oldest);
        }
        store.set(clientRef, { at: now, status: res.statusCode, body });
      } catch { /* never break the response */ }
    }
    return originalJson(body);
  };
  return next();
}

function _reset() { store.clear(); }
function _size() { return store.size; }

module.exports = { middleware, _reset, _size };
