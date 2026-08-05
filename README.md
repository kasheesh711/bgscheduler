# BGScheduler — BeGifted Ops

Internal admin platform for BeGifted Education. The Wise scheduling platform is the only
production source of truth, and it is never queried on the request path: scheduled syncs
pull Wise into versioned Postgres snapshots, and a process-global in-memory index serves
reads from RAM. On top of that spine sit the tutor-scheduling, student-lifecycle, finance,
market-intelligence and audit tools the ops team runs the school on.

## 📚 Documentation

> ### **Start here: [`docs/README.md`](docs/README.md) — the BGScheduler handbook.**
>
> It is the entry point for everything: reading order for new contributors, architecture,
> per-feature deep-dives, the full API/database reference, and the operations runbook.
> **This README is the orientation layer; the handbook owns the depth.**

| Tree | What's there |
|---|---|
| [`docs/handbook/`](docs/handbook/overview.md) | Cross-cutting mental model — start with [not-the-nextjs-you-know.md](docs/handbook/not-the-nextjs-you-know.md), then [architecture.md](docs/handbook/architecture.md), [data-flow.md](docs/handbook/data-flow.md), [conventions.md](docs/handbook/conventions.md), [glossary.md](docs/handbook/glossary.md) |
| [`docs/features/`](docs/features/) | 22 docs, one per feature — purpose, business rules, flows (the *why*) |
| [`docs/reference/api/`](docs/reference/api/index.md) | Every endpoint: method, path, auth, purpose |
| [`docs/reference/database/`](docs/reference/database/index.md) | Every table + per-domain ER diagrams; [enums.md](docs/reference/database/enums.md) |
| [`docs/reference/crons.md`](docs/reference/crons.md) · [`docs/reference/env.md`](docs/reference/env.md) · [`docs/reference/wise-api.md`](docs/reference/wise-api.md) | Cron registry, env-var reference, Wise API contract |
| [`docs/operations/`](docs/operations/runbook.md) | [Runbook](docs/operations/runbook.md), [auth & access](docs/operations/auth-and-access.md), [observability](docs/operations/observability.md) |
| [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) | Running list of unresolved doc/code gaps |

**Canonical-home rule:** `features/*` owns meaning; `reference/*` owns mechanical detail
(columns, endpoint signatures). Feature docs link to reference rather than restating it.

## At a glance

- **Production**: [bgscheduler.vercel.app](https://bgscheduler.vercel.app) · **Repo**: [kasheesh711/bgscheduler](https://github.com/kasheesh711/bgscheduler)
- **Stack**: Next.js 16 App Router (`cacheComponents: true`, [`next.config.ts`](next.config.ts)) · TypeScript · Tailwind v4 · shadcn/ui over `@base-ui/react` · Auth.js v5 (Google) · Drizzle ORM · Neon Postgres (ap-southeast-1) · Vercel Pro
- **Surface**: 25 authenticated pages in the `(app)` group, 2 print pages, 2 public pages; 178 `route.ts` files exporting 241 method+path endpoints; 188 Postgres tables and 61 enums in [`src/lib/db/schema.ts`](src/lib/db/schema.ts) (4,719 lines, 65 migrations under [`drizzle/`](drizzle)); 15 Vercel crons in [`vercel.json`](vercel.json)
- **Tests**: 369 Vitest files — a `unit` project (`npm test`) plus 12 Testcontainers-backed `*.integration.test.ts` suites (`npm run test:integration`)

## Features

22 features, each with a doc under [`docs/features/`](docs/features/). Grouped by the nav
sections in [`src/lib/navigation/tools.ts`](src/lib/navigation/tools.ts) (`NAV_SECTIONS`,
`NAV_TOOLS`). Nav registers **21 tools**, which is a different cut of the same surface:
Scheduler Metrics is its own nav entry but is documented with the AI Scheduler, while Tutor
Compare and Proposals have no nav entry because they render inside `/search`.

**Status** is quoted from each feature doc's own status line. No maturity marker exists
anywhere in code (no `@deprecated`, no feature-status constant), so where a doc declines to
assert a badge this table says so rather than inventing one.

### Scheduling & Tutors

| Feature | Route | Status (per its doc) | Doc |
|---|---|---|---|
| **AI Scheduler** — LLM parses a pasted parent chat into strict JSON, the deterministic search proves availability, the app drafts the reply. Accept/edit/reject outcomes at `/scheduler/metrics` | `/scheduler`, `/scheduler/metrics` | experimental | [ai-scheduler](docs/features/ai-scheduler.md) |
| **Tutor Search** — qualified-and-available tutor grid for a window + duration; fail-closed "Needs Review" | `/search` | stable | [tutor-search](docs/features/tutor-search.md) |
| **Tutor Compare** — 1–3 tutors for one Bangkok week: conflicts + shared free slots | inside `/search` | no badge asserted; `/compare` is a client-side redirect, engine + API live | [tutor-compare](docs/features/tutor-compare.md) |
| **Proposals (Admin Holds)** — temporary local holds on tutor slots, same-tutor overlap detection; never written to Wise | inside `/search` | experimental | [proposals](docs/features/proposals.md) |
| **LINE Integration** — LINE OA inbox: ingest, classify, draft replies, human-gated review | `/line-review` | stable (Wise write-path dry-run only) | [line-integration](docs/features/line-integration.md) |
| **Leave Requests** — sync the tutor leave form, match to Wise identities/sessions, triage affected classes | `/leave-requests` | no badge asserted; committed, cron-scheduled, nav-registered; Wise cancel is dry-run preview only | [leave-requests](docs/features/leave-requests.md) |
| **Classroom Assignments** — deterministic daily room plan, overrides, opt-in publish of eligible `OFFLINE` rooms to Wise | `/class-assignments` | stable | [classroom-assignments](docs/features/classroom-assignments.md) |
| **Tutor Profiles** — editorial business context Wise doesn't store (fit, tags, parent-safe summary) | `/tutor-profiles` | stable | [tutor-profiles](docs/features/tutor-profiles.md) |
| **Room Capacity** — utilization dashboard; month + forecast engines built and tested | `/room-capacity` | no single badge — utilization wired end to end; month/forecast endpoints have no caller; sync is `manualOnly` | [room-capacity](docs/features/room-capacity.md) |
| **Post-Class Feedback** — preserves Wise feedback evidence, scores a deadline/content policy, carries reviewed deductions to a finance handoff | `/post-class-feedback` | stable (enforcement mode defaults to `shadow`) | [post-class-feedback](docs/features/post-class-feedback.md) |

### Student Lifecycle

| Feature | Route | Status (per its doc) | Doc |
|---|---|---|---|
| **Progress Tests** — due / scheduled / completed progress-test cycles, admin digest cron, LINE + parent messaging | `/progress-tests` | no badge asserted; committed, cron-scheduled twice, nav-registered; its one Wise write is off by default | [progress-tests](docs/features/progress-tests.md) |
| **Student Schedule** — a student's monthly calendar to print, or push to a verified parent as a tokenized link | `/student-schedule` (+ public `/schedule/[token]`) | stable | [student-schedule](docs/features/student-schedule.md) |
| **Learning Plans** — Years 1–13 syllabus plan builder with a dedicated A4 print report | `/learning-plans` | no badge asserted in its doc | [learning-plans](docs/features/learning-plans.md) |
| **Student Promotions** — audited July 1 Wise grade/course/graduation workflow, dry-run then verified apply | `/student-promotions` | stable | [student-promotions](docs/features/student-promotions.md) |
| **University Admissions** — counselor case management: cases, checklists, college lists, essays, activities, testing; student + parent portals | `/admissions`, `/admissions/[caseId]` | no badge asserted; merged to `main`, nav- and cron-registered | [university-admissions](docs/features/university-admissions.md) |

### Finance & Revenue

| Feature | Route | Status (per its doc) | Doc |
|---|---|---|---|
| **Sales Dashboard** — import monthly sales sheets, pace vs. target, Bear/Base/Bull projections | `/sales-dashboard` | stable | [sales-dashboard](docs/features/sales-dashboard.md) |
| **Credit Control** — project prepaid-credit run-out, prioritized follow-up queue, outreach log | `/credit-control` | live | [credit-control](docs/features/credit-control.md) |
| **Payroll** — reconcile tutor pay vs. Wise sessions + invoices against a rate card; review + adjustments | `/payroll` | stable | [payroll](docs/features/payroll.md) |

### Market Intelligence · Research & Reference · Data & Audit

| Feature | Route | Status (per its doc) | Doc |
|---|---|---|---|
| **Competitor Intelligence** — competitor activity, search visibility, offers, response war-room | `/competitor-intelligence` | stable (weekly cron, AI + budget guard) | [competitor-intelligence](docs/features/competitor-intelligence.md) |
| **US Universities** — IPEDS research console for 4-year US universities: admissions, cost, outcomes | `/us-universities`, `/us-universities/[unitId]` | stable | [us-universities](docs/features/us-universities.md) |
| **Wise Activity Audit** — read-only Wise activity event store + package-sales reconciliation | `/wise-activity` | stable | [wise-activity-audit](docs/features/wise-activity-audit.md) |
| **Data Health** — cron firing, data freshness, snapshot fidelity, unresolved normalization issues | `/data-health` | wired end to end at HEAD | [data-health](docs/features/data-health.md) |

## Pages

25 authenticated pages live in the `(app)` route group. `/` is the Home hub — it renders
[`HomeHub`](src/components/home/home-hub.tsx) from `getHomeSummaryPayload`, and redirects a
restricted user straight to their single allowed page
(<a href="src/app/(app)/page.tsx"><code>src/app/(app)/page.tsx:8-19</code></a>).

| Route | Page |
|---|---|
| `/` | Home hub (action counts + tool shortcuts) |
| `/search` | Tutor Search + Compare workspace (Proposals surface here) |
| `/compare` | Client-side redirect to `/search`, preserving `?tutors=` |
| `/scheduler` · `/scheduler/metrics` | AI Scheduler · its evaluation metrics |
| `/line-review` | LINE AI Review |
| `/leave-requests` | Leave Requests |
| `/class-assignments` | Class Assignments |
| `/tutor-profiles` | Tutor Profiles |
| `/room-capacity` | Room Capacity |
| `/post-class-feedback` | Post-Class Feedback |
| `/progress-tests` | Progress Tests |
| `/student-schedule` | Student Schedule |
| `/learning-plans` | Learning Plans |
| `/student-promotions` | Student Promotions |
| `/admissions` · `/admissions/[caseId]` | Admissions case list · case workspace |
| `/sales-dashboard` | Sales Dashboard |
| `/credit-control` | Credit Control |
| `/payroll` | Payroll |
| `/competitor-intelligence` | Competitor BI |
| `/us-universities` · `/us-universities/[unitId]` | US Universities list · institution dossier |
| `/wise-activity` | Wise Audit |
| `/data-health` | Data Health |

Outside the `(app)` group:

- **Print** — `(print)` route group: `/learning-plans/report` and `/student-schedule/report` (A4 PDF output).
- **Public** — `/login`, and `/schedule/[token]`, the only unauthenticated page that renders
  student data. Access is the URL token and nothing else; every failure mode renders one
  identical message so the page can't be used as a token oracle, and it is `noindex/nofollow`
  (<a href="src/app/schedule/%5Btoken%5D/page.tsx"><code>src/app/schedule/[token]/page.tsx:1-35</code></a>).

Auth is enforced in [`src/middleware.ts`](src/middleware.ts): a public-route allowlist
(`isPublicRoute`, `:4-20`), an edge Auth.js session check, and a per-user `allowedPages`
prefix match that also gates the matching `/api/*` namespace (`isPathAllowed`, `:29-60`).
Restricted users get a `403` on `/api/*` and a redirect to their landing page elsewhere.

## Non-negotiable product rules

Enforced in code; do not weaken without explicit approval (see [`AGENTS.md`](AGENTS.md) change control):

- Wise (`begifted-education`, institute `696e1f4d90102225641cc413`) is the only production source of truth.
- Reads run on normalized snapshots plus the warm in-memory index — never a live request-path Wise call.
- Never return a tutor as **Available** unless availability is provable from Wise-derived data.
- Unresolved identity, modality, or qualification routes to **Needs Review**, never **Available**.
- Cancelled sessions must not block availability.
- All times normalize to `Asia/Bangkok`.

## Scheduled syncs

15 Vercel crons in [`vercel.json`](vercel.json); each fires an HTTP `GET` carrying
`Authorization: Bearer $CRON_SECRET`, verified with a constant-time comparison. There is no
in-process scheduler — a handler with no `vercel.json` entry never fires on its own. The
sub-hourly jobs are staggered so they never hit Wise or Neon in the same minute. Full registry
(timeouts, guards, behavior) in [`docs/reference/crons.md`](docs/reference/crons.md).

| Endpoint | Schedule (UTC) | Bangkok |
|---|---|---|
| `/api/internal/sync-wise` | `*/30 * * * *` | every 30 min, :00/:30 |
| `/api/internal/sync-wise-activity` | `5,35 * * * *` | :05/:35 |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` | :10/:40 |
| `/api/internal/sync-post-class-feedback` | `13,43 * * * *` | :13/:43 |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` | :15/:45 |
| `/api/internal/sync-credit-control` | `20,50 * * * *` | :20/:50 |
| `/api/internal/post-class-feedback-backfill` | `23,53 * * * *` | :23/:53 |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` | :25/:55 |
| `/api/internal/cron-watchdog` | `7,37 * * * *` | :07/:37 |
| `/api/internal/class-assignments/morning` | `45 23 * * *` | daily 06:45 |
| `/api/internal/class-assignments/admin-email` | `0,10,20,30 0 * * *` | daily 07:00–07:30 |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` | daily 07:35 |
| `/api/internal/admissions-notifications` | `12 1 * * *` | daily 08:12 |
| `/api/internal/sync-competitor-intelligence` | `25 18 * * 0` | weekly, Mon 01:25 |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` | annual, Jul 1 00:05 |

## Local development

```bash
npm install
npm run dev          # next dev → http://localhost:3000
```

Copy [`.env.example`](.env.example) to `.env.local`. [`src/lib/env.ts`](src/lib/env.ts)
declares 15 variables and throws at startup if they don't parse: 7 required
(`DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`,
`WISE_API_KEY`, `CRON_SECRET`), 2 with defaults (`WISE_NAMESPACE`, `WISE_INSTITUTE_ID`),
and 6 optional LINE / student-schedule vars (`LINE_CHANNEL_SECRET`,
`LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS`,
`STUDENT_SCHEDULE_LINK_TTL_DAYS`, `APP_BASE_URL`). Everything else — AI scheduler, schedule
emails, leave-request sheet, post-class payout targets — is read directly where used.
The complete list with sources and consumers is in
[`docs/reference/env.md`](docs/reference/env.md).

## Commands

Every script in [`package.json`](package.json), grouped.

```bash
# Dev / build / quality
npm run dev                          # Next.js dev server
npm run build                        # production build
npm run start                        # serve the production build
npm run lint                         # eslint
npm run typecheck                    # tsc --noEmit

# Tests
npm test                             # unit project (vitest run --project unit)
npm run test:watch                   # unit project, watch mode
npm run test:integration             # integration project (Testcontainers Postgres)
npm run test:all                     # both projects
npm run test:coverage                # unit project with v8 coverage

# Database (Drizzle + Neon)
npm run db:generate                  # generate migrations from schema.ts
npm run db:migrate                   # apply migrations (needs DATABASE_URL)
npm run db:seed                      # seed admin users + aliases (DATABASE_URL, SEED_ADMIN_EMAILS)

# Guards & release
npm run guard:sales-dashboard-scope  # scripts/check-sales-dashboard-scope.mjs
npm run guard:production-route-surface
npm run verify:release               # typecheck → test → build → typecheck → git diff --check → route-surface guard
npm run deploy:prod                  # verify:release → assert-production-deploy-ready.mjs → vercel --prod

# One-off maintenance (scripts/, all tsx)
npm run credit-control:seed-admin-ownership
npm run tutor-profiles:seed
npm run room-capacity:import-model
npm run room-utilization:sync        # Room Capacity sync is manualOnly — no cron fires it
npm run ai-scheduler:evaluate
npm run ai-scheduler:compare-models
npm run line:test-data:cleanup
npm run line:find-user-ids           # Harvest LINE user IDs for the schedule-bot allowlist (read-only)
npm run payout:inventory
npm run payout:setup-master-tabs
npm run payout:repoint-workbooks
npm run payout:restore-workbooks
npm run payout:derive-tutor-names
npm run payout:roll-workbooks
```

### Deploying

Push to `main` — the Vercel Git integration auto-deploys production.
`npm run deploy:prod` is the guarded manual path and only works from the Vercel-linked
worktree: [`scripts/assert-production-deploy-ready.mjs`](scripts/assert-production-deploy-ready.mjs)
refuses a non-`main` branch, a dirty tree, or a `HEAD` that isn't `origin/main`. Do **not**
run a bare `npx vercel --prod` from an unlinked worktree — it creates a stray Vercel project
instead of deploying.

Trigger any cron endpoint manually with the same auth the scheduler uses:

```bash
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-wise \
  -H "Authorization: Bearer $CRON_SECRET"
```

Day-to-day operational procedures — deploys, manual sync recovery, debugging stale data —
are in the [operations runbook](docs/operations/runbook.md).

_Verified against HEAD + uncommitted WIP on 2026-05-31._
