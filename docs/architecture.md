# Waypoint Dispatch — System Architecture & Data Topology

Comprehensive architectural documentation for the **Waypoint Delivery System**, illustrating how the four operational user roles, backend micro-services, and the PostgreSQL database interact in real-time and offline environments.

Interactive Architecture Map: [docs/architecture.html](architecture.html)  
Vector Architecture Diagram: [docs/architecture.svg](architecture.svg)  
Entity Relationship Data Model: [docs/data-model.svg](data-model.svg)

---

## 1. System Overview & Tiering

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 TIER 1: THE FOUR USER ROLES                                      │
│                                                                                                  │
│  1. Dispatcher (Desktop)      2. Loader (Tablet)        3. Driver (Mobile PWA)   4. Store Manager│
│     client/dispatcher.html       client/loader.html        client/driver.html       client/store │
│     • WDI Order Queue (Scarcity) • Reverse-Drop Manifest   • Leaflet Navigation     • Order Modals│
│     • Allocation & Commit        • Shortage Flagging       • Offline Outbox Sync    • Live Timeline│
│     • Deferral Ledger            • Dock Notes & Summaries  • POD Photo Capture      • Auto-Match   │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                                │
                 HTTPS REST API (JWT httpOnly Cookie) + Server-Sent Events (SSE Realtime Stream)
                                                │
┌───────────────────────────────────────────────▼──────────────────────────────────────────────────┐
│                               TIER 2: EXPRESS BACKEND SERVICE                                    │
│                                                                                                  │
│  ├── Allocation & Feasibility Engine (/api/plan/allocate, /api/plan/commit, engine.js, validate) │
│  ├── Authentication & RBAC Security (/api/auth/login, requireRole, bcrypt, rate limiters)       │
│  ├── Realtime SSE Stream & Hub (/api/stream, realtime.js targeted channels)                      │
│  ├── Idempotent Offline Sync Bus (/api/events/batch, idempotency.js 24h replay deduplication)   │
│  ├── Ops, Flags & Receipts (/api/flags, /api/receipt auto-match, /api/telemetry outage toggle)   │
│  └── Analytics & Deferrals Aggregator (/api/analytics/summary, /api/deferrals)                   │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                                │ Prisma ORM
┌───────────────────────────────────────────────▼──────────────────────────────────────────────────┐
│                           TIER 3: POSTGRESQL 16 RELATIONAL STORE                                 │
│                                                                                                  │
│  • User (Credentials & Role Gates)                  • Outlet (120 Stores, Windows & Docks)       │
│  • Vehicle (60 Reefers, Trucks & Vans)              • Order (58 Seeded Multi-Brand Orders)       │
│  • Trip & TripStop (Committed Routes & Drop Stops)  • DeliveryEvent (Idempotent UUID Sync Log)   │
│  • ShortageFlag (Dock Damage/Shortage Records)      • DeferralLedger (Explainable SLA Promises)  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The Four User Roles

### 1. Dispatcher (`client/dispatcher.html`)
- **Environment:** Desktop workstation in the Peliyagoda Planning Office.
- **Key Capabilities:**
  - **WDI Order Queue:** Real-time post-cutoff queue grouped into Fresh, Chilled, Ambient, Style, and Tech categories with automatic scarcity sorting.
  - **Capacity & Re-balancing Engine:** Greedy deterministic routing that satisfies temperature requirements (chilled $\rightarrow$ reefer), outlet physical constraints (`van_only`), weight/volume limits, and brand time budgets (Fresh $\le 270\text{ min}$, Style/Tech $\le 480\text{ min}$).
  - **Plan Commit:** Enforces server-side hard feasibility checks before persisting trips and publishing real-time notifications to drivers and loaders.
  - **Deferral Ledger:** Explains and tracks deferral decisions (`CAP` for capacity overflow, `REF` for reefer shortfall, `INV` for feasibility breach) with promise-date tracking.
  - **Live Runs & Telemetry Radar:** Monitors real-time vehicle transit, stop completion, exception alerts, and simulated telemetry outages.

### 2. Dock Loader (`client/loader.html`)
- **Environment:** Shared warehouse tablets (768px viewport) at Peliyagoda and Kandy docks with Glove Mode support.
- **Key Capabilities:**
  - **Reverse-Sequence Loading:** Displays manifests where the last stop is staged and loaded first, ensuring seamless unloading for drivers.
  - **Shortage Flagging:** Allows dock loaders to flag missing or damaged items with photo evidence and descriptions before vehicle departure.
  - **Live Manifest Synchronization:** Reacts to SSE events (`plan-committed`, `order-allocated`) to immediately reload bay assignments and manifests.
  - **Dock Handover Notes:** Records shift communications and trip release authorizations.

### 3. Fleet Driver (`client/driver.html`)
- **Environment:** Mobile smartphones (390px viewport) in vehicle cabins.
- **Key Capabilities:**
  - **Offline-First PWA:** Implements an offline outbox (`client/outbox.js`) allowing drivers to capture arrival, unloading, and departure events without mobile connectivity.
  - **Interactive Route Map:** Leaflet/MapLibre map with numbered route sequence, geofencing, and delivery window tracking.
  - **Proof of Delivery (POD):** Captures customer signature, receiver name, camera photos, and delivery outcome logs.
  - **Idempotent Batch Sync:** Sends queued mutations to `/api/events/batch` with client-generated `eventId`s; duplicate events are safely ignored without double-recording.

### 4. Store Manager (`client/store.html`)
- **Environment:** Outlet checkout counter (desktop or mobile) across 120 retail outlets.
- **Key Capabilities:**
  - **Real-Time Order Placement:** Modal interface for placing daily Fresh, weekly Style, or as-needed Tech orders before the 16:00 cutoff.
  - **Live Delivery Timeline:** Real-time progress bar with live driver ETA and pinned deferral notices for skipped runs.
  - **Goods Receipt & Auto-Match:** Confirms received goods at `/api/receipt`; discrepancies automatically match dock shortage flags submitted by loaders.

---

## 3. Communication & Synchronization Architecture

### A. Real-Time Server-Sent Events (SSE) Mesh
The backend maintains role-gated SSE channels (`/api/stream`):
- `dispatcher`: WDI order queue updates, driver progress, shortage flags, vehicle status.
- `driver:<vehicleId>`: Trip assignments, route updates, departure clearances.
- `loader:<vehicleId>`: Plan commitments, vehicle bay loading assignments.
- `store:<outletId>`: Order confirmations, dispatch alerts, arrival ETAs, deferral notices.

### B. Offline Sync & Idempotency Guarantee
1. **Mutation Queue:** When offline, client actions (driver PODs, store receipts, dock flags) are queued in `localStorage`.
2. **Client UUID Keys:** Every mutation carries a unique `clientRef` or `eventId`.
3. **Idempotency Replay Buffer:** The server (`server/src/idempotency.js`) stores the initial response for 24 hours. Replayed requests receive the exact original response with status code `200` and `"status": "duplicate"`, completely preventing double mutations.
