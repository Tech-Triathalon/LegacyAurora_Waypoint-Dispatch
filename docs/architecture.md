# Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Browser — 5 vanilla pages (Day-5 design, untouched)        │
│   index · dispatcher · driver · loader · store             │
│   + sw.js app-shell cache + outbox.js offline queue        │
└───────────────┬────────────────────────────────────────────┘
                │ /api/* (fetch, JWT httpOnly cookie)
┌───────────────▼────────────────────────────────────────────┐
│ Express (Node 20)                                          │
│  /api/auth        bcrypt + JWT cookie + role middleware    │
│  /api/orders      queue + capacity verdict banner          │
│  /api/plan/*      allocate (dry-run) / commit (validated)  │
│  /api/trips/*     driver + loader manifests                │
│  /api/events/batch  OFFLINE SYNC — idempotent by eventId   │
│  /api/flags       loader shortage (photo base64)           │
│  /api/outlet/:id/timeline · /api/receipt  manager flow     │
│  /api/telemetry/* outage simulation + fleet board          │
│  /api/health      liveness (uptime monitor target)         │
└───────────────┬────────────────────────────────────────────┘
                │ Prisma
┌───────────────▼────────────────────────────────────────────┐
│ PostgreSQL 16                                              │
│  User · Outlet · Vehicle · Order · Trip · TripStop         │
│  DeliveryEvent (unique eventId) · ShortageFlag             │
│  DeferralLedger                                            │
└────────────────────────────────────────────────────────────┘
```

Deployments:
- **Judges:** `docker compose up` → postgres:16-alpine + app container (migrate + seed + serve on :8080).
- **Production:** Vercel (static + serverless Express) + **Supabase** Postgres (transaction-mode pooler URL); uptime monitor on /api/health.
- **CI:** GitHub Actions — unit tests, then compose boot + end-to-end smoke of the walkthrough.
