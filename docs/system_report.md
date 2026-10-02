# LegacyAurora WaypointDispatch — System Report & Enhancement Plan

---

## 1. Current System Overview

**Project Name:** LegacyAurora_WaypointDispatch  
**Origin:** Rootcode Tech-Triathlon Hackathon  
**Stack:** Vanilla HTML/CSS/JS (Frontend) · Node.js + Express (Backend) · Prisma ORM · PostgreSQL 16  
**Deployment:** Docker Compose (local) · Vercel + Supabase (cloud)

---

## 2. Current Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Browser — 5 standalone vanilla HTML pages                │
│   index.html · dispatcher.html · driver.html             │
│   loader.html · store.html                               │
│   + sw.js (service worker cache) + outbox.js (offline)   │
└──────────────────┬───────────────────────────────────────┘
                   │ fetch() + JWT httpOnly cookie
┌──────────────────▼───────────────────────────────────────┐
│ Express (Node 20) — single process serving API + static  │
│  /api/auth          JWT login/logout/me                  │
│  /api/orders        Queue + capacity verdict banner       │
│  /api/plan/allocate Greedy dry-run allocation            │
│  /api/plan/commit   Hard validate + persist              │
│  /api/trips/*       Driver & loader manifests            │
│  /api/events/batch  Offline sync (idempotent by eventId) │
│  /api/flags         Loader shortage (photo base64)       │
│  /api/outlet/:id/timeline  Manager timeline              │
│  /api/receipt       Goods receipt + flag auto-match      │
│  /api/telemetry/*   Fleet board + outage simulation      │
│  /api/health        Liveness probe                       │
└──────────────────┬───────────────────────────────────────┘
                   │ Prisma Client
┌──────────────────▼───────────────────────────────────────┐
│ PostgreSQL 16                                            │
│  User · Outlet · Vehicle · Order · Trip · TripStop       │
│  DeliveryEvent · ShortageFlag · DeferralLedger           │
└──────────────────────────────────────────────────────────┘
```

---

## 3. What Each Portal Currently Does

### 🔐 Login Page (`index.html`)
- Simple form with role-based quick-fill buttons
- **Currently:** Calls `/api/auth/login` (real JWT), then redirects to role pages
- Login stores sessionStorage object `delivery_auth_user` for role pages

### 🛰️ Dispatcher Portal (`dispatcher.html`) — 4,537 lines
- **Screens:** Order Queue · Fleet Board & Allocation · Live Runs · Deferral Ledger · Work Pool · Map View · Schedule · Exceptions · Driver Roster · Analytics · Settings
- **Real API calls made:** Calls `/api/auth/login`, `/api/orders`, `/api/plan/allocate`, `/api/plan/commit`, `/api/orders/:id/defer`, `/api/deferrals`, `/api/telemetry/fleet`
- **Mostly static/hardcoded UI:** Live Runs screen, Map View (canvas placeholder with fake points), Exceptions Hub, Driver Roster, Analytics — all render hardcoded demo data
- **Auth:** Has its own secondary auth form inside the page (not using the central login page properly — hardcodes `if user === 'dispatcher'` check client-side)
- **No real-time:** Refreshes only on page load or manual user action (no polling, no WebSockets)
- **Map:** Canvas-drawn placeholder grid with hardcoded fleet dot positions

### 🚚 Driver Portal (`driver.html`) — 2,123 lines  
- **Mobile-phone frame UI** with multiple tab screens
- **Screens:** Overview · Route/Stops · Stop Detail (POD signature) · Offline/Connectivity · Deferral
- **Offline-first outbox:** `outbox.js` queues events to localStorage, flushes on reconnect via `/api/events/batch`
- **Auth:** Has its own secondary in-page auth form (hardcoded credential check: `if user === 'driver' && pass === 'drive123'`)
- **Manifest loading:** Route `GET /api/trips/for-driver` exists server-side but **the driver page does NOT call it** — stops are fully hardcoded in HTML
- **POD actions** (arrived, pod, issue events) call `WaypointOutbox.enqueue()` (offline-safe) but these are also largely wired to static demo data
- **No real dispatcher-to-driver sync:** Driver does not receive updated routes after dispatcher commits a plan

### 📦 Loader Portal (`loader.html`) — 2,335 lines
- **Tablet-optimized UI** with screens for load plan, shortage flags, vehicle checklist
- **Auth:** Has own secondary auth form (hardcoded)
- **Manifest:** Route `GET /api/trips/:vehicleCode` exists but **loader page does NOT call it** — load plan is fully hardcoded in HTML
- **Shortage Flag:** `POST /api/flags` route exists and is wired, but the loader page's flag form appears to use local state only
- **No real allocation reflection:** Dispatcher's committed plan does not update the loader's screen dynamically

### 🏪 Store Manager Portal (`store.html`) — 1,580 lines
- **Mobile-optimized UI** with 3 tabs: Order Status · Tracking · Receipt
- **Auth:** Has own secondary auth form (hardcoded: `if user === 'manager' && pass === 'manage123'`)
- **Timeline:** `GET /api/outlet/:id/timeline` route exists but **the store page does NOT call it** — timeline is fully hardcoded in HTML
- **Receipt:** `POST /api/receipt` route exists but **the receipt form does not call it** — just shows a toast
- **No real delivery status:** Driver POD events do not reflect on store manager's screen

---

## 4. Backend Capabilities (What the Server Already Supports)

The backend is **well-engineered** and actually supports most of the real-time data flows — the problem is the frontend doesn't use them:

| API Endpoint | What it Does | Currently Used By Frontend? |
|---|---|---|
| `POST /api/auth/login` | JWT auth | ✅ Login page only |
| `GET /api/orders` | Order queue + capacity verdict | ✅ Dispatcher |
| `POST /api/plan/allocate` | Dry-run allocation | ✅ Dispatcher |
| `POST /api/plan/commit` | Persist plan | ✅ Dispatcher |
| `POST /api/orders/:id/defer` | Manual defer | ✅ Dispatcher |
| `GET /api/deferrals` | Deferral ledger | ✅ Dispatcher |
| `GET /api/trips/for-driver` | Driver manifest | ❌ NOT used by driver.html |
| `GET /api/trips/:vehicleCode` | Loader manifest | ❌ NOT used by loader.html |
| `POST /api/events/batch` | Driver offline sync | ✅ via outbox.js |
| `POST /api/flags` | Loader shortage flag | ❌ NOT called in loader.html |
| `GET /api/flags` | View shortage flags | ❌ NOT used |
| `GET /api/outlet/:id/timeline` | Store manager timeline | ❌ NOT called in store.html |
| `POST /api/receipt` | Goods receipt | ❌ NOT called in store.html |
| `GET /api/telemetry/fleet` | Fleet board | ✅ Dispatcher |
| `POST /api/telemetry/outage` | Toggle stale flag | ✅ Dispatcher |

---

## 5. Database Schema Strengths

The Prisma schema is solid:
- `User` linked to `Vehicle` (driver) or `Outlet` (manager) by foreign key
- `Order` → `TripStop` → `Trip` → `Vehicle` chain is complete
- `DeliveryEvent` has unique `eventId` for idempotent offline sync
- `ShortageFlag` links to orders with photo path and status lifecycle
- `DeferralLedger` tracks reason codes, promise dates, and kept/broken status
- `TripStatus` enum: `planned → loading → departed → completed`
- `OrderStatus` enum: `queued → allocated → deferred → delivered`

---

## 6. Critical Gaps — What's Missing

### ❌ 6.1 NO Real-Time Communication
This is the **biggest gap**. There is **zero WebSocket / SSE / polling** infrastructure:
- Dispatcher commits a plan → Driver screen is NOT updated
- Driver marks a delivery → Dispatcher screen is NOT updated
- Loader flags a shortage → Dispatcher is NOT notified
- Store manager is NOT notified of any driver movement
- All "live" updates on the dispatcher screen are fake (static DOM timestamps updated by `setInterval`)

### ❌ 6.2 No Unified Home Page / System Hub
- There is **no dashboard home page** that acts as a unified entry point showing all 4 portals
- `index.html` is only a login form — after login, users are hard-redirected to their portal
- There is no "admin overview" or system status hub

### ❌ 6.3 Store Manager Cannot Place Orders
- The Store Manager portal has **no order creation flow**
- The schema and backend have no `POST /api/orders` endpoint (orders are only seeded via `prisma/seed.js`)
- Order placement → Dispatcher queue update flow is completely missing

### ❌ 6.4 Frontend Auth is Broken / Duplicated
- Each portal has **its own hardcoded credential check** (`if user === 'dispatcher' && pass === 'dispatch123'`) — meaning auth works even without the backend
- This bypasses the real JWT system
- The central `index.html` login does call the real `/api/auth/login` but each sub-page re-checks sessionStorage with its own hardcoded logic rather than validating the JWT cookie with `/api/auth/me`

### ❌ 6.5 Driver Gets Hardcoded Route (Not Dispatcher's Plan)
- The driver page HTML contains hardcoded stop lists
- `GET /api/trips/for-driver` is never called
- A dispatcher can commit a plan, but the driver sees the same static stops regardless

### ❌ 6.6 Loader Gets Hardcoded Load Plan (Not Dispatcher's Plan)
- The loader page HTML contains a hardcoded manifest
- `GET /api/trips/:vehicleCode` is never called
- Loader has no live knowledge of what was actually committed

### ❌ 6.7 No Live GPS / Location Tracking
- The map on the dispatcher page is a canvas placeholder with random points
- No GPS coordinates in the database schema
- No driver location reporting mechanism

### ❌ 6.8 No Store Manager Order Tracking (Real)
- `GET /api/outlet/:id/timeline` is never called from store.html
- Delivery status (allocated → departed → arrived → delivered) is not shown dynamically

### ❌ 6.9 No Inter-Portal Notification System
- No push notifications, no toast alerts from other portals
- Dispatcher cannot message driver; loader cannot alert dispatcher of a critical shortage in real-time

### ❌ 6.10 Fixed Demo Date
- System is hardcoded to demo date `2026-06-25` (`DEMO_DAY` constant in orders.js)
- Cannot operate on today's actual date or future dates
- New orders placed by a store manager would need date flexibility

### ❌ 6.11 No Vehicle Status Lifecycle Integration
- `Vehicle.status` field (`available | assigned | maintenance`) is never updated when a trip is committed or departed
- Trip status (`planned → loading → departed → completed`) exists in DB but no UI drives these transitions (driver page doesn't call the API)

### ❌ 6.12 Analytics is 100% Static
- Analytics screen in dispatcher.html is fully hardcoded HTML with fake KPI numbers
- No real data aggregation from the database

---

## 7. Enhancement Plan — Making it a Fully Functional Unified System

### 🏗️ Phase 1 — Real-Time Infrastructure (Foundation)

**1.1 Add WebSocket / Server-Sent Events (SSE) Layer**
- Install `ws` or use native Node.js `EventEmitter` + SSE
- Server broadcasts events to connected clients by role/channel:
  - Channel: `dispatcher` — receives all events
  - Channel: `driver:{vehicleId}` — receives plan commits for their vehicle
  - Channel: `loader:{vehicleId}` — receives committed load plans
  - Channel: `store:{outletId}` — receives delivery status updates
- Every DB write (commit plan, POD event, flag, receipt) triggers a broadcast

**1.2 Add Real-Time Polling as Fallback**
- For clients without WS support, add interval polling for critical screens
- `GET /api/trips/for-driver` polled every 30s on driver page
- `GET /api/outlet/:id/timeline` polled every 20s on store page

---

### 🏠 Phase 2 — Unified System Hub (Home Page)

**2.1 Replace `index.html` Login with a System Hub**
- After successful login, redirect to a **Hub Page** (`hub.html`)
- Hub shows system health, active portals as cards, and role-based quick links
- System status banner: active trips, orders pending, fleet status counts
- For admin/dispatcher role: shows all 4 portal quick-access cards
- For driver/loader/manager: shows only their portal + system status

---

### 🏪 Phase 3 — Store Manager Order Placement

**3.1 Add `POST /api/orders` Endpoint**
- Store manager fills out an order form (brand, units, weight, temp requirement, delivery window)
- Server validates and creates order in `queued` status for the outlet
- Broadcasts to dispatcher channel: `new-order` event
- Dispatcher's Order Queue screen auto-updates (new order appears with "NEW" badge)

**3.2 Real-Time Queue Update on Dispatcher**
- Dispatcher's Order Queue uses SSE/WS to append new orders without page refresh
- Capacity verdict banner recalculates automatically when new order arrives

---

### 🗺️ Phase 4 — Dispatcher → Driver/Loader Flow

**4.1 Connect Plan Commit to Driver**
- When dispatcher calls `POST /api/plan/commit`:
  - Server broadcasts `plan-committed` event on `driver:{vehicleId}` channel
  - Driver page receives WS message, calls `GET /api/trips/for-driver` and re-renders the stop list
  - Driver sees the actual committed stops, not hardcoded HTML

**4.2 Connect Plan Commit to Loader**
- Same `plan-committed` broadcast on `loader:{vehicleId}` channel
- Loader page calls `GET /api/trips/:vehicleCode` and renders the real load manifest
- Vehicle status updated to `assigned` in DB on commit

---

### 🚚 Phase 5 — Driver → Dispatcher/Store Real-Time Updates

**5.1 Wire Driver Actions to Real API**
- Driver "Departed" button → `WaypointOutbox.enqueue({type:'departed', vehicleId, payload:{}})` → flush to `/api/events/batch`
- Driver "Arrived" button → enqueue `arrived` event with orderId
- Driver POD signature → enqueue `pod` event (order status → `delivered` in DB)
- Driver "Issue" → enqueue `issue` event with reason

**5.2 Real-Time Dispatcher Update from Driver Events**
- Server-side: after `POST /api/events/batch` persists events, broadcast on `dispatcher` channel
- Dispatcher's Live Runs screen updates: stop progress bar advances, timestamp recorded
- Vehicle position on map canvas updates (use stop sequence as proxy location)
- Trip status updates: `planned → departed` when first `departed` event arrives

**5.3 Real-Time Store Manager Update**
- After `pod` event arrives server-side, broadcast on `store:{outletId}` channel
- Store manager's timeline adds "Delivered" entry with timestamp
- If driver has a shortage issue, store is notified proactively (don't wait for manual receipt)

---

### 📦 Phase 6 — Loader → Dispatcher Shortage Flow

**6.1 Wire Loader Flag Form to Real API**
- Loader's shortage flag form calls `POST /api/flags` with orderId, itemDesc, qty, reason, photo
- Server broadcasts `shortage-flagged` event on `dispatcher` channel
- Dispatcher's Exceptions Hub shows real-time shortage alert (not hardcoded HTML)

**6.2 Store Manager Receipt Closes the Loop**
- Store manager receipt form calls `POST /api/receipt`
- Server auto-acknowledges matching open flags (`ShortageFlag.status → acknowledged`)
- Broadcasts `receipt-confirmed` on `dispatcher` channel → Dispatcher exceptions update

---

### 🗺️ Phase 7 — Live Driver Location Tracking

**7.1 Add GPS Coordinates to Schema**
- Add `latitude` and `longitude` columns to `DeliveryEvent` payload (already a JSON field — no schema change needed)
- Driver app collects `navigator.geolocation.getCurrentPosition()` on each action
- Include coordinates in event payload when available

**7.2 Live Map on Dispatcher**
- Replace canvas placeholder with a real map library (Leaflet.js — free, no API key)
- Plot vehicle positions from latest `departed` or `arrived` events with lat/lng
- Animate vehicle marker movement as new events arrive via WebSocket

---

### 🔐 Phase 8 — Auth Unification

**8.1 Remove All Hardcoded Credential Checks**
- Remove per-page `if user === 'dispatcher' && pass === 'dispatch123'` blocks
- All pages check auth via `GET /api/auth/me` (validates JWT cookie server-side)
- If 401 returned → redirect to central `index.html` login
- This makes auth centralized and token-based throughout

**8.2 Role-Based Redirect After Login**
- After `/api/auth/login` succeeds, server response includes `role`
- Login page redirects based on role:
  - `dispatcher` → `hub.html` (or `dispatcher.html`)
  - `driver` → `driver.html`
  - `loader` → `loader.html`
  - `manager` → `store.html`

---

### 📊 Phase 9 — Real Analytics

**9.1 Add Analytics Aggregation Endpoint**
- `GET /api/analytics/summary?date=YYYY-MM-DD`
- Returns: total orders, delivered count, deferred count, on-time %, fuel used, avg trip time
- Driven from `DeliveryEvent`, `Order`, `Trip` tables

**9.2 Wire Dispatcher Analytics Screen**
- Replace hardcoded KPI numbers with real API data
- Add date range picker for historical view

---

### 🔔 Phase 10 — Notification System

**10.1 In-App Notification Bell**
- Each portal has a notification bell icon
- Dispatcher: notified of new orders, shortage flags, critical exceptions
- Driver: notified of plan changes (new stop added, route updated)
- Store Manager: notified of ETA changes, deferral notices, delivery confirmed
- Notifications stored in DB (new `Notification` table) and delivered via SSE

---

## 8. Summary: What Needs to be Built vs. What Exists

| Feature | Backend | Frontend |
|---|---|---|
| Auth (JWT) | ✅ Done | ⚠️ Partially (bypassed per page) |
| Order Queue | ✅ Done | ✅ Dispatcher uses it |
| Auto-Allocation | ✅ Done | ✅ Dispatcher uses it |
| Plan Commit | ✅ Done | ✅ Dispatcher uses it |
| Driver Manifest | ✅ Done | ❌ Driver page doesn't call it |
| Loader Manifest | ✅ Done | ❌ Loader page doesn't call it |
| Offline Sync (events) | ✅ Done | ✅ outbox.js wired |
| Shortage Flags | ✅ Done | ❌ Loader page doesn't call it |
| Store Timeline | ✅ Done | ❌ Store page doesn't call it |
| Receipt | ✅ Done | ❌ Store page doesn't call it |
| Telemetry Board | ✅ Done | ✅ Dispatcher uses it |
| **WebSockets / SSE** | ❌ Missing | ❌ Missing |
| **Unified Hub Home** | ❌ Missing | ❌ Missing |
| **Store Order Placement** | ❌ Missing | ❌ Missing |
| **Real GPS Tracking** | ❌ Missing | ❌ Missing |
| **Real Analytics API** | ❌ Missing | ❌ Missing |
| **Notification System** | ❌ Missing | ❌ Missing |
| **Vehicle Status Lifecycle** | ❌ Not driven | ❌ Not driven |
| **Trip Status Progression** | ❌ Not driven | ❌ Not driven |

---

## 9. Recommended Tech Stack for Full-Stack Enhancement

| Layer | Current | Recommended Addition |
|---|---|---|
| Real-time | None | **SSE (Server-Sent Events)** — no extra lib, native Node.js; or `ws` WebSocket lib |
| Map | Canvas placeholder | **Leaflet.js** (free, open-source, no API key) |
| Frontend framework | None (vanilla) | Keep vanilla for portals, add a **hub.html** as unified entry |
| Database | PostgreSQL + Prisma | Add `Notification` table; no engine change needed |
| Deployment | Docker + Vercel | Add WebSocket-compatible hosting if using Vercel (use SSE instead for Vercel serverless) |

---

## 10. Recommended Implementation Order

```
Priority 1 (Core Real-Time):
  ① Add SSE endpoint on server (GET /api/stream?channel=dispatcher|driver|loader|store)
  ② Wire plan/commit broadcast → driver and loader channels
  ③ Wire events/batch broadcast → dispatcher and store channels
  ④ Remove hardcoded auth per page; use /api/auth/me

Priority 2 (Missing Frontend Wiring):
  ⑤ driver.html calls GET /api/trips/for-driver on load + SSE reconnect
  ⑥ loader.html calls GET /api/trips/:vehicleCode on load + SSE reconnect
  ⑦ store.html calls GET /api/outlet/:id/timeline on load + SSE reconnect
  ⑧ loader.html shortage flag form calls POST /api/flags
  ⑨ store.html receipt form calls POST /api/receipt

Priority 3 (New Features):
  ⑩ Add POST /api/orders endpoint for store manager order placement
  ⑪ Build hub.html — unified system home with role-based portal cards
  ⑫ Add Leaflet.js map to dispatcher with real vehicle event positions
  ⑬ Add GET /api/analytics/summary endpoint + wire dispatcher analytics screen
  ⑭ Add Notification table + notification bell across all portals
```

---

> **Bottom line:** The backend is ~80% production-ready. The frontend is ~30% wired to real data. The critical missing piece is real-time infrastructure (SSE/WebSockets) and properly connecting each portal to the API endpoints that already exist. Once the real-time layer is in place and the portals are properly wired, the system will behave as a truly unified, live delivery operations platform.
