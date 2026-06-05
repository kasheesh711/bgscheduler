<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md — BGScheduler

> **Handbook:** Start at [`docs/README.md`](docs/README.md) — the entry point for the full code-verified handbook (architecture, feature guides, and the API/DB/cron/env reference). This file is the orientation map; the handbook is the detail.

## Status: Live — production sync active, staggered crons running

The application is built, tested, deployed, and live at https://bgscheduler.vercel.app. Google OAuth login works. Production Wise snapshot sync is active on Vercel Pro, alongside staggered crons for Wise Activity audit, Sales Dashboard, Credit Control, Progress Tests, Leave Requests, and the daily classroom-assignment automation. The codebase has grown well beyond the original tutor-search tool: it now spans **17 feature areas** (most stable, two experimental), **90 database tables**, **130 HTTP endpoints**, and **17 routable application pages** grouped into a four-section operations console.

## What Is Built

### Infrastructure (complete)
- Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui (`@base-ui/react` primitives)
- Auth.js (NextAuth v5 beta) with Google provider + `admin_users` allowlist enforced in `src/middleware.ts`. The middleware also enforces **page-level access control**: full-access admins have `allowedPages = null`, while restricted users (including scoped `teacher`-role sessions for Progress Tests) are limited to a prefix allowlist and get `403`/redirect outside it (`src/middleware.ts:25-37`, `:53-64`).
- Drizzle ORM + Neon Postgres (ap-southeast-1), Neon serverless HTTP driver; `pg` (node-postgres) only where transactions are required
- Vercel hosting with **ten Vercel Cron entries** (`vercel.json`) plus one manual-only job (`room_utilization`), giving **11 registered jobs** in the in-app `CRON_JOBS` registry (`src/lib/data-health/cron-registry.ts`). Scheduled jobs are staggered across the hour so they never collide on the Wise API or the database in the same minute; each is guarded by a constant-time `CRON_SECRET` check and a single-flight `running`-row guard. See [`docs/reference/crons.md`](docs/reference/crons.md).
- In-memory `SearchIndex` singleton loaded from the active Postgres snapshot; stale-detected and rebuilt on snapshot change
- Vitest unit/integration suite (see [Tests](#tests))

### Feature areas (17)

Status badges come from the per-feature docs under [`docs/features/`](docs/features/) (the canonical home for purpose, rules, and flows); the badge each doc carries was verified against the code it describes. No `@deprecated` markers exist in code. Every feature in the table below has a dedicated `docs/features/*.md` page, including Progress Tests ([`docs/features/progress-tests.md`](docs/features/progress-tests.md)) and the Ops Hub ([`docs/features/ops-hub.md`](docs/features/ops-hub.md)).

| # | Feature | Status | One-line summary | Doc |
|---|---|---|---|---|
| 1 | Tutor Search | live (primary entry) | Range/slot availability search against the warm in-memory snapshot index; fail-closed Needs-Review routing. | [tutor-search](docs/features/tutor-search.md) |
| 2 | Tutor Compare | legacy-redirect | Side-by-side week-scoped comparison (conflicts + shared free slots) inside `/search`; standalone `/compare` redirects there. Engine + API fully active. | [tutor-compare](docs/features/tutor-compare.md) |
| 3 | Tutor Profiles | stable | Editorial business context Wise does not store (parent-safe summary, fit, tags); keyed by stable `canonicalKey`; read by the AI scheduler. | [tutor-profiles](docs/features/tutor-profiles.md) |
| 4 | Classroom Assignments | stable | Daily room-assignment runs, overrides, opt-in publish of eligible OFFLINE `location` to Wise, teacher/admin schedule emails, morning automation. | [classroom-assignments](docs/features/classroom-assignments.md) |
| 5 | Room Capacity | partial | Live utilization dashboard (sync → API → UI); month-pressure and saturation-forecast engines are complete and tested but have **no frontend consumer yet**. | [room-capacity](docs/features/room-capacity.md) |
| 6 | Sales Dashboard | stable | Imports monthly sales sheets + scenario projections (Bear/Base/Bull) into Postgres; GM command-center readout. Owns the shared Google-Sheets access layer. | [sales-dashboard](docs/features/sales-dashboard.md) |
| 7 | Credit Control | stable | Projects student prepaid-credit depletion and ranks an at-risk follow-up queue; read-mostly against Wise, persists only follow-up/ownership/inactive state. | [credit-control](docs/features/credit-control.md) |
| 8 | Payroll | stable | Reconciles tutor pay for a Bangkok month from Wise sessions + payout invoices against a rate card; review + manual adjustments. | [payroll](docs/features/payroll.md) |
| 9 | Wise Activity Audit | stable | Read-only persisted Wise audit-event store with KPIs, filters, package-sales reconciliation, and manual backfill. | [wise-activity-audit](docs/features/wise-activity-audit.md) |
| 10 | Student Promotions | stable (pending first production run) | Audited July-1 Wise student grade/course promotion workflow with dry-run review and verified apply (confirm-token gated). | [student-promotions](docs/features/student-promotions.md) |
| 11 | LINE Integration | stable (write-path dry-run) | LINE OA inbox: webhook ingest, contact resolution, classifier + scheduler reviews, OA-resolver, Wise-action audit. Reply/Wise writeback flag-gated (`ENABLE_LINE_SCHEDULER`) and dry-run only. | [line-integration](docs/features/line-integration.md) |
| 12 | Proposals (Admin Holds) | experimental | Local-only tentative tutor-slot "holds" with same-tutor overlap detection; never written back to Wise; surfaced inside search. | [proposals](docs/features/proposals.md) |
| 13 | AI Scheduler | experimental | LLM parses pasted parent chat into strict JSON; the app decides availability via `executeSearch` and drafts a parent reply. The LLM never decides availability. Eval harness still iterating. | [ai-scheduler](docs/features/ai-scheduler.md) |
| 14 | Data Health | stable | Sync status, snapshot stats, cron-invocation audit, and normalization-issue dashboard; can manually trigger registered cron jobs. | [data-health](docs/features/data-health.md) |
| 15 | Leave Requests | live (preview-only Wise cancel) | Pulls tutor leave-form rows from a Google Sheet, matches to a Wise identity, computes affected sessions, and gives admins a review worklist + sheet-status writeback + dry-run Wise-cancel preview. | [leave-requests](docs/features/leave-requests.md) |
| 16 | Progress Tests | live | Every-8-attended-classes progress-test tracker — attendance ledger + cycle state, booking/at-home flows, parent LINE outreach + email, teacher heads-up, scoped read-only teacher view, daily admin digest. | [progress-tests](docs/features/progress-tests.md) |
| 17 | Ops Hub | stable | Operations landing at `/` — an access-filtered command center aggregating per-queue action counts (leave requests, LINE reviews, progress tests, credit control, payroll, Wise reconciliation, data health) plus a data-freshness strip; backed by `GET /api/home/summary` and the `NAV_TOOLS` registry (`src/lib/navigation/tools.ts`). | [ops-hub](docs/features/ops-hub.md) |

> The **Ops Hub** (feature #17) is the operations landing dashboard rendered at `/` (`src/app/(app)/page.tsx` → `HomeHub`, `src/components/home/home-hub.tsx`); it has its own page and feature doc ([`docs/features/ops-hub.md`](docs/features/ops-hub.md)). Single-page restricted users are redirected straight to their one allowed tool.

### Wise API client
- HTTP client with retry/backoff (3 retries, `1s/2s/4s` exponential delay — `src/lib/wise/client.ts:108`,`:129`) and a concurrency limiter (default `maxConcurrency = 5`, raised to `15` for production sync — `client.ts:48`,`:164`). `RETRYABLE_STATUS_CODES` is an explicit allowlist so non-retryable 4xx fail fast (`client.ts:23`).
- Base URL `https://api.wiseapp.live`; auth via Basic Auth (base64 `userId:apiKey`) + `x-api-key` + `x-wise-namespace` + `user-agent: VendorIntegrations/{namespace}`
- Fetchers aligned to the live Wise contracts for teachers, availability, future sessions, locations, analytics (session/classroom stats + trends), and activity events (`page_size<=50`; date params untrusted)
- Writeback policy: classroom-assignment publishing updates only `location` for eligible `OFFLINE` sessions after explicit admin confirmation; Student Promotions writes grade/course moves only after a verified, confirm-token-gated apply; LINE/Leave Wise mutations remain dry-run/flag-gated
- 180-day leave stitching across 26 seven-day windows
- Mechanical detail: see the Wise-facing feature docs and [`docs/reference/api/index.md`](docs/reference/api/index.md)

### Normalization pipeline (complete)
Seven modules under `src/lib/normalization/` (identity, availability, leaves, sessions, modality, qualifications, timezone):
- **Identity resolution** — 5-step cascade: nickname regex → alias-table lookup → online/offline pair detection → unresolved → `data_issue`
- **Qualifications** — Wise tags parsed into subject/curriculum/level/examPrep via regex; unmapped → `data_issue`
- **Availability** — `workingHours` → recurring windows with overlap merge + de-dup
- **Leaves** — UTC→Asia/Bangkok conversion with overlap merge
- **Sessions** — blocking classification (CANCELLED/CANCELED non-blocking; unknown = blocking, fail-closed)
- **Modality** — derived from pair structure → session type → location → unresolved; never guessed
- **Timezone** — all conversions locked to `Asia/Bangkok`

### Sync orchestrator (complete)
- Full pipeline: fetch teachers → resolve identities → fetch availability/leaves per teacher → fetch future sessions → normalize qualifications → derive modality → write snapshot tables → validate → atomic promote
- Failed syncs preserve the previous active snapshot; >50% unresolved identity groups blocks promotion
- Exposed at `GET/POST /api/internal/sync-wise` (cron secret) and `POST /api/admin/sync-wise` (admin session)
- Separate read-only sync lineages exist for Wise Activity audit, Sales Dashboard, Credit Control, Progress Tests, Leave Requests, and room utilization — each its own internal cron route (see [`docs/reference/crons.md`](docs/reference/crons.md))

### Search & Compare engines (complete)
- In-memory index singleton loaded from the active snapshot; stale-detected per request
- **Range search**: time window + class duration → backend sub-slots → availability grid; **recurring** vs **one-time** blocking modes; leaves block in both; qualification + modality filtering; fail-closed Needs-Review routing
- **Compare**: week-scoped (`weekStart` defaults to current Bangkok week) schedule assembly with weekday fallback, same-student conflict detection, shared-free-slot interval intersection, and incremental `fetchOnly` serialization backed by a client-side `Map<tutorGroupId:weekStart, CompareTutor>` cache
- **Recommend / Copy-for-parent**: client-side slot ranking (`src/lib/search/recommend.ts`) feeds the recommended-slots hero and the editable parent-message drawer

### Database schema (90 tables — summary)

All 90 tables are defined in `src/lib/db/schema.ts` (Drizzle ORM) and migrated under `drizzle/`. They are organized by domain below; **for the full table inventory (SQL name, Drizzle export, grain, owning feature) and per-domain ER diagrams with columns/types/indexes, see [`docs/reference/database/index.md`](docs/reference/database/index.md)** — that is the canonical home for column-level detail. Postgres enums for `status`/`category`/`role` columns are declared at the top of `schema.ts` and catalogued in [`docs/reference/database/enums.md`](docs/reference/database/enums.md).

| Domain | Tables | Notes |
|---|---|---|
| Core (snapshots, sync, audit, auth, tutors, normalization, student promotions, progress tests) | 32 | Snapshot model + atomic `active` promotion; most tutor tables are snapshot-scoped. Includes the 3 Student Promotion audit tables and the 8 Progress Test tables. |
| Sales Dashboard | 7 | Monthly sources + import runs + parsed rows + scenario projections. |
| Credit Control | 10 | Separate snapshot lineage + human-owned sidecar tables keyed by `studentKey`. |
| Classrooms (assignment + email) | 9 | Runs, rows, publish jobs, automation events, schedule/admin email runs + recipients. |
| Payroll | 8 | All keyed by `payrollMonth`; rate-card versions + rules. |
| Tutor Profiles | 2 | Contacts + business profiles, keyed by stable `canonicalKey`. |
| Leave Requests | 5 | Sync runs, requests, affected sessions, activity logs, notifications. |
| AI & Proposals | 6 | Proposal bundles/items + AI-scheduler conversations/messages/runs/feedback. |
| LINE | 8 | Contacts, threads, messages, student links, scheduler reviews, Wise-action logs, OA-resolver runs/rows. |
| Room Capacity | 4 | Capacity-forecast model runs + forecast drivers + demand/package mix. (`room_utilization_sessions` is grouped under Core but owned by this feature.) |
| **Total** | **90** | |

> **Snapshot-independent tables** (survive snapshot rotation): `cron_invocations`, `admin_users`, `google_oauth_tokens`, `tutor_aliases`, `wise_activity_events`, `wise_activity_sync_runs`, `room_utilization_sessions`, `past_session_blocks` (the only cross-snapshot *tutor-session* table, `PAST-01`/`D-04`), and the two cross-snapshot Progress Test accumulators `progress_test_attendance_ledger` and `progress_test_cycle_state`. The Credit Control, Sales Dashboard, Payroll, Room Capacity, Student Promotion, LINE, Leave Request, AI/Proposal, and Progress Test subsystems each keep their own run/sidecar tables independent of the Wise tutor snapshot.

### API routes (130 endpoints — summary)

All routes are Next.js App Router handlers under `src/app/api/**/route.ts`. One file can export several HTTP methods, so the 111 route files resolve to **130 endpoints** (the count tracked by the canonical index). Auth tiers are **public** (middleware allowlist + in-handler signature/bearer checks), **admin** (Auth.js session, the default), and **cron** (constant-time `CRON_SECRET`). **For the complete method+path+auth+purpose inventory and per-group request/response signatures, see [`docs/reference/api/index.md`](docs/reference/api/index.md)** — the canonical home for endpoint mechanics.

| Group | Purpose |
|---|---|
| Search | Range search, legacy slot search, public NL assistant |
| Compare | Compare 1–3 tutors; candidate discovery |
| Tutors / Filters | Combobox source; dropdown facets |
| AI Scheduler | Conversation CRUD, message turns, feedback, metrics |
| LINE | Webhook, contacts, scheduler reviews, link validation, OA-resolver, Wise-action logs |
| Class Assignments | Runs, overrides, publish + poll, teacher schedule, schedule email |
| Classrooms | Room catalog; public floor-plan map |
| Progress Tests | Payload (teacher-scoped vs admin), book, mark-complete, resend email, at-home select/submit |
| Student Promotions | Promotion-run CRUD, verify, confirm-token apply |
| Sales Dashboard | Payload, imports, sources CRUD/seed, projections |
| Credit Control | Payload, sync, single/bulk actions, history, ownership, inactive flag |
| Payroll | Payload, sync, review, adjustments |
| Room Capacity | Utilization, month view, forecast |
| Tutor Profiles | List, edit, import preview/commit |
| Proposals | Create bundle, list active, item lifecycle |
| Wise Activity | Events, summary, manual sync, reconciliation (+ backfill) |
| Leave Requests | List, detail, update, manual sync, Wise-cancel preview |
| Data Health | Sync status + issue counts; manual cron-job trigger |
| Auth / Admin | Auth.js catch-all (public); admin-session Wise sync trigger |
| Internal / Cron | Cron-triggered sync + automation jobs (`CRON_SECRET`) |

> A small `GET /api/home/summary` endpoint backs the nav-bar action badges and the Home Hub; it is reachable for restricted users (`src/middleware.ts:27`) but is not enumerated in the canonical API index — see [Open questions](#open-questions-and-gaps).

### Frontend

#### Design system
- **Palette**: sky-blue primary (OKLCH hue 230) + amber accent (hue 75), cream backgrounds; semantic tokens `--available`/`--blocked`/`--conflict`/`--free-slot`
- **Layout**: persistent `AppNav` top bar in the `(app)` route group (login excluded), branded "BeGifted Ops", organized into four section dropdowns — **Scheduling & Tutors**, **Student Lifecycle**, **Finance & Revenue**, **Data & Audit** — driven by `src/lib/navigation/tools.ts`; nav items render only for pages the signed-in user may access. Side-by-side search/compare split on `/search`; viewport-height with internal panel scrolling; full-width operational pages elsewhere.
- **Fonts**: Inter + JetBrains Mono; dark mode supported
- **Session blocks**: shared `session-colors.ts` (RGBA fills, solid 3px left borders); free-gap green tint via `computeFreeGaps()`; D/M date format throughout compare
- **Tutor colors**: `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]`

#### Pages (17 routable application pages)

Routable pages live under `src/app/(app)/` (plus `/login` outside the group). The Home Hub plus the 15 tools in `NAV_TOOLS` (`src/lib/navigation/tools.ts`) give **16 navigable pages**, grouped into four nav sections; the headline **17 routable `page.tsx`** count is those 16 plus the legacy `/compare` redirect.

| Route | Nav label | Section | Feature |
|---|---|---|---|
| `/` | Home | — (landing) | Home Hub operations dashboard (`HomeHub`); single-page users skip it |
| `/scheduler` | Scheduler | Scheduling & Tutors | AI Scheduler workspace |
| `/search` | Search | Scheduling & Tutors | Tutor search + embedded compare workspace |
| `/line-review` | LINE AI Review | Scheduling & Tutors | LINE scheduler-review + contact/link tooling |
| `/leave-requests` | Leave Requests | Scheduling & Tutors | Tutor leave-request triage |
| `/class-assignments` | Class Assignments | Scheduling & Tutors | Daily room-assignment + publish + schedule email |
| `/tutor-profiles` | Tutor Profiles | Scheduling & Tutors | Editorial tutor business profiles + bulk import |
| `/room-capacity` | Room Capacity | Scheduling & Tutors | Utilization dashboard (month/forecast engines not yet surfaced) |
| `/scheduler/metrics` | Scheduler Metrics | Scheduling & Tutors | Read-only AI-scheduler accept/edit/reject metrics |
| `/progress-tests` | Progress Tests | Student Lifecycle | Every-8-classes progress-test tracker (teacher-scoped view supported) |
| `/student-promotions` | Student Promotions | Student Lifecycle | July promotion review + verified apply |
| `/sales-dashboard` | Sales Dashboard | Finance & Revenue | GM sales command center |
| `/credit-control` | Credit Control | Finance & Revenue | At-risk student follow-up queue |
| `/payroll` | Payroll | Finance & Revenue | Monthly tutor pay reconciliation |
| `/wise-activity` | Wise Audit | Data & Audit | Persisted Wise activity events + reconciliation |
| `/data-health` | Data Health | Data & Audit | Sync status, cron health, normalization issues |
| `/compare` | — | — | Legacy redirect to `/search` (preserves `?tutors=`) |

#### Known UX issues
- **Past-day session fallback**: Wise's FUTURE API omits past sessions; `buildCompareTutor` falls back to the nearest future occurrence (deduped by `recurrenceId`) for weekdays with no data. One-time past sessions cannot be recovered.
- **Online/onsite detection**: location-pattern heuristic is unreliable; visual modality distinction removed from cards.

### Tests

**162 Vitest test files** (153 `*.test.ts` + 9 `*.test.tsx`, of which 3 are `*.integration.test.ts`) under `src/**/__tests__/`, run with `npm test`. Unit tests run in the `node` env; integration suites spin up an ephemeral Postgres via `testcontainers` (serial forks). They cover, by area: the normalization pipeline (identity, timezone, availability, leaves, sessions, modality, qualifications); the Wise client contract + fetchers; the sync orchestrator (modality conflicts, snapshot pruning, past-session diff hook); search engine + compare engine + parser + recommend; the LINE integration (webhook, signature, classifier confidence, contact aliases, link validation, OA-resolver, review service, operational planner); classroom assignment (capacity/TV/online-only rooms, continuity, overflow, overrides, publish eligibility, reconciliation, schedule/admin emails, morning automation, floor-plan map); sales dashboard (parser, analytics, projection, lifecycle, import guard, GM insights); credit control (sync + Wise); payroll (domain, data, rate-card, sync, reconciliation); room capacity (utilization, analysis, forecast, package mix, dates); AI scheduler (conversation, scheduler, academic levels, correction telemetry); Wise activity audit (format, sync, reconciliation); progress tests (engine, sync, booking, attendance ledger, teacher access, parent/teacher outreach, admin digest); student promotions; proposals overlap; tutor-profile import; leave requests (parser, matching); navigation/access control; auth sign-in callback; middleware; cron registration; and per-route API handler tests across most endpoint groups.

## Production Status

Production Wise snapshot sync is live (`*/30 * * * *`) with a single-flight guard; abandoned `running` rows are failed after a timeout. The scheduled `sync-*` crons are staggered across the hour so they never collide on the Wise API or the database in the same minute (see [`docs/reference/crons.md`](docs/reference/crons.md)). The Wise snapshot sync function carries `maxDuration = 800`.

### Optional improvements
- Monitor sync duration headroom against the 800s sync function timeout
- Surface the Room Capacity month/forecast engines in the UI (engines + APIs exist; no frontend consumer)

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
- **Deploy**: `npx vercel --prod` or push to `main` (once Git integration triggers)
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

## Change Control
- Do not weaken the strict-fidelity rule without explicit user approval.
- Do not replace the locked stack without explicit user approval.
- Do not introduce sheet fallback without explicit user approval.
- If Wise behavior or tenant modeling changes, update the documentation before changing system behavior.

_Verified against HEAD `d4fe6d3` on 2026-06-05._
