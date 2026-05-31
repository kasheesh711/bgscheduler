# BGScheduler — BeGifted Ops

Internal admin platform for BeGifted Education. It runs against the Wise scheduling
platform as the only production source of truth: a background sync pipeline pulls
everything out of Wise on staggered crons, normalizes it into versioned Postgres
snapshots, and serves all reads from a process-global in-memory index. On top of that
core sit fourteen operational features — tutor search/compare, an AI scheduling
assistant, a LINE inbox, payroll, sales, credit control, room planning, and more.

## 📚 Documentation

**Start here: [`docs/`](docs/README.md) — the BGScheduler handbook.** It is the
entry point for everything below: architecture, per-feature deep-dives, the full
API/database reference, and the operations runbook. This README is the orientation
layer; the handbook owns the depth.

| Area | What's there |
|---|---|
| [`docs/handbook/`](docs/handbook/architecture.md) | System architecture, data flow, conventions, glossary, and the Next.js-16 gotchas |
| [`docs/features/`](docs/features/) | One doc per feature — purpose, rules, and flows (the *why* and *what*) |
| [`docs/reference/api/`](docs/reference/api/index.md) | Every HTTP endpoint: method, path, auth, purpose (110 handlers) |
| [`docs/reference/database/`](docs/reference/database/index.md) | Every table and ER diagrams (78 tables) |
| [`docs/reference/crons.md`](docs/reference/crons.md) · [`docs/reference/env.md`](docs/reference/env.md) | Cron registry and environment-variable reference |
| [`docs/operations/`](docs/operations/runbook.md) | Runbook, auth/access model, observability |

> The handbook entry point lives at `docs/README.md`. Feature docs own meaning;
> the `reference/` tree owns mechanical detail (columns, endpoint signatures).

## At a glance

- **Production**: [bgscheduler.vercel.app](https://bgscheduler.vercel.app) · **Repo**: [kasheesh711/bgscheduler](https://github.com/kasheesh711/bgscheduler)
- **Stack**: Next.js 16 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Auth.js (Google) · Drizzle ORM · Neon Postgres (ap-southeast-1) · Vercel Pro
- **Surface**: 14 admin features across 14 routed pages, 110 API handlers, 78 Postgres tables, 7 Vercel crons
- **Tests**: Vitest unit suite (`npm test`) plus a Testcontainers-backed integration suite (`npm run test:integration`)

## Features

Each feature has a deep-dive in [`docs/features/`](docs/features/). Status reflects the
maturity recorded in the corresponding feature doc.

| Feature | Page(s) | Status | Doc |
|---|---|---|---|
| **Tutor Search** — qualified-and-available tutor grid for a time window + duration; fail-closed "Needs Review" | `/search` | live | [tutor-search](docs/features/tutor-search.md) |
| **Tutor Compare** — 1–3 tutors side by side per week, conflict + shared-free-slot detection | inside `/search` (`/compare` redirects) | engine live; route is legacy redirect | [tutor-compare](docs/features/tutor-compare.md) |
| **Proposals (Admin Holds)** — temporarily "hold" tutor slots during negotiation; surfaced in search | inside `/search` | experimental, local-only | [proposals](docs/features/proposals.md) |
| **AI Scheduler** — LLM reads pasted parent/admin chat, runs the deterministic search, drafts a reply | `/scheduler`, `/scheduler/metrics` | experimental | [ai-scheduler](docs/features/ai-scheduler.md) |
| **LINE Integration** — LINE OA inbox: ingest, classify, draft replies; human-gated review | `/line-review` | stable (read live; Wise write-path dry-run only) | [line-integration](docs/features/line-integration.md) |
| **Leave Requests** — sync tutor leave form, match to Wise sessions, show affected classes | `/leave-requests` | in progress (uncommitted WIP) | [leave-requests](docs/features/leave-requests.md) |
| **Tutor Profiles** — editorial business context Wise doesn't store (fit, fluency, guidance) | `/tutor-profiles` | stable | [tutor-profiles](docs/features/tutor-profiles.md) |
| **Classroom Assignments** — deterministic daily room plan, overrides, publish OFFLINE rooms to Wise | `/class-assignments` | stable | [classroom-assignments](docs/features/classroom-assignments.md) |
| **Room Capacity** — room utilization today/this month, plus demand forecast | `/room-capacity` | partial (utilization live; month/forecast engines unwired) | [room-capacity](docs/features/room-capacity.md) |
| **Sales Dashboard** — import monthly sales sheets, track pace vs. target + scenario projection | `/sales-dashboard` | stable | [sales-dashboard](docs/features/sales-dashboard.md) |
| **Credit Control** — project prepaid-credit run-out, prioritized follow-up queue, outreach log | `/credit-control` | stable | [credit-control](docs/features/credit-control.md) |
| **Payroll** — reconcile tutor pay vs. Wise sessions + invoices, integrity issues, adjustments | `/payroll` | stable | [payroll](docs/features/payroll.md) |
| **Wise Activity Audit** — read-only Wise event log + package-sales reconciliation workbench | `/wise-activity` | stable | [wise-activity-audit](docs/features/wise-activity-audit.md) |
| **Data Health** — sync status, snapshot stats, unresolved normalization issues | `/data-health` | stable | [data-health](docs/features/data-health.md) |

### Pages

Fourteen routed feature pages live under the `(app)` route group (auth-gated). `/`
redirects to `/search`, and `/login` is the only unauthenticated page.

| Route | Feature |
|---|---|
| `/search` | Tutor Search + Compare workspace (Proposals surface here) |
| `/compare` | Backward-compatible redirect to `/search` (preserves `?tutors=`) |
| `/scheduler` | AI Scheduler |
| `/scheduler/metrics` | AI Scheduler evaluation metrics |
| `/line-review` | LINE AI Review |
| `/leave-requests` | Leave Requests |
| `/tutor-profiles` | Tutor Profiles |
| `/class-assignments` | Classroom Assignments |
| `/room-capacity` | Room Capacity |
| `/sales-dashboard` | Sales Dashboard |
| `/credit-control` | Credit Control |
| `/payroll` | Payroll |
| `/wise-activity` | Wise Audit |
| `/data-health` | Data Health |

Navigation is grouped in [`src/components/layout/app-nav.tsx`](src/components/layout/app-nav.tsx):
a "Scheduling Tools" dropdown (Scheduler, LINE AI Review, Scheduler Metrics, Search,
Leave Requests, Tutor Profiles, Class Assignments, Room Capacity) plus top-level links
(Sales Dashboard, Credit Control, Payroll, Wise Audit, Data Health).

## Non-negotiable product rules

These are enforced in code and must not be weakened without explicit approval (see
[`AGENTS.md`](AGENTS.md) change control):

- Wise (`begifted-education`, institute `696e1f4d90102225641cc413`) is the only production source of truth.
- Reads run on normalized Wise snapshots plus a warm in-memory index — never on a live request-path Wise call.
- Never return a tutor as **Available** unless availability is provable from Wise-derived data.
- Unresolved identity, modality, or qualification routes to **Needs Review**, never **Available**.
- Cancelled sessions must not block availability.
- All times normalize to `Asia/Bangkok`.

## Scheduled syncs

Seven Vercel crons are declared in [`vercel.json`](vercel.json); all fire an
HTTP `GET` with `Authorization: Bearer $CRON_SECRET`. The five `sync-*` jobs are
staggered at 5-minute offsets and guarded against overlap. Full registry (schedules,
timeouts, handlers) in [`docs/reference/crons.md`](docs/reference/crons.md).

| Cron | Schedule (UTC) |
|---|---|
| `sync-wise` (snapshot ETL) | `*/30 * * * *` |
| `sync-wise-activity` (audit log) | `5,35 * * * *` |
| `sync-sales-dashboard` | `10,40 * * * *` |
| `sync-leave-requests` | `15,45 * * * *` |
| `sync-credit-control` | `20,50 * * * *` |
| `class-assignments/morning` (assign + publish + tutor emails) | `45 23 * * *` (06:45 Bangkok) |
| `class-assignments/admin-email` (daily readiness digest) | `0,10,20,30 0 * * *` (07:00–07:30 Bangkok) |

## Local development

```bash
npm install
npm run dev          # next dev → http://localhost:3000
```

Copy [`.env.example`](.env.example) to `.env.local` and fill in the values. The core
nine variables (`DATABASE_URL`, `AUTH_GOOGLE_ID/SECRET`, `AUTH_SECRET`,
`WISE_USER_ID/API_KEY/NAMESPACE/INSTITUTE_ID`, `CRON_SECRET`) are validated at startup
in [`src/lib/env.ts`](src/lib/env.ts); feature-specific variables (AI scheduler, LINE,
schedule emails, leave-request sheet) are read where used. The complete list with
sources and which feature needs each is in [`docs/reference/env.md`](docs/reference/env.md).

## Commands

```bash
# Dev / build
npm run dev                       # Next.js dev server
npm run build                     # production build
npm run start                     # serve the production build
npm run lint                      # ESLint
npm run typecheck                 # tsc --noEmit

# Tests
npm test                          # unit suite (vitest, unit project)
npm run test:watch                # unit suite in watch mode
npm run test:integration          # integration suite (Testcontainers Postgres)
npm run test:all                  # unit + integration
npm run test:coverage             # unit suite with v8 coverage

# Database (Drizzle + Neon)
npm run db:generate               # generate migrations from schema.ts
npm run db:migrate                # apply migrations (needs DATABASE_URL)
npm run db:seed                   # seed admin users + aliases (DATABASE_URL, SEED_ADMIN_EMAILS)

# One-off maintenance scripts (scripts/)
npm run credit-control:seed-admin-ownership
npm run tutor-profiles:seed
npm run room-capacity:import-model
npm run room-utilization:sync
npm run ai-scheduler:evaluate
npm run ai-scheduler:compare-models
npm run line:test-data:cleanup
npm run guard:sales-dashboard-scope
```

Deploy to production with `npx vercel --prod`. Trigger a sync manually (each cron path
accepts the same auth):

```bash
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-wise \
  -H "Authorization: Bearer $CRON_SECRET"
```

Day-to-day operational procedures — deploys, manual sync recovery, debugging stale
data — are in the [operations runbook](docs/operations/runbook.md).

_Verified against HEAD + uncommitted WIP on 2026-05-31._
