<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md — BGScheduler

> **Handbook:** Start at [`docs/README.md`](docs/README.md) — the entry point for the full code-verified handbook (architecture, feature guides, and the API/DB/cron/env reference). This file is the orientation map; the handbook is the detail.

## Status: Live — production sync active, staggered 30-minute crons running

The application is built, tested, deployed, and live at https://bgscheduler.vercel.app. Google OAuth login works. Production Wise snapshot sync is active on Vercel Pro, alongside staggered crons for Wise Activity audit, Sales Dashboard, Credit Control, Leave Requests, and the daily classroom-assignment automation. The codebase has grown well beyond the original tutor-search tool: it now spans 14 feature areas (some stable, some experimental, one uncommitted), 78 database tables, 110 HTTP endpoints, and 14 application pages.

## What Is Built

### Infrastructure (complete)
- Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui (`@base-ui/react` primitives)
- Auth.js (NextAuth v5 beta) with Google provider + `admin_users` allowlist enforced in `src/middleware.ts`
- Drizzle ORM + Neon Postgres (ap-southeast-1), Neon serverless HTTP driver
- Vercel hosting with twelve Vercel Cron entries (`vercel.json`) — six staggered high-frequency sync jobs at 5-minute offsets, one weekly competitor-intelligence sync, two progress-test jobs, two daily classroom-email/automation jobs, one Student Promotions one-shot, and a cron watchdog — each guarded by `CRON_SECRET`; sync pipelines use single-flight guards where overlapping writes would be unsafe. See [`docs/reference/crons.md`](docs/reference/crons.md).
- In-memory `SearchIndex` singleton loaded from the active Postgres snapshot; stale-detected and rebuilt on snapshot change
- Vitest unit/integration suite (see [Tests](#tests))

### Feature areas (14)

Status badges are taken from the feature docs under [`docs/features/`](docs/features/) (the canonical home for purpose, rules, and flows). No `@deprecated` markers exist in code; these labels come from the docs' own `Status:` lines.

| # | Feature | Status | One-line summary | Doc |
|---|---|---|---|---|
| 1 | Tutor Search | live (primary entry) | Range/slot availability search against the warm in-memory snapshot index; fail-closed Needs-Review routing. | [tutor-search](docs/features/tutor-search.md) |
| 2 | Tutor Compare | legacy-redirect | Side-by-side week-scoped comparison (conflicts + shared free slots) inside `/search`; standalone `/compare` redirects there. Engine + API fully active. | [tutor-compare](docs/features/tutor-compare.md) |
| 3 | Data Health | stable | Sync status, snapshot stats, and normalization-issue dashboard. | [data-health](docs/features/data-health.md) |
| 4 | Wise Activity Audit | stable | Read-only persisted Wise audit-event store with KPIs, filters, package-sales reconciliation, and manual backfill. | [wise-activity-audit](docs/features/wise-activity-audit.md) |
| 5 | Classroom Assignments | stable | Daily room-assignment runs, overrides, opt-in publish of eligible OFFLINE `location` to Wise, teacher/admin schedule emails, morning automation. | [classroom-assignments](docs/features/classroom-assignments.md) |
| 6 | Sales Dashboard | stable | Imports monthly sales sheets + scenario projections (Bear/Base/Bull) into Postgres; GM command-center readout. Owns the shared Google-Sheets access layer. | [sales-dashboard](docs/features/sales-dashboard.md) |
| 7 | Credit Control | stable | Projects student prepaid-credit depletion and ranks an at-risk follow-up queue; read-mostly against Wise, persists only follow-up/ownership/inactive state. | [credit-control](docs/features/credit-control.md) |
| 8 | Payroll | stable | Reconciles tutor pay for a Bangkok month from Wise sessions + payout invoices against a rate card; review + manual adjustments. | [payroll](docs/features/payroll.md) |
| 9 | Tutor Profiles | stable | Editorial business context Wise does not store (parent-safe summary, fit, tags); keyed by stable `canonicalKey`; read by the AI scheduler. | [tutor-profiles](docs/features/tutor-profiles.md) |
| 10 | LINE Integration | stable (write-path dry-run) | LINE OA inbox: webhook ingest, contact resolution, classifier + scheduler reviews, OA-resolver, Wise-action audit. Reply/Wise writeback flag-gated (`ENABLE_LINE_SCHEDULER`) and dry-run only. | [line-integration](docs/features/line-integration.md) |
| 11 | Room Capacity | partial | Live utilization dashboard (sync → API → UI); month-pressure and saturation-forecast engines are complete and tested but have **no frontend consumer yet**. | [room-capacity](docs/features/room-capacity.md) |
| 12 | Proposals (Admin Holds) | experimental | Local-only tentative tutor-slot "holds" with same-tutor overlap detection; never written back to Wise; surfaced inside search. | [proposals](docs/features/proposals.md) |
| 13 | AI Scheduler | experimental | LLM parses pasted parent chat into strict JSON, the app decides availability via `executeSearch`, and drafts a parent reply. Newest, least-settled feature; eval harness still iterating. | [ai-scheduler](docs/features/ai-scheduler.md) |
| 14 | Leave Requests | in progress (uncommitted) | Pulls tutor leave-form rows from a Google Sheet, matches to a Wise identity, computes affected sessions, and gives admins a review worklist + sheet-status writeback + dry-run Wise-cancel preview. Entire feature is present in the working tree but **uncommitted** at this revision. | [leave-requests](docs/features/leave-requests.md) |

### Wise API client
- HTTP client with retry/backoff (3 retries, 1s/2s/4s) and concurrency limiter (max 5, raised for production sync)
- Base URL `https://api.wiseapp.live`; auth via Basic Auth (base64 `userId:apiKey`) + `x-api-key` + `x-wise-namespace` + `user-agent: VendorIntegrations/{namespace}`
- Fetchers aligned to the live Wise contracts for teachers, availability, future sessions, locations, analytics (session/classroom stats + trends), and activity events (`page_size<=50`; date params untrusted)
- Writeback policy: classroom-assignment publishing updates only `location` for eligible `OFFLINE` sessions after explicit admin confirmation; LINE/Leave Wise mutations remain dry-run/flag-gated
- 180-day leave stitching across 26 seven-day windows
- Mechanical detail: see the Wise-facing feature docs and [`docs/reference/api/index.md`](docs/reference/api/index.md)

### Normalization pipeline (complete)
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
- Separate read-only sync lineages exist for Wise Activity audit, Sales Dashboard, Credit Control, Leave Requests, and room utilization — each its own internal cron route (see [`docs/reference/crons.md`](docs/reference/crons.md))

### Search & Compare engines (complete)
- In-memory index singleton loaded from the active snapshot; stale-detected per request
- **Range search**: time window + class duration → backend sub-slots → availability grid; **recurring** vs **one-time** blocking modes; leaves block in both; qualification + modality filtering; fail-closed Needs-Review routing
- **Compare**: week-scoped (`weekStart` defaults to current Bangkok week) schedule assembly with weekday fallback, same-student conflict detection, shared-free-slot interval intersection, and incremental `fetchOnly` serialization backed by a client-side `Map<tutorGroupId:weekStart, CompareTutor>` cache
- **Recommend / Copy-for-parent**: client-side slot ranking (`src/lib/search/recommend.ts`) feeds the recommended-slots hero and the editable parent-message drawer

### Database schema (78 tables — summary)

All 78 tables are defined in `src/lib/db/schema.ts` (Drizzle ORM) and migrated under `drizzle/`. They are organized by domain below; **for the full table inventory (SQL name, Drizzle export, grain, owning feature) and per-domain ER diagrams with columns/types/indexes, see [`docs/reference/database/index.md`](docs/reference/database/index.md)** — that is the canonical home for column-level detail.

| Domain | Tables | Notes |
|---|---|---|
| Core (snapshots, sync, audit, auth, tutors, normalization) | 19 | Snapshot model + atomic `active` promotion; most tutor tables are snapshot-scoped. `past_session_blocks` is the only cross-snapshot data table. |
| Sales Dashboard | 7 | Monthly sources + import runs + parsed rows + scenario projections. |
| Credit Control | 10 | Separate snapshot lineage + human-owned sidecar tables keyed by `studentKey`. |
| Classrooms (assignment + email) | 9 | Runs, rows, publish jobs, automation events, schedule/admin email runs + recipients. |
| Payroll | 8 | All keyed by `payrollMonth`; rate-card versions + rules. |
| Tutor Profiles | 2 | Contacts + business profiles, keyed by stable `canonicalKey`. |
| Leave Requests | 5 | Sync runs, requests, affected sessions, activity logs, notifications (**uncommitted**). |
| AI & Proposals | 6 | Proposal bundles/items + AI-scheduler conversations/messages/runs/feedback. |
| LINE | 8 | Contacts, threads, messages, student links, scheduler reviews, Wise-action logs, OA-resolver runs/rows. |
| Room Capacity | 4 | Capacity-forecast model runs + forecast drivers + demand/package mix. (`room_utilization_sessions` is grouped under Core but owned by this feature.) |
| **Total** | **78** | |

> Snapshot-independent tables (survive snapshot rotation): `admin_users`, `google_oauth_tokens`, `tutor_aliases`, `wise_activity_events`, `wise_activity_sync_runs`, `room_utilization_sessions`, and `past_session_blocks`. Postgres enums for `status`/`category`/`role` columns are declared at the top of `schema.ts`.

### API routes (110 endpoints — summary)

All routes live under `src/app/api/**/route.ts` (App Router). Auth tiers are **public** (middleware allowlist + in-handler signature/bearer checks), **admin** (Auth.js session), and **cron** (`CRON_SECRET`). **For the complete method+path+auth+purpose inventory and per-group request/response signatures, see [`docs/reference/api/index.md`](docs/reference/api/index.md)** — the canonical home for endpoint mechanics.

| Group | Endpoints | Purpose |
|---|---|---|
| Search | 3 | Range search, legacy slot search, public NL assistant |
| Compare | 2 | Compare 1-3 tutors; candidate discovery |
| Tutors / Filters | 2 | Combobox source; dropdown facets |
| AI Scheduler | 8 | Conversation CRUD, message turns, feedback, metrics |
| LINE | 28 | Webhook, contacts, scheduler reviews, link validation, OA-resolver, Wise-action logs |
| Class Assignments | 8 | Runs, overrides, publish + poll, teacher schedule, schedule email |
| Classrooms | 2 | Room catalog; public floor-plan map |
| Sales Dashboard | 10 | Payload, imports, sources CRUD/seed, projections |
| Credit Control | 8 | Payload, sync, single/bulk actions, history, ownership, inactive flag |
| Payroll | 5 | Payload, sync, review, adjustments |
| Room Capacity | 3 | Utilization, month view, forecast |
| Tutor Profiles | 4 | List, edit, import preview/commit |
| Proposals | 3 | Create bundle, list active, item lifecycle |
| Wise Activity | 5 | Events, summary, manual sync, reconciliation (+ backfill) |
| Leave Requests | 5 | List, detail, update, manual sync, Wise-cancel preview (**uncommitted**) |
| Data Health | 1 | Sync status + issue counts |
| Auth | 1 | Auth.js catch-all (public) |
| Admin | 1 | Admin-session Wise sync trigger |
| Internal / Cron | 12 | Cron-triggered sync + automation jobs (`CRON_SECRET`) |
| **Total** | **110** | Canonical count per the API index header. (Group rows mirror that index, whose per-group rows sum to 111 — the Auth catch-all `GET, POST /api/auth/[...nextauth]` is one route counted once.) |

### Frontend

#### Design system
- **Palette**: sky-blue primary (OKLCH hue 230) + amber accent (hue 75), cream backgrounds; semantic tokens `--available`/`--blocked`/`--conflict`/`--free-slot`
- **Layout**: side-by-side search/compare split on `/search`; viewport-height with internal panel scrolling; full-width operational pages elsewhere. Persistent `AppNav` top bar in the `(app)` route group (login excluded)
- **Fonts**: Inter + JetBrains Mono; dark mode supported
- **Session blocks**: shared `session-colors.ts` (RGBA fills, solid 3px left borders); free-gap green tint via `computeFreeGaps()`; D/M date format throughout compare
- **Tutor colors**: `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]`

#### Pages (14 application pages)

Routable pages live under `src/app/(app)/` (plus `/login` and the `/` → `/search` redirect outside the group). Nav order is defined in `src/components/layout/app-nav.tsx`.

| Route | Nav label | Feature |
|---|---|---|
| `/scheduler` | Scheduler | AI Scheduler workspace (also triages the LINE review queue) |
| `/scheduler/metrics` | Scheduler Metrics | Read-only AI-scheduler accept/edit/reject metrics |
| `/line-review` | LINE AI Review | LINE scheduler-review + contact/link tooling |
| `/search` | Search | Tutor search + embedded compare workspace |
| `/leave-requests` | Leave Requests | Tutor leave-request triage (**uncommitted**) |
| `/tutor-profiles` | Tutor Profiles | Editorial tutor business profiles + bulk import |
| `/class-assignments` | Class Assignments | Daily room-assignment + publish + schedule email |
| `/room-capacity` | Room Capacity | Utilization dashboard (month/forecast engines not yet surfaced) |
| `/sales-dashboard` | Sales Dashboard | GM sales command center |
| `/credit-control` | Credit Control | At-risk student follow-up queue |
| `/payroll` | Payroll | Monthly tutor pay reconciliation |
| `/wise-activity` | Wise Audit | Persisted Wise activity events + reconciliation |
| `/data-health` | Data Health | Sync status + normalization issues |
| `/compare` | — | Legacy redirect to `/search` (preserves `?tutors=`) |

#### Known UX issues
- **Past-day session fallback**: Wise's FUTURE API omits past sessions; `buildCompareTutor` falls back to the nearest future occurrence (deduped by `recurrenceId`) for weekdays with no data. One-time past sessions cannot be recovered.
- **Online/onsite detection**: location-pattern heuristic is unreliable; visual modality distinction removed from cards.

### Tests

130 Vitest test files (`*.test.ts` / `*.test.tsx`) under `src/**/__tests__/`, run with `npm test`. They cover, by area: the normalization pipeline (identity, timezone, availability, leaves, sessions, modality, qualifications); the Wise client contract + fetchers; the sync orchestrator (modality conflicts, snapshot pruning, past-session diff hook); search engine + compare engine + parser + recommend; the LINE integration (webhook, signature, classifier confidence, contact aliases, link validation, OA-resolver, review service, operational planner); classroom assignment (capacity/TV/online-only rooms, continuity, overflow, overrides, publish eligibility, reconciliation, schedule/admin emails, morning automation, floor-plan map); sales dashboard (parser, analytics, projection, lifecycle, import guard, GM insights); credit control (sync + Wise); payroll (domain, data, rate-card, sync, reconciliation); room capacity (utilization, analysis, forecast, package mix, dates); AI scheduler (conversation, scheduler, academic levels, correction telemetry); Wise activity audit (format, sync, reconciliation); proposals overlap; tutor-profile import; leave requests (parser, matching); auth sign-in callback; middleware; cron registration; and per-route API handler tests across most endpoint groups.

## Production Status

Production Wise snapshot sync is live (`*/30 * * * *`) with a single-flight guard; abandoned `running` rows are failed after a timeout. The five `sync-*` crons are staggered at 5-minute offsets so they never collide on the Wise API or the database in the same minute (see [`docs/reference/crons.md`](docs/reference/crons.md)). The Wise snapshot sync function carries `maxDuration = 800`.

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

_Verified against HEAD + uncommitted WIP on 2026-05-31._
