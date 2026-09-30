# LegacyAurora_WaypointDispatch

**Waypoint Delivery System** — dispatcher-approved route planning with hard feasibility validation, offline-first driver execution with idempotent sync, and live store-manager visibility. Built for the Rootcode Tech-Triathlon hackathon.

## Quick start (judges)

```bash
git clone <repo-url>
cd LegacyAurora_WaypointDispatch
docker compose up
# open http://localhost:8080
```

First boot automatically migrates the schema and seeds **one deterministic, deliberately overloaded Peliyagoda delivery day (2026-06-25)** — 58 orders across Fresh/Style/Tech, verified to force deferrals. Every fresh clone produces the identical demo day.

## Seeded accounts

| Role | Username | Password | Lands on |
|---|---|---|---|
| Dispatcher | `dispatcher` | `dispatch123` | dispatcher.html |
| Driver | `driver` | `drive123` | driver.html |
| Loader | `loader` | `load123` | loader.html |
| Store Manager | `manager` | `manage123` | store.html |

## Judge walkthrough (numbered)

1. `docker compose up` → open http://localhost:8080 → login **dispatcher / dispatch123**. The Order Queue shows the seeded day; the capacity verdict banner reports the **reefer shortfall** (chilled demand exceeds reefer volume).
2. Click **Auto-allocate**. The engine proposes trips (weight/volume bars, time budgets, fuel) plus deferred orders with reason codes **CAP / REF / INV**. Review, then **Commit Plan** — hard validation runs again server-side before anything is persisted.
3. Open **loader / load123** (tablet viewport). Trip 1 manifest lists stops in sequence. **Flag Shortage** on an order (photo + reason) → the flag is stored dock-side.
4. Open **driver / drive123** (phone viewport). Stop list loads from the manifest. Go offline (devtools airplane / disconnect Wi-Fi) → capture a POD → the outbox banner shows "N queued". Reconnect → the sync drawer shows **"N records accepted · duplicates deduped"**.
5. Open **manager / manage123** → the outlet timeline shows live events, a **pinned deferral notice**, and the receipt flow. Report missing eggs → the receipt **auto-matches the loader's dock flag**.
6. Back as dispatcher: **Deferral Ledger** shows reason codes, promise dates and kept/broken tracking. Toggle **telemetry outage** on a vehicle → staleness state persists and shows on the fleet board.

## Architecture

```
Browser (5 vanilla pages, untouched Day-5 design)
  /api/*  →  Express (Node 20)
               ├── auth: bcrypt + JWT httpOnly cookie, role middleware
               ├── allocation engine (greedy, deterministic) + pure validator
               ├── trips/manifests, events batch (idempotent), flags, receipts                └── Prisma → PostgreSQL 16 (compose db service / Supabase in production)
```

- **Travel-time model** (from the datasets): `minutes = freeflow_min × (100/speed_index) × (100/disruption_index)`, with speed_index from `traffic_speed.csv` (district × hour × monsoon) and disruption from `road_conditions.csv` (district × date). Service allowances from `service_allowance.csv` (brand × dock type).
- **Allocation policy** (deterministic, explainable): chilled → deferredYesterday → tightest window → largest volume. Phase A: chilled onto reefers. Phase B: ambient onto anything. Hard validation blocks infeasible trips (brand/district homogeneity, depot, temp, van_only, weight/volume caps, time budgets Fresh ≤ 270 min / Style/Tech ≤ 480, windows, fuel). Overflow → deferrals with reason codes and promise dates.
- **Offline contract:** client UUID per event; `/api/events/batch` dedupes on the unique `eventId` (replayed syncs return `duplicate`, never double-record). Completed PODs bind to outlets, not stop sequence — re-sequencing never mutates delivered records.

## Deployment

- **Production:** Vercel (static client + Express serverless fn) + **Supabase** Postgres. Set `DATABASE_URL` and `JWT_SECRET` in the Vercel project env. Use Supabase's **connection pooler** string (port 6543) for serverless functions — note it must be a *transaction-mode* URL, so the codebase avoids session-pinned interactive transactions by design.
- **Keep-alive:** an uptime monitor pings `/api/health` every 5 minutes so the demo link never sleeps.
- **CI:** every push runs unit tests, then boots the full `docker compose` stack and smoke-tests the judge walkthrough end-to-end (login ×4 roles, allocate → commit, offline-sync replay → `duplicate`, deferral ledger).

## Departures from the Day-5 design

1. **No nginx container.** The Express app serves the static client directly (one container, one origin, `/api` and pages on the same host). Functionally identical to the planned nginx + app pair; fewer moving parts to drift.
2. **Session auth upgraded** from sessionStorage flags to JWT in an httpOnly cookie (role pages still read the same sessionStorage shape for names/redirects, so the UX is unchanged).
3. **Dispatcher console renders live API data** in place of the static demo dataset; the visual layout matches the Day-5 design.
4. **Cross-district leg times** approximate via depot distances (trips are brand+district homogeneous, so this rarely triggers).
5. Demo day is fixed at **2026-06-25** (dataset calendar/road coverage ends 2026-06-28; chosen as an operating, monsoon, payday Thursday).

## Docs

- `docs/` — architecture diagram, data model, AI disclosure, original planning doc.
- `server/src/data/raw/` — competition datasets, unmodified.
