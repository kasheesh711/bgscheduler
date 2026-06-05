# BGScheduler — BeGifted Ops

Internal admin platform for BeGifted Education. It runs against the Wise scheduling
platform as the only production source of truth: a background sync pipeline pulls
everything out of Wise on staggered crons, normalizes it into versioned Postgres
snapshots, and serves all reads from a process-global in-memory index. On top of that
core sit seventeen operational features — tutor search/compare, an AI scheduling
assistant, a LINE inbox, progress-test tracking, payroll, sales, credit control, room
planning, an operations hub, and more.

## 📚 Documentation

**Start here: [`docs/`](docs/README.md) — the BGScheduler handbook.** It is the
entry point for everything below: the cross-cutting architecture, per-feature
deep-dives, the full API/database reference, and the operations runbook. This README is
the orientation layer; the handbook owns the depth.

| Area | What's there |
|---|---|
| [`docs/handbook/`](docs/handbook/architecture.md) | System architecture, data flow, conventions, glossary, and the Next.js-16 gotchas |
| [`docs/features/`](docs/features/) | One doc per feature — purpose, rules, and flows (the *why* and *what*) |
| [`docs/reference/api/`](docs/reference/api/index.md) | Every HTTP endpoint: method, path, auth, purpose (130 endpoints) |
| [`docs/reference/database/`](docs/reference/database/index.md) | Every table and ER diagrams (90 tables) |
| [`docs/reference/crons.md`](docs/reference/crons.md) · [`docs/reference/env.md`](docs/reference/env.md) | Cron registry and environment-variable reference |
| [`docs/operations/`](docs/operations/runbook.md) | Runbook, auth/access model, observability |

> The handbook entry point lives at `docs/README.md`. Feature docs own meaning;
> the `reference/` tree owns mechanical detail (columns, endpoint signatures).

## At a glance

- **Production**: [bgscheduler.vercel.app](https://bgscheduler.vercel.app) · **Repo**: [kasheesh711/bgscheduler](https://github.com/kasheesh711/bgscheduler)
- **Stack**: Next.js 16 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Auth.js (Google) · Drizzle ORM · Neon Postgres (ap-southeast-1) · Vercel Pro
- **Surface**: **17** admin features across **17** routed pages, **130** API endpoints, 90 Postgres tables, 10 Vercel crons
- **Tests**: Vitest unit suite (`npm test`) plus a Testcontainers-backed integration suite (`npm run test:integration`)

## Features

Each feature has a deep-dive in [`docs/features/`](docs/features/). Status reflects the
maturity recorded in the corresponding feature doc.

| Feature | Page(s) | Status | Doc |
|---|---|---|---|
| **Tutor Search** — qualified-and-available tutor grid for a time window + duration; fail-closed "Needs Review" | `/search` | live (primary entry) | [tutor-search](docs/features/tutor-search.md) |
| **Tutor Compare** — 1–3 tutors side by side per week, conflict + shared-free-slot detection | inside `/search` (`/compare` redirects) | engine live; route is legacy redirect | [tutor-compare](docs/features/tutor-compare.md) |
| **Proposals (Admin Holds)** — temporarily "hold" tutor slots during negotiation; surfaced in search | inside `/search` | experimental, local-only | [proposals](docs/features/proposals.md) |
| **AI Scheduler** — LLM reads pasted parent/admin chat, runs the deterministic search, drafts a reply | `/scheduler`, `/scheduler/metrics` | experimental | [ai-scheduler](docs/features/ai-scheduler.md) |
| **LINE Integration** — LINE OA inbox: ingest, classify, draft replies; human-gated review | `/line-review` | stable (read live; Wise write-path dry-run only) | [line-integration](docs/features/line-integration.md) |
| **Leave Requests** — sync tutor leave form, match to Wise sessions, show affected classes | `/leave-requests` | live (preview-only Wise cancel) | [leave-requests](docs/features/leave-requests.md) |
| **Progress Tests** — every-8-classes progress-test tracker; books slots, emails parents/teachers, daily admin digest; teacher-scoped read view | `/progress-tests` | stable | [progress-tests](docs/features/progress-tests.md) |
| **Ops Hub** — operations landing at `/`: access-filtered per-queue action counts + data-freshness strip, backed by `/api/home/summary` and the `NAV_TOOLS` registry | `/` | stable | [ops-hub](docs/features/ops-hub.md) |
| **Tutor Profiles** — editorial business context Wise doesn't store (fit, fluency, guidance) | `/tutor-profiles` | stable | [tutor-profiles](docs/features/tutor-profiles.md) |
| **Classroom Assignments** — deterministic daily room plan, overrides, publish OFFLINE rooms to Wise | `/class-assignments` | stable | [classroom-assignments](docs/features/classroom-assignments.md) |
| **Room Capacity** — room utilization today/this month, plus demand forecast | `/room-capacity` | partial (utilization live; month/forecast engines unwired) | [room-capacity](docs/features/room-capacity.md) |
| **Sales Dashboard** — import monthly sales sheets, track pace vs. target + scenario projection | `/sales-dashboard` | stable | [sales-dashboard](docs/features/sales-dashboard.md) |
| **Credit Control** — project prepaid-credit run-out, prioritized follow-up queue, outreach log | `/credit-control` | stable | [credit-control](docs/features/credit-control.md) |
| **Payroll** — reconcile tutor pay vs. Wise sessions + invoices, integrity issues, adjustments | `/payroll` | stable | [payroll](docs/features/payroll.md) |
| **Wise Activity Audit** — read-only Wise event log + package-sales reconciliation workbench | `/wise-activity` | stable | [wise-activity-audit](docs/features/wise-activity-audit.md) |
| **Student Promotions** — audited July 1, 2026 Wise grade/course promotion workflow | `/student-promotions` | stable, pending first production run | [student-promotions](docs/features/student-promotions.md) |
| **Data Health** — sync status, snapshot stats, cron health, unresolved normalization issues | `/data-health` | stable | [data-health](docs/features/data-health.md) |

### Pages

Seventeen routable pages live under the `(app)` route group (auth-gated) — the Home hub
plus 15 nav tools (16 navigable) and the legacy `/compare` redirect. `/`
renders a landing **Home hub** (per-user shortcut cards + freshness summary,
[`src/components/home/home-hub.tsx`](src/components/home/home-hub.tsx)) — or, for a
single-page restricted user, redirects to their one allowed page. `/login` is the only
unauthenticated page, and `/compare` is a backward-compatible redirect.

| Route | Feature |
|---|---|
| `/` | Home hub (per-user shortcuts + data-freshness overview) |
| `/search` | Tutor Search + Compare workspace (Proposals surface here) |
| `/compare` | Backward-compatible redirect to `/search` (preserves `?tutors=`) |
| `/scheduler` | AI Scheduler |
| `/scheduler/metrics` | AI Scheduler evaluation metrics |
| `/line-review` | LINE AI Review |
| `/leave-requests` | Leave Requests |
| `/progress-tests` | Progress Tests |
| `/tutor-profiles` | Tutor Profiles |
| `/class-assignments` | Classroom Assignments |
| `/room-capacity` | Room Capacity |
| `/sales-dashboard` | Sales Dashboard |
| `/credit-control` | Credit Control |
| `/payroll` | Payroll |
| `/wise-activity` | Wise Audit |
| `/student-promotions` | Student Promotions |
| `/data-health` | Data Health |

Navigation is data-driven from [`src/lib/navigation/tools.ts`](src/lib/navigation/tools.ts)
and rendered by [`src/components/layout/app-nav.tsx`](src/components/layout/app-nav.tsx):
a Home link plus four grouped dropdowns — **Scheduling & Tutors** (Scheduler, Search,
LINE AI Review, Leave Requests, Class Assignments, Tutor Profiles, Room Capacity,
Scheduler Metrics), **Student Lifecycle** (Progress Tests, Student Promotions),
**Finance & Revenue** (Sales Dashboard, Credit Control, Payroll), and **Data & Audit**
(Wise Audit, Data Health). Tools are filtered per user's `allowedPages`, and some carry
amber attention badges fed by `/api/home/summary`.

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

Ten Vercel crons are declared in [`vercel.json`](vercel.json); Vercel fires each with an
HTTP `GET` carrying `Authorization: Bearer $CRON_SECRET`, constant-time verified in every
handler (REL-07). The six 30-minute `sync-*`/tracker jobs are staggered at 5-minute
offsets so they never hit Wise or the database in the same minute. Cron expressions are
UTC; the daily/one-off jobs are timed to land at a sensible Bangkok-local hour (UTC+7).
Full registry (schedules, timeouts, behavior, auth) in
[`docs/reference/crons.md`](docs/reference/crons.md).

| Cron (GET) | Schedule (UTC) | Bangkok | What it does |
|---|---|---|---|
| `sync-wise` (snapshot ETL) | `*/30 * * * *` | every :00/:30 | Full Wise ETL → new snapshot → atomic promote |
| `sync-wise-activity` (audit log) | `5,35 * * * *` | every :05/:35 | Pull + persist Wise activity events |
| `sync-sales-dashboard` | `10,40 * * * *` | every :10/:40 | Re-import refreshable sales sheets + active projection |
| `sync-leave-requests` | `15,45 * * * *` | every :15/:45 | Import leave-form rows, match identities, compute affected sessions |
| `sync-credit-control` | `20,50 * * * *` | every :20/:50 | Recompute prepaid-credit depletion + at-risk queue |
| `sync-progress-tests` | `25,55 * * * *` | every :25/:55 | Recompute every-8-classes progress-test tracker |
| `progress-tests/admin-digest` | `35 0 * * *` | daily 07:35 | Send once-daily progress-test digest to admins |
| `class-assignments/morning` | `45 23 * * *` | daily 06:45 | Fresh-sync → assign rooms (7-day horizon) → publish eligible OFFLINE → tutor emails |
| `class-assignments/admin-email` | `0,10,20,30 0 * * *` | daily 07:00–07:30 | Send (or retry) the daily admin classroom summary email |
| `student-promotions/july-1` | `5 17 30 6 *` | Jul 1 2026 00:05 | One-time: apply verified Wise grade/course promotions |

> `/api/internal/sync-room-utilization` exists but is **manual-only** (run via the
> `room-utilization:sync` script or the Data Health job runner); it is intentionally not
> registered in `vercel.json`.

## Local development

```bash
npm install
npm run dev          # next dev → http://localhost:3000
```

Copy [`.env.example`](.env.example) to `.env.local` and fill in the values. The core
nine variables (`DATABASE_URL`, `AUTH_GOOGLE_ID/SECRET`, `AUTH_SECRET`,
`WISE_USER_ID/API_KEY/NAMESPACE/INSTITUTE_ID`, `CRON_SECRET`) are validated at startup
in [`src/lib/env.ts`](src/lib/env.ts); feature-specific variables (AI scheduler + Progress
Tests model, LINE, schedule emails, leave-request sheet) are read where used. The
complete list with sources and which feature needs each is in
[`docs/reference/env.md`](docs/reference/env.md).

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
npm run room-utilization:sync          # manual room-utilization sync (no cron)
npm run ai-scheduler:evaluate
npm run ai-scheduler:compare-models
npm run line:test-data:cleanup
npm run guard:sales-dashboard-scope
npm run guard:production-route-surface # assert exposed routes match the allowlist

# Release (run + ship)
npm run verify:release            # typecheck + test + build + route-surface guard
npm run deploy:prod               # verify:release + deploy-ready assert + vercel --prod
```

Deploy to production with `npm run deploy:prod` (preferred — it gates on
`verify:release`) or `npx vercel --prod`. Trigger any cron job manually with its bearer
secret, e.g. the Wise snapshot sync:

```bash
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-wise \
  -H "Authorization: Bearer $CRON_SECRET"
```

Day-to-day operational procedures — deploys, manual sync recovery, debugging stale
data — are in the [operations runbook](docs/operations/runbook.md).

_Verified against HEAD `d4fe6d3` on 2026-06-05._
