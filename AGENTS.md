<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md — BGScheduler

> **Handbook:** Start at [`docs/README.md`](docs/README.md) — the entry point for the code-verified handbook (architecture, one page per feature, and the API/DB/cron/env reference). This file is the orientation map; the handbook is the detail.

## Status: Live — production sync active, 17 Vercel Cron entries running

The application is built, tested, deployed, and live at https://bgscheduler.vercel.app. Google OAuth login works, gated by an `admin_users` allowlist plus per-user `allowedPages` page scoping (`src/middleware.ts:36-67`). Production Wise snapshot sync is active on Vercel Pro alongside sixteen other scheduled jobs.

The codebase has grown far beyond the original tutor-search tool. At this revision it spans **25 feature areas** (22 with a dedicated `docs/features/` page), **189 database tables** (`src/lib/db/schema.ts`, 4,772 lines), **243 method+path HTTP endpoints** across **180 `route.ts` files**, **31 `page.tsx` files** (26 of them in the `(app)` route group), **17 Vercel Cron entries**, **69 Drizzle migrations**, and **389 Vitest test files**.

Everything in `src/` is committed at this revision — `git status --short src/` is empty.

## What Is Built

### Infrastructure (complete)
- Next.js 16 App Router + TypeScript + Tailwind 4 + shadcn/ui over `@base-ui/react`. The only custom setting in `next.config.ts` is `cacheComponents: true`, which puts the app on the `"use cache"` + `cacheTag`/`cacheLife` model.
- Auth.js (NextAuth v5 beta) with Google provider. Two gates: the edge middleware session check (`src/middleware.ts:10-26` is the public allowlist) and the login-time `admin_users` allowlist. Restricted users carry `allowedPages`, matched against both the page path and its `/api` namespace (`src/middleware.ts:36-67`), with fresh-DB-grant carve-outs for Post-Class Feedback and Learning Plans.
- Drizzle ORM + Neon Postgres (ap-southeast-1) over the serverless HTTP driver; `pg` only where transactions are required. 69 migrations under `drizzle/` (latest `0068_payout_adjustment_superseded.sql`).
- Vercel hosting with **17 Vercel Cron entries** (`vercel.json`), each guarded by a constant-time `CRON_SECRET` comparison and a single-flight `running`-row guard in Postgres. A `cron-watchdog` job (`7,37 * * * *`) supervises the others. See [`docs/reference/crons.md`](docs/reference/crons.md).
- A parallel in-app cron registry (`src/lib/data-health/cron-registry.ts`) declares **22 jobs** — the 17 scheduled ones plus 5 `manualOnly: true` handlers with no `vercel.json` entry. Two tests bind the files: the registry's scheduled rows must equal `vercel.json` by path and schedule, and every registry `maxDurationSeconds` must equal the route's exported `maxDuration` (`src/lib/data-health/__tests__/cron-registry.test.ts`).
- In-memory `SearchIndex` singleton anchored on `globalThis.__bgscheduler_searchIndex` (`src/lib/search/index.ts:92-112`), loaded from the active Postgres snapshot, stale-detected and rebuilt on snapshot change with build-promise coalescing.
- Vitest unit/integration split (see [Tests](#tests)).

### Feature areas (25)

Status badges are applied from the documentation program's maturity map and each is reproduced on the matching feature page's own `Status:` line. **No maturity marker exists in code** — there is no `@deprecated` annotation, feature-status constant, or per-feature flag registry — so every badge is documentation-side and rests on a code-verified mechanism (nav entry, cron entry, route wiring, flag), not on a source annotation.

**22 of the 25 have a dedicated page under [`docs/features/`](docs/features/).** The three that do not are marked *(no feature page)* in the Doc column: Post-Class Payout is documented inside the Post-Class Feedback page rather than separately, while Parent Report and the LINE Credit Bot have no page yet.

| # | Feature | Status | One-line summary | Doc |
|---|---|---|---|---|
| 1 | Tutor Search | stable | Range/slot availability search against the warm in-memory snapshot index; fail-closed Needs-Review routing. Primary entry point. | [tutor-search](docs/features/tutor-search.md) |
| 2 | Tutor Compare | legacy-redirect | Week-scoped side-by-side comparison (conflicts + shared free slots) lives inside `/search`. Engine, both API endpoints, and the calendar UI are fully live; only the standalone `/compare` page is a client-side redirect (`src/app/(app)/compare/page.tsx:10-17`), absent from the nav. | [tutor-compare](docs/features/tutor-compare.md) |
| 3 | Tutor Profiles | stable | Editorial business context Wise does not store (parent-safe summary, fit, tags); keyed by stable `canonicalKey`; read by the AI scheduler, the LINE replacement suggester, and the compare popover. | [tutor-profiles](docs/features/tutor-profiles.md) |
| 4 | Classroom Assignments | stable | Daily room-assignment runs, overrides, opt-in publish of eligible OFFLINE `location` to Wise, teacher/admin schedule emails, morning automation. | [classroom-assignments](docs/features/classroom-assignments.md) |
| 5 | Room Capacity | stable (utilization); forecast/month engines have no UI caller; sync is manualOnly | Utilization is wired end to end (sync → `room_utilization_sessions` → API → dashboard). The month and forecast engines are implemented, tested, and authenticated but the only fetch of either in `src/` is their own route test; the sync is registered `manualOnly: true` with no `vercel.json` entry. | [room-capacity](docs/features/room-capacity.md) |
| 6 | Sales Dashboard | stable | Imports monthly sales sheets + scenario projections (Bear/Base/Bull) into Postgres; GM command-center readout. Owns the shared Google-Sheets access layer. Cron `10,40 * * * *`. | [sales-dashboard](docs/features/sales-dashboard.md) |
| 7 | Credit Control | stable | Projects student prepaid-credit depletion and ranks an at-risk follow-up queue; read-mostly against Wise, persists only follow-up/ownership/inactive state. Cron `20,50 * * * *`. | [credit-control](docs/features/credit-control.md) |
| 8 | Payroll | stable | Reconciles tutor pay for a Bangkok month from Wise sessions + payout invoices against a versioned rate card; integrity issues, manual adjustments, approval. | [payroll](docs/features/payroll.md) |
| 9 | Wise Activity Audit | stable | Read-only persisted Wise audit-event store with KPIs, filters, package-sales reconciliation against Sales Dashboard rows, and manual backfill. Cron `2,17,32,47 * * * *`. | [wise-activity-audit](docs/features/wise-activity-audit.md) |
| 10 | Post-Class Feedback | stable | Preserves every Wise teacher-feedback version as immutable evidence, derives tutor timeliness and authorship from Wise activity events, and scores an objective deadline/content policy. Read-only toward Wise; never writes Payroll. Largest subsystem after Admissions: 32 tables, 13 endpoints, 6 internal cron routes, 38 lib test suites. | [post-class-feedback](docs/features/post-class-feedback.md) |
| 11 | Post-Class Payout | stable (writes flag-gated by `POST_CLASS_PAYOUT_WRITES_ENABLED` / `POST_CLASS_AUTO_APPROVE_ENABLED`) | The finance half of Post-Class Feedback: 7 `post_class_payout_*` tables, an hourly accrual+finalize cron (`33 * * * *`), rolling ledger writes to the Google Sheets payout master, and auto-un-charge by row deletion rather than netting. Scope is floored at `2026-08-26`; flipping either flag off restores human-only approvals or stops every sheet write. | [post-class-feedback → Payout runs](docs/features/post-class-feedback.md) |
| 12 | Learning Plans | stable | Stateless Years 1–13 syllabus-plan builder with a dedicated A4 print/PDF report; plan content is never stored (it lives in the URL), while access is database-backed via a fresh `learning_plan_access_grants` read in the Server Components. | [learning-plans](docs/features/learning-plans.md) |
| 13 | Student Promotions | stable | Audited July 1 Wise student grade/course/graduation workflow with future-session pay-band checks, pay-rate review, dry-run review, and verified apply. One-shot annual cron `5 17 30 6 *` — the only annual entry in `vercel.json`. | [student-promotions](docs/features/student-promotions.md) |
| 14 | LINE Integration | stable (scheduler write-path flag-gated) | LINE OA inbox: webhook ingest, contact resolution, classifier + scheduler reviews, OA-resolver, Wise-action audit, plus an admin-only schedule bot fail-closed on `LINE_SCHEDULE_BOT_ADMIN_IDS`. `ENABLE_LINE_SCHEDULER` gates whether the webhook accepts events at all; no code path in the feature ever mutates Wise. | [line-integration](docs/features/line-integration.md) |
| 15 | LINE Credit Bot | stable | Staff-group `/credit` and `/report` commands (`src/lib/line/credit-bot.ts`, `report-bot.ts`) replying with family credit balances and a Parent Report link, plus a daily run-out digest cron `3 2 * * *` (`credit-digest.ts`). Both commands are fail-closed **and silent** outside a stored `staff` audience (CRED-BOT-G1 / REP-BOT-G1) so balances can never surface in a parent chat. | *(no feature page)* |
| 16 | Proposals (Admin Holds) | experimental | Local-only tentative tutor-slot "holds" with same-tutor overlap detection; never written back to Wise; surfaced inside search. No page, no nav entry, no cron, no env flag. | [proposals](docs/features/proposals.md) |
| 17 | AI Scheduler | experimental | LLM parses pasted parent chat into strict JSON; the app proves availability deterministically via `executeSearch` and drafts a parent reply. The model never decides availability. Prompt + solver versioned per run; offline eval harness still iterating. | [ai-scheduler](docs/features/ai-scheduler.md) |
| 18 | Data Health | stable | Ops command center for cron firing, data freshness, Wise snapshot fidelity, and unresolved normalization issues. Backed by `cron_invocations` + `cron_alert_state` and the `cron-watchdog` cron (`7,37 * * * *`). Whether those crons actually fire in production is a runtime fact the repo cannot attest. | [data-health](docs/features/data-health.md) |
| 19 | Leave Requests | stable | Pulls tutor leave-form rows from a Google Sheet, matches to a Wise identity, computes affected sessions, gives admins a review worklist + sheet-status writeback. Its only Wise-facing capability is a **dry-run cancellation preview**. Cron `15,45 * * * *`. | [leave-requests](docs/features/leave-requests.md) |
| 20 | University Admissions | stable (parity-hardening code unmerged on `origin/codex/admissions-parity-hardening`; schema landed) | Counselor case management — cases, versioned checklists, college lists with decision chains, essays, activities, testing — plus a mobile-first student portal and a view-only, Thai-first parent dashboard. Largest surface in the app: **61 endpoints, 36 tables**, and the only route family that is not admin-only (`parent < student < counselor < admin`, re-resolved per case from Postgres). Cron `12 1 * * *`. Caveat: a parity-hardening commit's **schema** reached `main` inside an unrelated PR while its **code** did not, so `main` declares admissions tables and columns nothing on `main` reads. | [university-admissions](docs/features/university-admissions.md) |
| 21 | Competitor Intelligence | stable | Pulls competitor website/social/SERP evidence through Apify + DataForSEO under a monthly USD budget cap, normalizes each signal into a scored evidence item, and regenerates a daily brief + weekly War Room snapshot; AI read-outs have a deterministic fallback and suggestions are never auto-executed — a human promotes one into a tracked task. Weekly cron `28 18 * * 0` (Mon 01:28 Bangkok) — the only weekly entry in `vercel.json`. 16 tables, 9 endpoints. | [competitor-intelligence](docs/features/competitor-intelligence.md) |
| 22 | Progress Tests | stable | Tracks the every-8-attended-classes progress-test cadence per student-subject pair through an `accumulating → approaching → due → scheduled → completed` lifecycle, and drives the outbound nudges: a teacher heads-up at class 6 of 8 and a daily admin digest. Fail-closed on unresolvable teachers; its one Wise write capability is off by default. Crons `25,55 * * * *` + `35 0 * * *` digest. 8 tables, 6 endpoints. | [progress-tests](docs/features/progress-tests.md) |
| 23 | US Universities (IPEDS) | stable | Read-only research console over a curated IPEDS slice (active / Title IV / four-year / degree-granting): filterable institution search, dossiers, compare sets, five-year admissions trends, CSV export. Feeds the Admissions college list via an `Add to case` control; a college-list row **soft-references** `ipeds_institutions.unitId`, never an FK. All reads hit Postgres; the source `.accdb`/CSV are never touched at runtime. Offline operator-run ingest, no cron. 3 tables, 5 endpoints, 2 pages. | [us-universities](docs/features/us-universities.md) |
| 24 | Student Schedule | stable | Builds a student's monthly calendar from `credit_control_sessions` on the active credit-control snapshot, exports A4/PDF, and delivers it to a parent over LINE via a capability-token link at the public `/schedule/{token}` page — no account, no login. Admin preview, print report, and the phone-first Thai parent agenda all render the **same payload**. Cancelled sessions omitted; an unresolved teacher renders `TEACHER_TBC`, never inferred. 1 table, 2 endpoints. | [student-schedule](docs/features/student-schedule.md) |
| 25 | Parent Report (Student Report) | stable | Per-family class statement over a chosen Bangkok date window: attended/cancelled/no-show buckets, package rows, and optional tutor-feedback sub-rows, with an A4 print surface and CSV. **Owns no tables** — it joins `credit_control_*` on the active credit-control snapshot with `post_class_feedback_versions` (`src/lib/student-report/db.ts`). Reached from the nav as "Parent Report" and linked out of the LINE `/credit` and `/report` replies. 1 endpoint, 2 pages. | *(no feature page)* |

### Wise API client
- HTTP client with retry/backoff and a concurrency limiter (`src/lib/wise/client.ts`); `RETRYABLE_STATUS_CODES` is an explicit allowlist so 4xx fail fast instead of burning retries (`client.ts:37`, `:166`).
- Base URL `https://api.wiseapp.live`; auth via Basic Auth (base64 `userId:apiKey`) + `x-api-key` + `x-wise-namespace` + `user-agent: VendorIntegrations/{namespace}` (`client.ts:76`).
- Fetchers aligned to the live Wise contracts for teachers, availability, future sessions, locations, analytics, and activity events (`page_size <= 50`; date params untrusted).
- **Writeback policy**: classroom-assignment publishing updates only `location` for eligible `OFFLINE` sessions after explicit admin confirmation. LINE and Leave-Request Wise mutations remain dry-run/flag-gated. Post-Class Feedback never writes Wise. Two env flags (`WISE_SESSION_CREATE_VERIFIED`, `WISE_SESSION_OPERATIONS_VERIFIED`) gate unverified session operations.
- 180-day leave stitching across 26 seven-day windows (`src/lib/wise/fetchers.ts:61-87`).
- Mechanical detail: [`docs/reference/wise-api.md`](docs/reference/wise-api.md).

### Normalization pipeline (complete)
- **Identity resolution** — 5-step cascade: nickname regex → alias-table lookup → online/offline pair detection → unresolved → `data_issue` (`src/lib/normalization/identity.ts:81-177`)
- **Qualifications** — Wise tags parsed into subject/curriculum/level/examPrep via regex; unmapped → `data_issue`
- **Availability** — `workingHours` → recurring windows with overlap merge + de-dup
- **Leaves** — UTC→Asia/Bangkok conversion with overlap merge
- **Sessions** — blocking classification (CANCELLED/CANCELED non-blocking; unknown = blocking, fail-closed)
- **Modality** — derived from pair structure → session type → location → unresolved; never guessed
- **Timezone** — all conversions locked to `Asia/Bangkok` (also pinned in `vitest.config.ts`)

### Sync orchestrator (complete)
- One `runFullSync()` (`src/lib/sync/orchestrator.ts:50`) does fetch teachers → resolve identities → fetch availability/leaves per teacher → fetch future sessions → normalize qualifications → derive modality → write snapshot tables → validate → atomic promote, in a single try/catch.
- Failed syncs preserve the previous active snapshot; >50% unresolved identity groups blocks promotion. Per-teacher errors land in `data_issues` without aborting the run.
- Exposed at `GET/POST /api/internal/sync-wise` (cron secret, `maxDuration = 800`) and `POST /api/admin/sync-wise` (admin session).
- **Nine `*_sync_runs` ledgers** exist besides the tutor `sync_runs` table — `wise_activity`, `competitor`, `credit_control`, `payroll`, `leave_request`, `line_backlog_recovery`, `progress_test`, `post_class`, plus the sales-dashboard import-run lineage — each with its own single-flight guard rather than the snapshot/index machinery. Most enforce it in Postgres with a partial `uniqueIndex(...).where(status = 'running')`. See [`docs/reference/crons.md`](docs/reference/crons.md).

### Search & Compare engines (complete)
- In-memory index singleton loaded from the active snapshot; stale-detected per request.
- **Range search**: time window + class duration → backend sub-slots → availability grid; **recurring** vs **one-time** blocking modes; leaves block in both; qualification + modality filtering; fail-closed Needs-Review routing.
- **Compare**: week-scoped (`weekStart` defaults to the current Bangkok week) schedule assembly with weekday fallback, same-student conflict detection, shared-free-slot interval intersection, and incremental `fetchOnly` serialization backed by a client-side `Map<tutorGroupId:weekStart:version, CompareTutor>` cache.
- **Recommend / Copy-for-parent**: client-side slot ranking (`src/lib/search/recommend.ts`) feeds the recommended-slots hero and the editable parent-message drawer.

### Database schema (189 tables — summary)

All **189 tables** and **61 Postgres enums** are declared in `src/lib/db/schema.ts` (4,772 lines, Drizzle ORM) and migrated under `drizzle/` (69 `.sql` files). The count is mechanical: `grep -c "= pgTable(" src/lib/db/schema.ts` → `189`.

**Canonical home: [`docs/reference/database/index.md`](docs/reference/database/index.md)** — the full table inventory (SQL name, Drizzle export, grain, owning domain, exact `schema.ts` line range), per-domain ER diagrams under [`docs/reference/database/`](docs/reference/database/), and enum value sets in [`enums.md`](docs/reference/database/enums.md). Do not restate columns here.

| Domain | Tables | ERD |
|---|---:|---|
| `core` | 124 | [erd-core.md](docs/reference/database/erd-core.md) — the snapshot/ETL spine plus every newer subsystem hanging directly off it; broken down below |
| `line` | 13 | [erd-line.md](docs/reference/database/erd-line.md) — contacts, threads, messages, student links, scheduler reviews, Wise-action logs, OA-resolver runs/rows, group settings, credit-digest runs |
| `credit-control` | 11 | [erd-credit-control.md](docs/reference/database/erd-credit-control.md) — independent snapshot lineage + human-owned sidecar tables keyed by `studentKey` |
| `classrooms` | 9 | [erd-classrooms.md](docs/reference/database/erd-classrooms.md) — assignment runs, rows, publish jobs, automation events, schedule/admin email runs + recipients |
| `payroll` | 8 | [erd-payroll.md](docs/reference/database/erd-payroll.md) — all keyed by `payrollMonth`; rate-card versions + rules |
| `sales-dashboard` | 7 | [erd-sales-dashboard.md](docs/reference/database/erd-sales-dashboard.md) — monthly sources + import runs + parsed rows + scenario projections |
| `ai-and-proposals` | 6 | [erd-ai-and-proposals.md](docs/reference/database/erd-ai-and-proposals.md) — proposal bundles/items + AI-scheduler conversations/messages/runs/feedback |
| `leave-requests` | 5 | [erd-leave-requests.md](docs/reference/database/erd-leave-requests.md) — sync runs, requests, affected sessions, activity logs, notifications |
| `room-capacity` | 4 | [erd-room-capacity.md](docs/reference/database/erd-room-capacity.md) — forecast model runs + drivers + demand/package mix |
| `tutor-profiles` | 2 | [erd-tutor-profiles.md](docs/reference/database/erd-tutor-profiles.md) — contacts + business profiles, keyed by stable `canonicalKey` |
| **Total** | **189** | |

`core` is too coarse to navigate at 124 tables, so its sub-areas (matching the section numbering of [`erd-core.md`](docs/reference/database/erd-core.md)):

| § | Sub-area | Tables |
|---|---|---:|
| 1 | Snapshot & sync control plane, cron observability, activity audit, auth & access | 9 |
| 2 | Tutor identity, normalization, session blocks & data health | 13 |
| 3 | Competitor intelligence (`competitor_*`) | 16 |
| 4 | Student promotion (`student_promotion_*`) | 6 |
| 5 | Progress tests (`progress_test_*`) | 8 |
| 6 | US universities / IPEDS (`ipeds_*`) | 3 |
| 7 | Post-class feedback — config, evidence, notifications, AI, finance, payout (`post_class_*`) | 32 |
| 8 | University admissions case management (`admissions_*`) | 36 |
| 9 | Student monthly schedule (`student_schedule_links`) | 1 |
| | **Total** | **124** |

Three recurring grain patterns are worth naming once: **snapshot-scoped** tables carry a `snapshotId` FK and are rewritten wholesale per ETL run (readers only ever see `snapshots.active = true`); **snapshot-independent** tables are keyed by a durable natural key (email, `student_key`, `canonical_key`, `wise_session_id`, `group_canonical_key`) and deliberately survive rotation — `past_session_blocks` carries the schema comment naming itself the one cross-snapshot tutor data table; and most `*_sync_runs` ledgers enforce single-flight with a partial `uniqueIndex(...).where(status = 'running')`, so the guard lives in Postgres rather than application code.

### API routes (243 endpoints — summary)

All handlers live under `src/app/api/**/route.ts` — **180 route files exporting 243 method+path endpoints**.

**Canonical home: [`docs/reference/api/index.md`](docs/reference/api/index.md)** — the master method + path + auth tier + purpose table, routing to a detail page per group. Endpoint request/response shapes, query params, and error codes live there, never here.

> **How 243 is counted**, because a naive grep disagrees: 241 named `export async function GET|POST|PUT|PATCH|DELETE` handlers, **plus 2** for the Auth.js catch-all, which exports its methods by destructuring (`export const { GET, POST } = handlers`, `src/app/api/auth/[...nextauth]/route.ts:3`) and so matches no `function` grep. Two CORS preflight `OPTIONS` handlers on the public OA-resolver routes (`line/contacts/oa-resolver/worklist`, `.../runs/[runId]/rows`) are **excluded** — they carry no business surface. Counting `line` therefore yields 29, not 31.

Auth tiers are **public** (middleware allowlist plus an in-handler signature or opaque bearer check), **admin** (Auth.js session, optionally plus a fresh Postgres capability grant — `` admin + cap:`X` `` for Post-Class Feedback), **session (role: X)** (University Admissions only — per-case rights re-resolved from Postgres under `parent < student < counselor < admin`), **cron** (`CRON_SECRET`), and **cron | admin** (secret check with a session fallback, for manual sync reruns).

| Group | Path prefix | Endpoints | Detail page |
|---|---|---:|---|
| admissions | `/api/admissions` | 61 | [university-admissions.md](docs/reference/api/university-admissions.md) |
| internal | `/api/internal` | 31 | [internal-crons.md](docs/reference/api/internal-crons.md) |
| line | `/api/line` | 29 | [line.md](docs/reference/api/line.md) |
| post-class-feedback | `/api/post-class-feedback` | 13 | [misc.md](docs/reference/api/misc.md) |
| sales-dashboard | `/api/sales-dashboard` | 13 | [sales-dashboard.md](docs/reference/api/sales-dashboard.md) |
| competitor-intelligence | `/api/competitor-intelligence` | 9 | [misc.md](docs/reference/api/misc.md) |
| student-promotions | `/api/student-promotions` | 9 | [student-promotions.md](docs/reference/api/student-promotions.md) |
| ai-scheduler | `/api/ai-scheduler` | 8 | [ai-scheduler.md](docs/reference/api/ai-scheduler.md) |
| class-assignments | `/api/class-assignments` | 8 | [classrooms-and-assignments.md](docs/reference/api/classrooms-and-assignments.md) |
| credit-control | `/api/credit-control` | 8 | [credit-control.md](docs/reference/api/credit-control.md) |
| progress-tests | `/api/progress-tests` | 6 | [misc.md](docs/reference/api/misc.md) |
| leave-requests | `/api/leave-requests` | 5 | [misc.md](docs/reference/api/misc.md) |
| payroll | `/api/payroll` | 5 | [payroll.md](docs/reference/api/payroll.md) |
| us-universities | `/api/us-universities` | 5 | [misc.md](docs/reference/api/misc.md) |
| wise-activity | `/api/wise-activity` | 5 | [wise-activity.md](docs/reference/api/wise-activity.md) |
| tutor-profiles | `/api/tutor-profiles` | 4 | [misc.md](docs/reference/api/misc.md) |
| proposals | `/api/proposals` | 3 | [proposals.md](docs/reference/api/proposals.md) |
| room-capacity | `/api/room-capacity` | 3 | [room-capacity.md](docs/reference/api/room-capacity.md) |
| search | `/api/search` | 3 | [misc.md](docs/reference/api/misc.md) |
| auth | `/api/auth` | 2 | [misc.md](docs/reference/api/misc.md) |
| classrooms | `/api/classrooms` | 2 | [classrooms-and-assignments.md](docs/reference/api/classrooms-and-assignments.md) |
| compare | `/api/compare` | 2 | [misc.md](docs/reference/api/misc.md) |
| data-health | `/api/data-health` | 2 | [misc.md](docs/reference/api/misc.md) |
| student-schedule | `/api/student-schedule` | 2 | [misc.md](docs/reference/api/misc.md) |
| admin | `/api/admin` | 1 | [misc.md](docs/reference/api/misc.md) |
| filters | `/api/filters` | 1 | [misc.md](docs/reference/api/misc.md) |
| home | `/api/home` | 1 | [misc.md](docs/reference/api/misc.md) |
| student-report | `/api/student-report` | 1 | [misc.md](docs/reference/api/misc.md) |
| tutors | `/api/tutors` | 1 | [misc.md](docs/reference/api/misc.md) |
| **Total** | | **243** | |

Public routes are exactly the middleware allowlist (`src/middleware.ts:10-26`): `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/schedule/*`, `/api/line/contacts/oa-resolver/worklist`, `/api/line/contacts/oa-resolver/runs/{runId}/rows`, and all of `/api/internal/*`. Each enforces its own in-handler check — LINE channel signature, an opaque resolver bearer token, a hashed capability token, or the cron secret. Two entries are stricter than the allowlist implies: `POST /api/search/assistant` still calls `auth()` and 401s without a session (effectively admin-only), and `GET /api/classrooms/floor-plan-map` has no in-handler check because it is a pure SVG renderer that reads no database and no session.

### Frontend

#### Design system
- **Palette**: sky-blue primary (OKLCH hue 230) + amber accent, cream backgrounds; semantic tokens `--available` / `--blocked` / `--conflict` / `--free-slot` (`src/app/globals.css:18-21`, `:94-97`)
- **Layout**: side-by-side search/compare split on `/search`; viewport-height with internal panel scrolling; full-width operational pages elsewhere. Persistent `AppNav` top bar in the `(app)` route group with an `AppNavSkeleton` Suspense fallback that avoids `usePathname()` (required by `cacheComponents` on dynamic segments).
- **Navigation**: **22 tools** grouped into 6 sections — Scheduling & Tutors (9), Student Lifecycle (6), Finance & Revenue (3), Market Intelligence (1), Research & Reference (1), Data & Audit (2) — declared once in `src/lib/navigation/tools.ts`. **Seven** tools carry live count badges (`NavBadgeKey`, `tools.ts:32-39`: `leaveRequests`, `lineReviews`, `progressTests`, `creditControl`, `payroll`, `wiseReconciliation`, `dataHealth`) fed by `/api/home/summary` → `getHomeSummaryPayload`; **four** are pinned as shortcuts (Scheduler, Search, Class Assignments, Data Health).
- **Fonts**: Inter + JetBrains Mono via `next/font/google`; dark mode supported.
- **Session blocks**: shared `session-colors.ts` (RGBA fills, solid 3px left borders); free-gap green tint via `computeFreeGaps()`; D/M date format throughout compare.
- **Tutor colors**: `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]` (`src/components/compare/session-colors.ts:51`).

#### Pages (31 `page.tsx` files — 26 in the `(app)` group)

26 routable pages live under `src/app/(app)/`; 5 more sit outside it — three shell-free A4 print surfaces in `src/app/(print)/`, the `/login` page, and the public token-gated `/schedule/[token]` parent page. Nav labels and section order come from `src/lib/navigation/tools.ts`.

| # | Route | Nav label | Section | Purpose |
|---|---|---|---|---|
| 1 | `/` | — (home hub) | — | Landing hub with the action summary; single-page users are redirected to their one allowed page |
| 2 | `/scheduler` | Scheduler | Scheduling & Tutors | AI Scheduler workspace |
| 3 | `/scheduler/metrics` | Scheduler Metrics | Scheduling & Tutors | Read-only AI-scheduler accept/edit/reject metrics |
| 4 | `/search` | Search | Scheduling & Tutors | Tutor search + embedded compare workspace |
| 5 | `/compare` | — | — | Legacy client-side redirect to `/search` (preserves `?tutors=`) |
| 6 | `/line-review` | LINE AI Review | Scheduling & Tutors | LINE scheduler-review + contact/link tooling |
| 7 | `/leave-requests` | Leave Requests | Scheduling & Tutors | Tutor leave-request triage |
| 8 | `/class-assignments` | Class Assignments | Scheduling & Tutors | Daily room-assignment + publish + schedule email |
| 9 | `/tutor-profiles` | Tutor Profiles | Scheduling & Tutors | Editorial tutor business profiles + bulk import |
| 10 | `/room-capacity` | Room Capacity | Scheduling & Tutors | Utilization dashboard (month/forecast engines not surfaced) |
| 11 | `/post-class-feedback` | Class Feedback | Scheduling & Tutors | Feedback compliance, reminders, deduction review, payout runs |
| 12 | `/progress-tests` | Progress Tests | Student Lifecycle | Due / scheduled / completed progress-test cycles |
| 13 | `/student-schedule` | Student Schedule | Student Lifecycle | Monthly student calendar, PDF export, LINE delivery |
| 14 | `/student-report` | Parent Report | Student Lifecycle | Per-family class statement over a date window + CSV |
| 15 | `/learning-plans` | Learning Plans | Student Lifecycle | Years 1–13 syllabus plan builder |
| 16 | `/student-promotions` | Student Promotions | Student Lifecycle | Review and apply audited July promotion actions |
| 17 | `/admissions` | Admissions | Student Lifecycle | Admissions caseload list |
| 18 | `/admissions/[caseId]` | — | Student Lifecycle | Single admissions case workspace |
| 19 | `/sales-dashboard` | Sales Dashboard | Finance & Revenue | GM sales command center |
| 20 | `/credit-control` | Credit Control | Finance & Revenue | At-risk student follow-up queue |
| 21 | `/payroll` | Payroll | Finance & Revenue | Monthly tutor pay reconciliation |
| 22 | `/competitor-intelligence` | Competitor BI | Market Intelligence | Competitor activity, SEO visibility, offers, response tasks |
| 23 | `/us-universities` | US Universities | Research & Reference | IPEDS research console |
| 24 | `/us-universities/[unitId]` | — | Research & Reference | Single-institution dossier |
| 25 | `/wise-activity` | Wise Audit | Data & Audit | Persisted Wise activity events + reconciliation |
| 26 | `/data-health` | Data Health | Data & Audit | Sync freshness, cron health, normalization issues |

Outside `(app)` — 5 more `page.tsx` files:

| # | File | Purpose |
|---|---|---|
| 27 | `src/app/(print)/learning-plans/report/page.tsx` | A4 learning-plan print/PDF surface |
| 28 | `src/app/(print)/student-report/report/page.tsx` | A4 parent class-report print/PDF surface (auth-gated; every failure mode renders a visible card rather than a blank sheet) |
| 29 | `src/app/(print)/student-schedule/report/page.tsx` | A4 monthly student-schedule print/PDF surface |
| 30 | `src/app/login/page.tsx` | Google sign-in |
| 31 | `src/app/schedule/[token]/page.tsx` | Public parent schedule, capability-token gated, no session |

#### Known UX issues
- **Past-day session fallback**: Wise's `status: "FUTURE"` API omits past sessions; `buildCompareTutor` falls back to the nearest future occurrence (deduped by `recurrenceId`) for weekdays with no data. One-time past sessions cannot be recovered.
- **Online/onsite detection**: the `location`-pattern heuristic is unreliable in search/compare, so the visual modality distinction was removed from cards; modality still shows in the popover. Student Schedule and Parent Report solve it differently and reliably, via the Wise session-title prefix (`deriveSessionModality`).
- **Room Capacity month/forecast**: engines and endpoints are complete and tested but have no frontend consumer.

### Tests

**389 Vitest test files** (`*.test.ts` / `*.test.tsx`) under `src/**/__tests__/`. Two projects are configured in `vitest.config.ts`: **`unit`** (node env, the default `npm test`) and **`integration`** (`*.integration.test.ts`, serial forks, 60s timeouts, `npm run test:integration`). `process.env.TZ` is pinned to `Asia/Bangkok` at config load so date assertions are deterministic.

**13 files are integration tests** backed by ephemeral Postgres via `testcontainers` — 10 under `src/lib/post-class-feedback/` (auto-approval, backfill window, deleted-session retirement, payout accrual/repository/retirement/run, recent readiness, recheck queue, source-status restore) and 3 under `src/lib/sync/` (orchestrator, past-sessions diff hook, snapshot pruning).

Distribution by top-level area: **`src/lib` 220**, **`src/components` 84**, **`src/app` 83** (82 under `src/app/api/**`, plus one page-params suite), **`src/__tests__` 2** (`vercel-crons.test.ts` pins every cron schedule and asserts no two fire in the same UTC minute; `middleware.test.ts` pins the auth gate).

Largest suites, by directory:

| Area | Files | What it covers |
|---|---:|---|
| `src/app/api/**` | 82 | Per-route handler tests across nearly every endpoint group |
| `src/lib/post-class-feedback` | 38 | Evidence sync, policy, auto-approval, finance lock, payout window/plan/run/writer/retirement, Drive, AI |
| `src/lib/line` | 24 | Webhook, signature, classifier confidence, contact aliases, link validation, OA-resolver, review service, operational planner, schedule bot, credit/report bot, credit digest |
| `src/components/us-universities` | 23 | Research console filters, charts, compare set, dossier sections |
| `src/components/admissions` | 22 | Case workspace, checklist, college list, essays, parent/student shells |
| `src/lib/admissions` | 21 | Access/role resolution, case data, parent projection, notifications |
| `src/lib/us-universities` | 13 | Parser, query builder, transform, trend/chart shaping, CSV |
| `src/lib/sales-dashboard` | 13 | Parser, analytics, projection, lifecycle, import guard, GM insights |
| `src/lib/progress-tests` | 11 | Counting engine, booking, recommend, parent message, digest |
| `src/lib/classrooms` | 11 | Capacity/TV/online-only rooms, continuity, overflow, overrides, publish eligibility, reconciliation, emails, morning automation, floor-plan map |
| `src/lib/normalization` | 7 | Identity, timezone, availability, leaves, sessions, modality, qualifications |
| `src/lib/credit-control` | 7 | Sync + Wise projection |
| `src/lib/competitor-intelligence` | 6 | Providers, budget cap, normalization, war room, AI fallback |
| `src/components/post-class-feedback` | 6 | Review + deduction UI |
| `src/lib/search` | 5 | Engine, compare, parser, recommend |
| `src/lib/room-capacity` | 5 | Utilization, analysis, forecast, package mix, dates |
| `src/lib/payroll` | 5 | Domain, data, rate card, sync, reconciliation |
| `src/lib/data-health` | 5 | Cron registry, status derivation, watchdog, job runner |
| `src/components/student-schedule` | 5 | Month calendar, parent agenda, delivery controls |
| `src/lib/sync` | 4 | Orchestrator, modality conflicts, snapshot pruning, past-session diff hook |
| `src/lib/student-report` | 4 | Window resolution, build, CSV, params |
| `src/lib/leave-requests` | 4 | Parser, matching, affected sessions |
| `src/lib/learning-plans` | 4 | Access policy, plan building, report |
| `src/lib/ai` | 4 | Conversation, scheduler service, academic levels, correction telemetry |
| Remaining `src/lib/*` and `src/components/*` | 57 | Wise client + fetchers, Wise activity, cached data layer, student-schedule, student-promotions, syllabus, proposals, navigation, home summary, calendar, auth sign-in callback, ops, internal cron auth, UI helpers, and per-feature component suites |

## Production Status

Production Wise snapshot sync is live (`*/30 * * * *`) with a single-flight guard; abandoned `running` rows are failed after a timeout. Schedules are **UTC**; the business timezone is `Asia/Bangkok` (UTC+7).

**Ten jobs fire at least hourly**, deliberately staggered so no two ever hit the Wise API or Neon in the same minute: Wise snapshot :00/:30 → Wise activity :02/:17/:32/:47 → watchdog :07/:37 → sales :10/:40 → post-class collection :13/:43 → leave requests :15/:45 → credit control :20/:50 → post-class backfill :23/:53 → progress tests :25/:55 → payout accrual :33. **Five are daily** (class-assignment admin email `4,14,24,36 0 * * *`, progress-test digest `35 0 * * *`, admissions notifications `12 1 * * *`, LINE credit digest `3 2 * * *`, classroom morning `41 23 * * *`), **one weekly** (competitor intelligence `28 18 * * 0` = Mon 01:28 Bangkok), and **one annual** (student promotions `5 17 30 6 *`). A regression test pins every schedule and the no-collision rule (`src/__tests__/vercel-crons.test.ts:17-35`). Full schedule table: [`docs/reference/crons.md`](docs/reference/crons.md).

### Known drift and open items
- **University Admissions schema/code split**: the parity-hardening commit lives only on `origin/codex/admissions-parity-hardening` and is not an ancestor of `main`, while its migrations (`0053`, `0054`) reached `main` inside an unrelated PR. `main` therefore declares admissions tables and columns that no code on `main` reads or writes. Whether those migrations have been applied to the production Neon database is a runtime fact the repo cannot attest.
- **Post-Class Feedback enforcement is prospective**: it starts in `shadow`, and an access manager must clear the setup checklist (including a minimum 20-session recent sample) and choose a current-or-future effective instant before any session can produce a deduction. Once recorded, the live effective instant is immutable.
- **Unattended payout charging is armed but doubly floored**: auto-approval and ledger retirement key on `POST_CLASS_AUTO_APPROVE_ENABLED === "true"` and never act before `2026-08-26` or before the last-ended payout window's start; `POST_CLASS_PAYOUT_WRITES_ENABLED` is the independent kill switch for every sheet write.
- **Three surfaces have no `docs/features/` page**: Parent Report (`/student-report`) and the LINE Credit Bot have none at all; Post-Class Payout is documented inside the Post-Class Feedback page.
- **Room Capacity month/forecast engines** have no frontend consumer; the room-utilization sync is `manualOnly` with no `vercel.json` entry.
- **`src/lib/env.ts` has no importer** — the module exports `env = getEnv()`, which validates at module-evaluation time, but nothing evaluates it. Consumers read `process.env.*` directly and fail at their own call site. See [`docs/reference/env.md`](docs/reference/env.md).
- Monitor sync duration headroom against the 800s function timeout.

Running list of unresolved questions: [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md).

## Source of Truth Rules
- Production truth comes from the Wise API only (tenant: `begifted-education`, institute: `696e1f4d90102225641cc413`).
- Search runs against precomputed normalized Wise snapshots + warm in-memory index.
- No production fallback to Google Sheets or `.xlsx` files.
- Classroom assignment writeback is opt-in per run: local generation never updates Wise; only the explicit publish action writes eligible `OFFLINE` `location` values.

## Non-Negotiable Product Rules
- Never return a tutor as available unless the system can prove availability from normalized Wise data.
- Unresolved identity, modality, or qualification → `Needs review`, never `Available`.
- Cancelled sessions must not block availability.
- All times normalized to `Asia/Bangkok`.

## Stack
- Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui
- Auth.js with Google provider + admin allowlisting in Postgres
- Drizzle ORM + Neon Postgres (ap-southeast-1)
- Vercel hosting + Vercel Cron (30-min on Pro)
- In-memory search index (< 400ms warm queries)
- Vitest for unit testing

## Deployment
- **Production**: https://bgscheduler.vercel.app
- **Repo**: https://github.com/kasheesh711/bgscheduler
- **Deploy**: push to `main` — Vercel Git integration auto-deploys production. Guarded manual path (only from the Vercel-linked worktree, on `main`): `npm run deploy:prod`, which runs `verify:release` (`typecheck` → `test` → `build` → `typecheck` → `git diff --check` → `guard:production-route-surface`) then `scripts/assert-production-deploy-ready.mjs`, then `vercel --prod`. Do **not** run a bare `npx vercel --prod` from an unlinked worktree — it creates a stray Vercel project instead of deploying.
- **Database**: Neon Postgres `ep-calm-mud-a1d7pmsi.ap-southeast-1.aws.neon.tech`

## Environment Variables (9 required)
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon Postgres connection string |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `AUTH_SECRET` | Auth.js session encryption key |
| `WISE_USER_ID` | Wise API user ID |
| `WISE_API_KEY` | Wise API key |
| `WISE_NAMESPACE` | `begifted-education` |
| `WISE_INSTITUTE_ID` | `696e1f4d90102225641cc413` |
| `CRON_SECRET` | Protects sync endpoint from unauthorized calls |
| `LEAVE_REQUESTS_SPREADSHEET_ID` | Leave request Google Sheet ID, defaults to `109o2vbmxlJ-l2U18Rs_WrjD7TMF5b6h__GiNkkQIfS8` |
| `LEAVE_REQUESTS_SHEET_NAME` | Source tab, defaults to `Form Responses 1` |
| `LEAVE_REQUESTS_CONNECTED_EMAIL` | Google OAuth token owner for cron/read/writeback; must have full Sheets scope for status writes |

> The table above is the historical required-vars contract and is preserved verbatim. It is **no longer the complete picture**. `src/lib/env.ts:3-36` declares **18** keys in three buckets — 7 hard-required (`DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `CRON_SECRET`), 2 defaulted (`WISE_NAMESPACE`, `WISE_INSTITUTE_ID`), and 9 optional (`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS`, `ENABLE_STUDENT_SCHEDULE_LIVE`, `STUDENT_SCHEDULE_LINK_TTL_DAYS`, `APP_BASE_URL`, `MAINTENANCE_MODE`, `MAINTENANCE_BYPASS_EMAILS`) — and does **not** declare the three `LEAVE_REQUESTS_*` vars, which are read directly from `process.env` in `src/lib/leave-requests/config.ts`. The effective inventory is far larger: **69 named keys** are read by non-test `src/` at runtime and **74** across the whole repo, including the nine `POST_CLASS_PAYOUT_*` keys read through a helper in `src/lib/post-class-feedback/payout-config.ts`. The reconciled inventory is [`docs/reference/env.md`](docs/reference/env.md).

## Admin Users (9 allowlisted)
- aoengnatchasmith@gmail.com
- chiraya.work@gmail.com
- k.waritpariya@gmail.com
- kevhsh7@gmail.com
- kevinhsieh711@gmail.com
- kittiya.carekt@gmail.com
- pakwalaan@gmail.com
- panida.wiya@gmail.com
- suphitsaramanosamrit@gmail.com

> Preserved verbatim. Note that full-access admins are seeded from `SEED_ADMIN_EMAILS` at runtime (`src/lib/db/seed.ts:31`), and the seed script additionally provisions at least one page-restricted user with a narrow `allowedPages` scope (`seed.ts:46-48`) — restricted users are not part of this list.

## Change Control
- Do not weaken the strict-fidelity rule without explicit user approval.
- Do not replace the locked stack without explicit user approval.
- Do not introduce sheet fallback without explicit user approval.
- If Wise behavior or tenant modeling changes, update the documentation before changing system behavior.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
