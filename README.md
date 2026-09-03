# BGScheduler — BeGifted Ops

Internal admin platform for BeGifted Education. The external **Wise** scheduling platform is
the only production source of truth, and it is never queried on the tutor read path:
scheduled syncs pull Wise into versioned Postgres snapshots, a fail-closed normalization
pipeline decides correctness at *write* time, and a `globalThis`-anchored in-memory index
answers searches from RAM ([`src/lib/search/index.ts:92-112`](src/lib/search/index.ts)). On
that spine sit the tutor-scheduling, student-lifecycle, finance, market-intelligence and
audit tools the ops team runs the school on.

## 📚 Documentation

> ### **Start here: [`docs/README.md`](docs/README.md) — the BGScheduler handbook.**
>
> It is the entry point for everything: reading order for new contributors, the
> architecture and data-flow model, per-feature deep-dives, the full API/database
> reference, and the operations runbook.
> **This README is the orientation layer; the handbook owns the depth.**

| Tree | What's there |
|---|---|
| [`docs/handbook/`](docs/handbook/overview.md) | Cross-cutting mental model — read [not-the-nextjs-you-know.md](docs/handbook/not-the-nextjs-you-know.md) first, then [overview](docs/handbook/overview.md), [architecture](docs/handbook/architecture.md), [data-flow](docs/handbook/data-flow.md), [conventions](docs/handbook/conventions.md), [glossary](docs/handbook/glossary.md) |
| [`docs/features/`](docs/features/) | 22 docs, one per feature — purpose, business rules, flows (the *why*) |
| [`docs/reference/api/`](docs/reference/api/index.md) | Every endpoint: method, path, auth tier, purpose |
| [`docs/reference/database/`](docs/reference/database/index.md) | Every table + per-domain ER diagrams; [enums.md](docs/reference/database/enums.md) |
| [`docs/reference/crons.md`](docs/reference/crons.md) · [`docs/reference/env.md`](docs/reference/env.md) · [`docs/reference/wise-api.md`](docs/reference/wise-api.md) | Cron registry, env-var reference, Wise API contract |
| [`docs/operations/`](docs/operations/runbook.md) | [Runbook](docs/operations/runbook.md), [auth & access](docs/operations/auth-and-access.md), [observability](docs/operations/observability.md) |
| [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) | Running list of unresolved doc/code gaps |

**Canonical-home rule:** `features/*` owns meaning; `reference/*` owns mechanical detail
(columns, endpoint signatures). Feature docs link to reference rather than restating it.

## At a glance

- **Production**: [bgscheduler.vercel.app](https://bgscheduler.vercel.app) · **Repo**: [kasheesh711/bgscheduler](https://github.com/kasheesh711/bgscheduler)
- **Stack**: Next.js 16.2.2 App Router (`cacheComponents: true` is the only custom setting, [`next.config.ts`](next.config.ts)) · React 19.2.4 · TypeScript 5.9 · Tailwind v4 · shadcn/ui over `@base-ui/react` · Auth.js v5 beta (Google) · Drizzle ORM 0.45 · Neon Postgres (ap-southeast-1) · Vercel Pro, region `sin1`
- **Surface**: 31 `page.tsx` files — 26 authenticated pages in the `(app)` group, 3 print pages, 2 public pages; 180 `route.ts` files exporting 243 method+path endpoints; 189 Postgres tables and 61 enums in [`src/lib/db/schema.ts`](src/lib/db/schema.ts) (4,772 lines, 69 migrations under [`drizzle/`](drizzle), latest `0068_payout_adjustment_superseded.sql`); 17 Vercel crons in [`vercel.json`](vercel.json)
- **Tests**: 389 Vitest files — a `unit` project (`npm test`) plus 13 Testcontainers-backed `*.integration.test.ts` suites (`npm run test:integration`); `TZ` is pinned to `Asia/Bangkok` in [`vitest.config.ts`](vitest.config.ts)

> Endpoint count: 241 named `export async function GET|POST|PUT|PATCH|DELETE` handlers **plus
> 2** for the Auth.js catch-all, which destructures its methods
> (`export const { GET, POST } = handlers`) and matches no `function` grep. The 2 CORS
> `OPTIONS` handlers on the public OA-resolver routes are excluded — no business surface.

## Features

22 features, each with a doc under [`docs/features/`](docs/features/), grouped by the nav
sections declared in [`src/lib/navigation/tools.ts`](src/lib/navigation/tools.ts)
(`NAV_SECTIONS`, `NAV_TOOLS`). Nav registers **22 tools in 6 sections** — a different cut of
the same surface: Scheduler Metrics is its own nav entry but is documented with the AI
Scheduler; Tutor Compare and Proposals have no nav entry because they render inside
`/search`; Parent Report is a nav tool with no feature doc yet (see below). Seven tools carry
live count badges (`NavBadgeKey`), four are pinned as shortcuts.

No maturity marker exists anywhere in code — no `@deprecated`, no feature-status constant —
so the **Status** column is the project's maintained maturity map, not something inferred
from source. Each entry's mechanism is cited where it is not obvious.

### Scheduling & Tutors

| Feature | Route | Status | Doc |
|---|---|---|---|
| **Tutor Search** — qualified-and-available tutor grid for a window + duration; fail-closed "Needs Review" routing | `/search` | stable | [tutor-search](docs/features/tutor-search.md) |
| **Tutor Compare** — 1–3 tutors for one Bangkok week: same-student conflicts + shared free slots | inside `/search` | legacy-redirect — engine and both API endpoints live; the standalone `/compare` page is a client-side redirect preserving `?tutors=` (<a href="src/app/(app)/compare/page.tsx"><code>compare/page.tsx:10-17</code></a>) | [tutor-compare](docs/features/tutor-compare.md) |
| **Proposals (Admin Holds)** — temporary local holds on tutor slots with same-tutor overlap detection; never written to Wise | inside `/search` | experimental | [proposals](docs/features/proposals.md) |
| **AI Scheduler** — an LLM parses pasted parent chat into strict JSON, the deterministic search proves availability, the app drafts the reply; accept/edit/reject outcomes at `/scheduler/metrics` | `/scheduler`, `/scheduler/metrics` | experimental | [ai-scheduler](docs/features/ai-scheduler.md) |
| **LINE Integration** — LINE OA inbox: webhook ingest, classification, human-gated scheduler review, contact/student linking, admin schedule bot | `/line-review` | stable (scheduler write-path flag-gated — `ENABLE_LINE_SCHEDULER`, [`src/lib/line/client.ts:20`](src/lib/line/client.ts)) | [line-integration](docs/features/line-integration.md) |
| **Leave Requests** — sync the tutor leave form from Google Sheets, match to Wise identities/sessions, triage affected classes | `/leave-requests` | stable (Wise cancellation is dry-run preview only) | [leave-requests](docs/features/leave-requests.md) |
| **Classroom Assignments** — deterministic daily room plan, overrides, opt-in publish of eligible `OFFLINE` rooms back to Wise, schedule emails | `/class-assignments` | stable | [classroom-assignments](docs/features/classroom-assignments.md) |
| **Tutor Profiles** — editorial business context Wise doesn't store (fit, tags, parent-safe summary), keyed by stable `canonicalKey` | `/tutor-profiles` | stable | [tutor-profiles](docs/features/tutor-profiles.md) |
| **Room Capacity** — room utilization dashboard; month-pressure and saturation-forecast engines built and tested | `/room-capacity` | stable (utilization); forecast/month engines have no UI caller — only `/api/room-capacity/utilization` is fetched ([`room-capacity-dashboard.tsx:354`](src/components/room-capacity/room-capacity-dashboard.tsx)); its sync is `manualOnly` ([`cron-registry.ts:370-379`](src/lib/data-health/cron-registry.ts)) | [room-capacity](docs/features/room-capacity.md) |
| **Post-Class Feedback** — preserves every Wise feedback version as immutable evidence, scores an objective deadline/content policy, carries reviewed deductions into a capability-gated finance handoff | `/post-class-feedback` | stable | [post-class-feedback](docs/features/post-class-feedback.md) |

### Student Lifecycle

| Feature | Route | Status | Doc |
|---|---|---|---|
| **Progress Tests** — the every-8-attended-classes cadence as a tracked lifecycle, teacher heads-up at class 6, daily admin digest, bilingual parent outreach | `/progress-tests` | stable (its one Wise write capability is off by default) | [progress-tests](docs/features/progress-tests.md) |
| **Student Schedule** — a student's month of classes: admin lookup + print-to-PDF, plus a no-login token link a parent opens from LINE | `/student-schedule` (+ public `/schedule/[token]`) | stable | [student-schedule](docs/features/student-schedule.md) |
| **Learning Plans** — Years 1–13 syllabus plan builder with a dedicated A4 print report; plan content lives in the URL, only access grants are stored | `/learning-plans` | stable | [learning-plans](docs/features/learning-plans.md) |
| **Student Promotions** — audited July 1 Wise grade/course/graduation workflow with pay-band checks, dry-run review, then verified apply | `/student-promotions` | stable | [student-promotions](docs/features/student-promotions.md) |
| **University Admissions** — counselor case management: cases, versioned checklists, college lists, essays, activities, testing; plus student and view-only parent portals. Largest surface in the app (61 endpoints) and the only non-admin-only route family | `/admissions`, `/admissions/[caseId]` | stable (parity-hardening code unmerged on `origin/codex/admissions-parity-hardening`; schema landed) | [university-admissions](docs/features/university-admissions.md) |

### Finance & Revenue

| Feature | Route | Status | Doc |
|---|---|---|---|
| **Sales Dashboard** — import monthly sales sheets + Bear/Base/Bull projections into Postgres; GM revenue-pace readout. Owns the shared Google-Sheets access layer | `/sales-dashboard` | stable | [sales-dashboard](docs/features/sales-dashboard.md) |
| **Credit Control** — project prepaid-credit depletion, rank an at-risk follow-up queue, log the outreach | `/credit-control` | stable | [credit-control](docs/features/credit-control.md) |
| **Payroll** — reconcile tutor pay for a Bangkok month from Wise sessions + payout invoices against a versioned rate card; review + manual adjustments | `/payroll` | stable | [payroll](docs/features/payroll.md) |

### Market Intelligence · Research & Reference · Data & Audit

| Feature | Route | Status | Doc |
|---|---|---|---|
| **Competitor Intelligence** — competitor site/social/SERP evidence under a monthly USD budget cap, scored into a daily brief + weekly War Room; suggestions are never auto-executed | `/competitor-intelligence` | stable | [competitor-intelligence](docs/features/competitor-intelligence.md) |
| **US Universities (IPEDS)** — read-only research console over a curated IPEDS slice; feeds the admissions college list by soft-reference on `ipeds_institutions.unitId`, never an FK | `/us-universities`, `/us-universities/[unitId]` | stable | [us-universities](docs/features/us-universities.md) |
| **Wise Activity Audit** — read-only persisted Wise audit-event store with KPIs, filters, package-sales reconciliation, manual backfill | `/wise-activity` | stable | [wise-activity-audit](docs/features/wise-activity-audit.md) |
| **Data Health** — cron firing, data freshness, Wise snapshot fidelity, unresolved normalization issues | `/data-health` | stable | [data-health](docs/features/data-health.md) |

### Shipped surfaces without a feature doc yet

Three surfaces are live in code and carry a maturity status, but have no page under
`docs/features/`. Until one lands, the source below is authoritative.

| Surface | Status | Where it lives |
|---|---|---|
| **Parent Report** — class + credit statement for a family over a date range, print or CSV. Registered as the `student-report` nav tool ("Parent Report") | stable | [`src/lib/student-report/`](src/lib/student-report), `src/app/(app)/student-report/page.tsx`, `src/app/(print)/student-report/report/page.tsx`, `src/app/api/student-report/route.ts` |
| **LINE credit bot** — `/credit <code>` replies with a family's Wise credit balances plus a Parent Report link; `/credit setup` registers a staff group for the daily run-out digest | stable | [`src/lib/line/credit-bot.ts`](src/lib/line/credit-bot.ts), [`src/lib/line/credit-digest.ts`](src/lib/line/credit-digest.ts), cron `/api/internal/line-credit-digest` |
| **Post-class payout** — carries reviewed feedback deductions into payout adjustment rows on an hourly accrual cron | stable (writes flag-gated by `POST_CLASS_PAYOUT_WRITES_ENABLED` / `POST_CLASS_AUTO_APPROVE_ENABLED`) | [`src/lib/post-class-feedback/payout-config.ts:50`](src/lib/post-class-feedback/payout-config.ts), `payout-repository.ts`, `payout-retirement.ts`, cron `/api/internal/post-class-feedback/payout-accrual` |

## Pages

31 `page.tsx` files. 26 are authenticated pages in the `(app)` route group; `/` is the Home
hub, which renders [`HomeHub`](src/components/home/home-hub.tsx) from
`getHomeSummaryPayload` and redirects a restricted user straight to their single allowed page
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
| `/post-class-feedback` | Class Feedback |
| `/progress-tests` | Progress Tests |
| `/student-schedule` | Student Schedule |
| `/student-report` | Parent Report |
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

- **Print** — the `(print)` route group: `/learning-plans/report`, `/student-schedule/report`,
  and `/student-report/report`. Shell-free A4 sheets with a `window.print()` toolbar; every
  failure mode renders a visible card so a statement never prints as a silently empty sheet
  (<a href="src/app/(print)/student-report/report/page.tsx"><code>student-report/report/page.tsx:1-8</code></a>).
- **Public** — `/login`, and `/schedule/[token]`, the only unauthenticated page that renders
  student data. Access is the URL token and nothing else; every failure mode (malformed,
  unknown, expired, revoked) renders one identical message so the page can't be used as a
  token oracle, and it is `noindex/nofollow`
  (<a href="src/app/schedule/%5Btoken%5D/page.tsx"><code>src/app/schedule/[token]/page.tsx:1-23</code></a>).

Auth is enforced in [`src/middleware.ts`](src/middleware.ts): a maintenance gate that
deliberately sits **above** the public allowlist, then `isPublicRoute` (`:10-26`), an edge
Auth.js session check, and a per-user `allowedPages` prefix match that also gates the
matching `/api/*` namespace (`isPathAllowed`, `:36-67`). Restricted users get a `403` on
`/api/*` and a redirect elsewhere. Post-Class Feedback and Learning Plans are coarse-passed
here because they re-check fresh Postgres capability grants of their own.

## Non-negotiable product rules

Enforced in code; do not weaken without explicit approval (see [`AGENTS.md`](AGENTS.md) change control):

- Wise (namespace `begifted-education`, institute `696e1f4d90102225641cc413`) is the only production source of truth.
- Reads run on normalized snapshots plus the warm in-memory index — never a live request-path Wise call.
- Never return a tutor as **Available** unless availability is provable from Wise-derived data.
- Unresolved identity, modality, or qualification routes to **Needs Review**, never **Available**.
- Cancelled sessions must not block availability.
- All times normalize to `Asia/Bangkok`.

## Scheduled syncs

17 Vercel crons in [`vercel.json`](vercel.json); each fires an HTTP `GET` carrying
`Authorization: Bearer $CRON_SECRET`, verified with a constant-time comparison
([`src/lib/internal/cron-auth.ts:14`](src/lib/internal/cron-auth.ts)). There is no in-process
scheduler — a handler with no `vercel.json` entry never fires on its own. The parallel
in-app registry declares 22 jobs: these 17 plus 5 `manualOnly` handlers
([`src/lib/data-health/cron-registry.ts`](src/lib/data-health/cron-registry.ts)). Sub-hourly
jobs are staggered so they never hit Wise or Neon in the same minute; every schedule below is
pinned by [`src/__tests__/vercel-crons.test.ts:17-35`](src/__tests__/vercel-crons.test.ts).
Full registry (timeouts, guards, behavior) in [`docs/reference/crons.md`](docs/reference/crons.md).

| Endpoint | Schedule (UTC) | Bangkok |
|---|---|---|
| `/api/internal/sync-wise` | `*/30 * * * *` | :00 / :30 |
| `/api/internal/sync-wise-activity` | `2,17,32,47 * * * *` | every 15 min |
| `/api/internal/cron-watchdog` | `7,37 * * * *` | :07 / :37 |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` | :10 / :40 |
| `/api/internal/sync-post-class-feedback` | `13,43 * * * *` | :13 / :43 |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` | :15 / :45 |
| `/api/internal/sync-credit-control` | `20,50 * * * *` | :20 / :50 |
| `/api/internal/post-class-feedback-backfill` | `23,53 * * * *` | :23 / :53 |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` | :25 / :55 |
| `/api/internal/post-class-feedback/payout-accrual` | `33 * * * *` | hourly, :33 |
| `/api/internal/class-assignments/morning` | `41 23 * * *` | daily 06:41 |
| `/api/internal/class-assignments/admin-email` | `4,14,24,36 0 * * *` | daily 07:04–07:36 |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` | daily 07:35 |
| `/api/internal/admissions-notifications` | `12 1 * * *` | daily 08:12 |
| `/api/internal/line-credit-digest` | `3 2 * * *` | daily 09:03 |
| `/api/internal/sync-competitor-intelligence` | `28 18 * * 0` | weekly, Mon 01:28 |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` | annual, Jul 1 00:05 |

## Local development

```bash
npm install
npm run dev          # next dev → http://localhost:3000
```

Copy [`.env.example`](.env.example) to `.env.local`. [`src/lib/env.ts`](src/lib/env.ts)
declares 18 variables and throws at startup if they don't parse: **7 required**
(`DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`,
`WISE_API_KEY`, `CRON_SECRET`), **2 with defaults** (`WISE_NAMESPACE`, `WISE_INSTITUTE_ID`),
and **9 optional** (`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`,
`ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS`, `ENABLE_STUDENT_SCHEDULE_LIVE`,
`STUDENT_SCHEDULE_LINK_TTL_DAYS`, `APP_BASE_URL`, `MAINTENANCE_MODE`,
`MAINTENANCE_BYPASS_EMAILS`). Everything else — AI scheduler, schedule emails, the
leave-request sheet, post-class payout targets — is read from `process.env` where used, and
`MAINTENANCE_MODE` is declared here for inventory parity only because the edge middleware
reads it directly. The reconciled list with sources and consumers is in
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
npm run test:integration             # integration project (Testcontainers Postgres, serial forks)
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
npm run line:find-user-ids           # harvest LINE user IDs for the schedule-bot allowlist (read-only)

# Payout workbook maintenance (Google Sheets side of post-class payout)
npm run payout:inventory
npm run payout:setup-master-tabs
npm run payout:repoint-workbooks
npm run payout:restore-workbooks
npm run payout:derive-tutor-names
npm run payout:roll-workbooks
npm run payout:backfill-submitted
npm run payout:remove-netted
npm run payout:reconcile-sheet
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

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
