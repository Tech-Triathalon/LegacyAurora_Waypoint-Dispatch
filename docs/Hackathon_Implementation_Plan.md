# Waypoint Delivery System — Hackathon Technical Implementation Plan
**Team: [Legacy Aurora] · Deadline: Sunday, October 4, 2026, 23:59 Sri Lanka time**
**Starting asset:** Working static prototype (index / dispatcher / driver / loader / store, self-contained HTML+CSS+JS, sessionStorage auth, deployed on GitHub Pages)

---

## 0. What the Judges Require (from the booklet)

| Requirement | Where it's judged |
|---|---|
| Responsive web app; judge completes full workflow across all 4 roles | Functional completeness |
| Driver + loader experiences on **phone-sized screens** | Functional completeness |
| Plans respect constraints: capacity, temperature, outlet access, windows, fuel quotas | Planning & allocation engine |
| Demand > capacity day handled; allocation + deferred orders produced | Planning & allocation engine |
| Offline work + reconciliation on reconnect | Degradation, offline operation, recovery |
| Fidelity to Day-5 design; departures documented | Fidelity |
| `docker compose up` starts full stack + DB + seed | Engineering quality |
| README: setup, seeded accounts, **numbered judge walkthrough**, departures | Engineering quality |
| docs/: architecture diagram, data model, AI disclosure | Engineering quality |
| Deployed public URL, 4 seeded accounts, live through review + finale | Demo video + overall |
| 5–8 min demo video: all 4 roles + brief code explanation | Demo video |

**Continuity rule:** the Designathon design is your implementation spec. Document any significant departure in the README.

---

## 1. Target Architecture

Keep your proven front-ends; wrap them with a real backend. Do **not** rewrite the UI in a framework — fidelity to the Day-5 design scores 10%, and your screens already match it.

```
┌─────────────────────────────────────────────────────────┐
│  nginx (serves static frontend)                         │
│  ├── /            → index.html (login)                  │
│  ├── /api/*       → reverse proxy to backend            │
└──────────────┬──────────────────────────────────────────┘
               │
┌──────────────▼──────────────┐   ┌───────────────────────┐
│  Node.js + Express API      │   │  PostgreSQL 16        │
│  ├── /api/auth              │   │  (seeded with shared  │
│  ├── /api/orders            │   │   datasets + 1        │
│  ├── /api/plan / allocate   │   │   realistic day)      │
│  ├── /api/trips / stops     │   └───────────────────────┘
│  ├── /api/pod / sync        │
│  └── /api/deferrals         │
└─────────────────────────────┘
```

**Stack decisions (locked, do not re-litigate mid-week):**
- **Backend:** Node.js + Express — one language across your existing JS front-ends.
- **ORM:** Prisma (migrations + typed client; saves days vs raw SQL).
- **DB:** PostgreSQL 16 in Docker. (Booklet says compose must start "the database" — Postgres is the expected answer.)
- **Auth:** bcrypt-hashed passwords, JWT in httpOnly cookie, 4 seeded role accounts (keep the Day-5 demo credentials so the walkthrough stays familiar: dispatcher/dispatch123, driver/drive123, loader/load123, manager/manage123).
- **Frontend:** your current files, refactored so hardcoded data comes from `/api/*` calls. Vanilla JS + fetch is fine.
- **Offline (driver):** localStorage outbox queue + Service Worker for shell caching + background sync endpoint.
- **Deploy:** a $4–6 VPS (Hetzner/DigitalOcean) or Render/Railway. **GitHub Pages cannot run the backend.** Keep-alive matters through review + semifinal + finale — free-tier sleeping services are a risk; if you use a free tier, enable always-on or pick a VPS.

---

## 2. Monorepo Structure (must be named `TeamName_SolutionName`)

```
TeamName_WaypointDispatch/
├── docker-compose.yml          # root, required
├── .env.example                # root, required
├── README.md                   # required: setup + accounts + walkthrough + departures
├── docs/
│   ├── architecture.png        # diagram of the stack above
│   ├── data-model.png          # ER diagram (Prisma generate or draw.io)
│   └── AI_DISCLOSURE.md        # required
├── server/
│   ├── Dockerfile
│   ├── prisma/schema.prisma
│   ├── prisma/seed.js          # loads datasets + generates delivery day
│   ├── src/
│   │   ├── index.js            # express app entry
│   │   ├── auth.js             # login, middleware
│   │   ├── routes/             # orders, plan, trips, pod, sync, deferrals
│   │   ├── allocation/         # THE ENGINE (see §4)
│   │   │   ├── engine.js       # greedy allocator
│   │   │   └── validate.js     # feasibility checker (shared w/ tests)
│   │   └── data/               # CSVs (outlets, vehicles, calendar)
├── client/
│   ├── Dockerfile              # nginx serving your 5 HTML files
│   └── *.html                  # current prototype, API-wired
└── scripts/
    └── check_allocation.js     # CI-able feasibility validator
```

---

## 3. Data Model (Prisma entities)

- **User** (id, username, passwordHash, role, name)
- **Outlet** (outletId, brand, district, depot, dockType, parkingConstraint, mallWindow, windowOpen, windowClose) ← from outlets.csv
- **Vehicle** (vehicleId, type, temp, weightCap, volumeCap, fuelType, kmPerL, weeklyFuelQuota, depot, status) ← from vehicles.csv
- **Order** (id, outletId, brand, district, depot, tempRequirement, units, weightKg, volumeM3, orderDate, windowOpen, windowClose, deferredYesterday, status: queued|allocated|deferred|delivered, deferralReason, promiseDate)
- **Trip** (id, vehicleId, tripNo (1|2), brand, district, depot, totalWeight, totalVolume, estMinutes, status)
- **TripStop** (id, tripId, seq, orderId, plannedArrival)
- **DeliveryEvent** (id, orderId, type: loaded|departed|arrived|pod|issue|receipt, payload JSON, clientTimestamp, serverTimestamp, syncedFlag)
- **ShortageFlag** (id, orderId, itemDesc, qty, reason, photoPath, createdBy, createdAt)
- **DeferralLedger** mirrors Order deferral fields + kept|broken promise tracking.

**Seed data (required):** load `outlets.csv` (120), `vehicles.csv` (60), `calendar.csv`, then generate **one realistic Peliyagoda delivery day**: ~55–70 orders across Fresh (with chilled subset), Style, Tech; include van_only outlets, mall windows, several chilled orders exceeding reefer capacity **so the judge's day forces deferrals**, plus 2–3 orders pre-flagged `deferredYesterday=1` to demo consecutive-skip protection.

---

## 4. The Allocation Engine (the scoring centerpiece)

**Approach: assisted planning with hard validation** — system proposes, dispatcher approves. (Fully manual with validation is allowed too, but a working proposal demos "Planning and allocation engine" points directly.)

Algorithm (greedy, deterministic, explainable — explainability is judged):

1. **Score & sort orders:** chilled first → deferredYesterday=1 → tightest windows → largest volume. (This is your written prioritization policy, in code.)
2. **Phase A — chilled:** first-fit-decreasing over reefer vehicles only; a chilled order is a hard fail on ambient vehicles.
3. **Phase B — ambient:** remaining orders over all vehicles (reefer may carry ambient; ambient may not carry chilled — per booklet).
4. **Trip construction:** group orders by (brand, district, depot); each trip obeys weight AND volume caps, same brand+district, vehicle home depot, and the time formula: outbound + interStop×(n−1) + Σ service allowances. Fresh trips ≤270 min before 8 AM; Style/Tech ≤480.
5. **Max 2 trips/vehicle;** fuel quota: Σ trip distance / kmPerL ≤ weeklyFuelQuota_l.
6. **Overflow → deferrals:** unassigned orders get reason codes (CAP/REF/INV), cost estimate, promise date = next operating day; consecutive-deferral warning when applicable.
7. **Validation layer** runs on every allocation and blocks infeasible plans (this is what the dispatcher UI shows as hard validation — same as your Figma cards).

Port the feasibility rules from the booklet's Task 2B list into `validate.js`; use it in unit tests AND as a live check in the UI. Deterministic output matters: given the seeded day, the engine must always produce the same allocation so your demo never surprises you.

---

## 5. API Surface (minimum viable)

```
POST /api/auth/login            → JWT cookie
GET  /api/orders?date=          → order queue (dispatcher)
POST /api/plan/allocate         → run engine {date} → proposed plan
POST /api/plan/commit           → dispatcher approves → trips + stops persisted
POST /api/orders/:id/defer      → {reason, promiseDate} → ledger entry
GET  /api/trips/:vehicleId      → driver/loader manifest (stop sequence)
POST /api/flags                 → loader shortage {orderId, reason, photo}
POST /api/events/batch          → offline sync endpoint (idempotent by eventId)
GET  /api/outlet/:id/timeline   → store manager live timeline
POST /api/receipt               → confirm / discrepancy claim
GET  /api/deferrals             → ledger view
```

**Idempotency is the offline contract:** driver events carry client UUIDs; the batch endpoint dedupes on receipt — so replayed syncs never double-record. Conflict rule from your design: *completed PODs bind to outlets, not sequence* — re-sequencing never mutates delivered records.

---

## 6. Offline & Degradation Implementation

- **Service Worker** caches app shell (driver.html + assets) so the page itself loads with zero signal.
- **Outbox pattern:** every driver action (depart/arrive/POD/issue) writes `{eventId, type, payload, clientTs}` to localStorage **first**, renders optimistically, then flushes to `/api/events/batch` when `navigator.onLine` (or on reconnect event). Banner shows "N queued · last synced HH:MM".
- **Sync drawer** reports per-event accepted/conflict status — mirrors your Figma "4 records accepted · 1 conflict · resolved" screen.
- **Telemetry-degradation (dispatcher):** a **"Simulate outage" toggle** in the dispatcher console flips vehicles to stale mode (no live position updates, staleness badges, manual check-in log where the dispatcher can enter SMS call-ins). This makes your named Designathon scenario demonstrable live — judges love a button that shows the degradation story.

---

## 7. Day-by-Day Schedule (Sep 30 → Oct 4)

**Tue Sep 30 — Skeleton & Data**
- Repo scaffold, docker-compose (nginx+node+postgres), .env.example
- Prisma schema + migrations; seed script reading the three CSVs
- Auth route + middleware; wire login page to real API; role redirects
- *Done when:* `docker compose up` → login works, DB seeded, sessions persist

**Wed Oct 1 — Dispatcher Core**
- Orders API + queue UI on real data; capacity verdict banner computed server-side
- Trip/vehicle models; fleet board cards fed by API; deferral modal → ledger writes
- *Done when:* dispatcher can view queue, defer with reason codes, see ledger

**Thu Oct 2 — Allocation Engine + Loader/Store**
- Engine + validator + `POST /plan/allocate|commit`; unit tests on feasibility rules
- Loader: manifest by stop sequence, flag shortage (photo upload → store file/ or base64), gated handoff checklist
- Store: timeline API, pinned deferral notice, receipt confirm + discrepancy claim matched to dock flags
- *Done when:* seeded overloaded day produces deferrals; loader flag appears in store receipt flow

**Fri Oct 3 — Driver Offline + Polish + Deploy**
- Outbox queue, service worker, batch sync, conflict drawer; outage simulation toggle
- Viewport pass: driver/store at 390px, loader at 768px — no horizontal scroll, ≥48px targets, glove-mode toggle kept
- Deploy to VPS/Render; verify from phone + incognito; keep-alive configured
- README + docs (architecture, data model, AI disclosure, departures, numbered walkthrough)
- *Done when:* full judge walkthrough passes end-to-end on the deployed URL

**Sat Oct 4 — Video + Submit (hard cutoff 23:59)**
- Record 5–8 min demo: all 4 roles completing the walkthrough, then 1–2 min code/architecture explanation (engine, offline sync, docker)
- Submit form: repo URL, deployed URL, credentials, video link — **by 21:00**, buffer for upload failures
- Freeze: no pushes after deadline; only keep deployment alive

**MoSCoW guardrail:** if Thu slips, cut (in order): fuel-quota enforcement display → outage simulation toggle → photo upload (text flag ok) → Style/Tech weekly schedule niceties. **Never cut:** 4-role workflow, deferral flow, allocation feasibility, offline queue+sync, docker-compose, README walkthrough.

---

## 8. README Judge Walkthrough (numbered, must work on fresh seed)

1. `git clone … && docker compose up` → open http://localhost
2. Login **dispatcher/dispatch123** → Order Queue shows seeded day; verdict banner: reefer shortfall
3. Auto-allocate → review proposed trips (capacity bars, time budgets) → Commit Plan → deferred orders listed with reasons
4. Open **loader/load123** (tablet viewport) → Trip 1 manifest in stop order; Flag Shortage on eggs → photo + reason
5. Open **driver/drive123** (phone viewport) → stop list; toggle airplane/offline simulation → capture POD offline → reconnect → "N records synced · conflict resolved"
6. Open **manager/manage123** → pinned deferral notice (Store #12) + live ETA; at receipt, report missing eggs → auto-matched to dock flag
7. Dispatcher → Deferral Ledger shows reason codes + promise tracking; telemetry-outage toggle demo (if kept)

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Engine runs out of week | Greedy heuristic is scoped; complexity lives in validator, not optimizer |
| Free-tier deployment sleeps → dead link at judging | VPS ($5) or Render always-on; set uptime check (UptimeRobot) |
| Docker image drift between teammates | Lock base images by tag; test compose from clean clone Friday |
| Dataset terms: don't redistribute | Datasets stay in repo unmodified per competition sharing rules — check the dataset access terms before committing; if restricted, generate seed programmatically and document |
| Demo day mismatch | Seeded day is deterministic; rehearse the exact walkthrough twice |
| Scope creep into native apps | Booklet: native optional. Skip. |

---

## 10. Demo Video Outline (5–8 min)

1. **0:00–1:00** — Problem recap (15s) + `docker compose up` live (judges reward seeing it boot) + login
2. **1:00–4:00** — The four-role walkthrough exactly as README numbers 2–7 (reuse your Designathon narration, trimmed)
3. **4:00–5:30** — Offline sequence: dead zone → POD → reconnect → conflict resolved; outage toggle
4. **5:30–7:00** — Code tour: allocation engine scoring + validator, outbox sync idempotency, compose file
5. **7:00–7:30** — Assumptions + departures from Day-5 design + close
