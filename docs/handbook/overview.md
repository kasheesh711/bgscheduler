# Overview

BGScheduler is the internal admin platform BeGifted Education runs on top of [Wise](https://api.wiseapp.live), the third-party scheduling system that holds the tenant's teachers, students, sessions, and billing. Wise is the source of truth but is slow and rate-limited, so BGScheduler keeps it off normal dashboard read paths: background jobs pull data, normalize it through dedicated domain modules, and persist it to Postgres; tutor availability alone additionally serves from an in-memory index rebuilt on snapshot change ([`src/lib/sync/orchestrator.ts:50`](../../src/lib/sync/orchestrator.ts), [`src/lib/search/index.ts:95-112`](../../src/lib/search/index.ts)). What began as a tutor-availability search tool now carries 27 documented feature areas covering scheduling, student lifecycle, finance, market intelligence, and data operations — all behind Google OAuth with a Postgres allowlist, except for one deliberately public parent-facing page.

Two rules shape almost every feature below. **Fail-closed**: an unresolved identity, modality, or qualification routes to "Needs review" and is never reported as available ([`src/lib/search/engine.ts:143`](../../src/lib/search/engine.ts)). **Read-mostly toward Wise**: writeback is opt-in, narrow, and usually flag-gated — a failed sync preserves the previous snapshot rather than promoting a partial one, and promotion is blocked outright when more than half of identity groups are unresolved ([`orchestrator.ts:476`](../../src/lib/sync/orchestrator.ts)).

## Maturity badges

Badges describe how much of a feature is wired end to end and reachable in production, not code quality. `stable` means the full path — sync, storage, API, and UI — is live. `experimental` means the surface exists and is reachable but the behavior is still being validated. Qualifiers in parentheses name the specific gate or gap.

---

## Scheduling & tutors

### Tutor Search — `stable`

The primary entry point and the reason the snapshot architecture exists. Admin staff give a time window, class duration, and optional qualification or modality filters; `executeSearch` slices the window into backend sub-slots and tests each tutor's availability grid against recurring and one-time blocking sessions plus dated leaves ([`src/lib/search/engine.ts:22`](../../src/lib/search/engine.ts)). Every query resolves against the warm in-memory index rather than Wise, so warm searches return in well under a second. Tutors whose data cannot prove availability are returned in a separate `needsReview` bucket, never merged into `available` ([`engine.ts:71,149`](../../src/lib/search/engine.ts)). See [tutor-search](../features/tutor-search.md).

### Tutor Compare — `legacy-redirect`

The comparison engine is fully live but its standalone page is not. `buildCompareTutor` assembles a week-scoped schedule per tutor, `detectConflicts` finds same-student collisions, and `findSharedFreeSlots` intersects free intervals across the selected tutors ([`src/lib/search/compare.ts:225,322,361`](../../src/lib/search/compare.ts)); both `/api/compare` endpoints serve it, and the workspace renders inside `/search`. The `/compare` route itself is now nothing but a client-side redirect that forwards any `?tutors=` parameter to `/search` ([`src/app/(app)/compare/page.tsx`](../../src/app/\(app\)/compare/page.tsx)), and it carries no nav entry. See [tutor-compare](../features/tutor-compare.md).

### Sales Dashboard — `stable`

Imports monthly sales workbooks and scenario projections from Google Sheets into Postgres and renders a GM-level command center over them. Projections are parsed against three fixed scenarios — Bear, Base, Bull — and the parser fails loudly rather than guessing when a scenario block or header row is missing ([`src/lib/sales-dashboard/projection.ts:14,93,147`](../../src/lib/sales-dashboard/projection.ts)). This feature owns the shared Google Sheets access layer that Leave Requests also borrows. 13 endpoints, 7 tables, cron at `10,40 * * * *`. See [sales-dashboard](../features/sales-dashboard.md).

### Credit Control — `stable`

Projects when each student's prepaid class credits will run out and ranks an at-risk follow-up queue for the team to work ([`src/lib/credit-control/projection.ts:10`](../../src/lib/credit-control/projection.ts)). It reads from Wise on its own snapshot lineage and persists only the human layer on top — follow-up state, ownership, and inactive flags — so re-syncing never destroys casework. 8 endpoints, 11 tables, cron at `20,50 * * * *`. See [credit-control](../features/credit-control.md).

### Payroll — `stable`

Reconciles tutor pay for a Bangkok calendar month by matching Wise sessions against payout invoices and a versioned rate card, then surfacing the differences for review and manual adjustment ([`src/lib/payroll/domain.ts:91`](../../src/lib/payroll/domain.ts)). Every table in the domain is keyed by `payrollMonth`, so months are independently recomputable. This is the one subsystem that uses the `pg` driver rather than Neon's HTTP driver, because its sync needs real transactions. 5 endpoints, 8 tables. See [payroll](../features/payroll.md).

### Wise Activity Audit — `stable`

A read-only persisted store of Wise audit events, giving the team KPIs, filters, and a package-sales reconciliation that pairs inbound invoice events against recorded sales ([`src/lib/wise-activity/reconciliation.ts:618,821`](../../src/lib/wise-activity/reconciliation.ts)). Because it never writes back, it doubles as the forensic record when another subsystem's numbers are questioned. Manual backfill is supported alongside the scheduled pull. 5 endpoints, 2 tables, cron at `2,17,32,47 * * * *` — the most frequent job in the fleet. See [wise-activity-audit](../features/wise-activity-audit.md).

### Classroom Assignments — `stable`

Generates daily room assignments, accepts per-row overrides, and emails schedules to teachers and admins, with a morning automation cron at `41 23 * * *` (Bangkok morning). It holds one of the app's few genuine Wise write paths, and that path is deliberately narrow: publishing updates only the `location` field, only for `OFFLINE` sessions, and only after an explicit admin action — anything else is refused with a stated reason ([`src/lib/classrooms/data.ts:1226`](../../src/lib/classrooms/data.ts)). Local generation never touches Wise. 8 endpoints, 9 tables. See [classroom-assignments](../features/classroom-assignments.md).

### LINE Integration — `stable (scheduler write-path flag-gated)`

The LINE Official Account inbox: signature-verified webhook ingest, contact resolution and student linking, an AI classifier with confidence scoring, a scheduler review queue, an OA-resolver worklist, and an admin-only schedule bot that fails closed on an explicit admin allowlist. Outbound scheduling actions are gated on `ENABLE_LINE_SCHEDULER` ([`src/lib/line/client.ts:20`](../../src/lib/line/client.ts)), and backlog recovery runs read-only unless a caller explicitly passes `dryRun=false` ([`src/lib/line/backlog-recovery.ts:115`](../../src/lib/line/backlog-recovery.ts)). 29 endpoints, 13 tables. See [line-integration](../features/line-integration.md).

### Room Capacity — `stable (utilization); forecast/month engines have no UI caller; sync is manualOnly`

Room utilization is wired end to end and is the only part users can reach: the dashboard fetches `/api/room-capacity/utilization` and nothing else ([`src/components/room-capacity/room-capacity-dashboard.tsx:354`](../../src/components/room-capacity/room-capacity-dashboard.tsx)). The `month` and `forecast` engines are implemented, tested, and authenticated, but their routes have no frontend consumer anywhere in `src/`. The feeding sync is registered `manualOnly: true` with no `vercel.json` entry, so it runs only when someone triggers it from the Data Health job list ([`src/lib/data-health/cron-registry.ts:370-382`](../../src/lib/data-health/cron-registry.ts)). 3 endpoints, 5 tables. See [room-capacity](../features/room-capacity.md).

### Onsite Foot Traffic — `stable`

An internal attendance proxy for how many students onsite classes bring into the centre. A visit requires an ended offline session, an active physical room, a non-teacher participant, and positive consumed credit; stable Wise student IDs are HMAC-fingerprinted so unique-student counts work without storing or exporting identity. The default research window is March–September 2026, with September labelled MTD until the month closes. The page includes exact tables beneath every chart, five CSV grains, and immutable self-contained HTML/PDF analytics packs. Its daily 01:18 Bangkok PAST-session reconciliation replaces the previous 35 completed days so late attendance and cancellations correct history. 6 endpoints including the cron, 4 tables. See [onsite-foot-traffic](../features/onsite-foot-traffic.md).

### Data Health — `stable`

The operations command center for everything above: cron firing history, data freshness, snapshot fidelity, and unresolved normalization issues. Its registry declares 24 jobs — the 19 scheduled in `vercel.json` plus 5 registered `manualOnly` — and each entry carries its own cadence, lateness threshold, and a confirmation label for the ones marked dangerous ([`src/lib/data-health/cron-registry.ts`](../../src/lib/data-health/cron-registry.ts)). The `cron-watchdog` job at `7,37 * * * *` supervises the rest. 2 endpoints. See [data-health](../features/data-health.md).

### Tutor Profiles — `stable`

Holds the editorial business context Wise has no field for — a parent-safe summary, fit notes, and searchable tags. Profiles are keyed by the stable `canonicalKey` from the identity group rather than a snapshot-scoped id, so they survive every snapshot rotation ([`src/lib/tutor-business-profiles.ts:237`](../../src/lib/tutor-business-profiles.ts)). The AI Scheduler reads these profiles when drafting recommendations. 4 endpoints, bulk import supported. See [tutor-profiles](../features/tutor-profiles.md).

---

## Experimental surfaces

### AI Scheduler — `experimental`

Parses a pasted parent chat into strict JSON with an LLM, then proves availability deterministically by calling `executeSearch` — the model never decides who is free, it only reads intent and drafts the reply. The whole path is gated on an OpenAI key plus `ENABLE_AI_SCHEDULER`, and returns a skipped result rather than failing when either is absent ([`src/lib/ai/scheduler.ts:478,540`](../../src/lib/ai/scheduler.ts)). Prompt and solver are versioned per run so accept/edit/reject metrics stay comparable across changes. 8 endpoints, 4 tables, plus a read-only metrics page. See [ai-scheduler](../features/ai-scheduler.md).

### Proposals (Admin Holds) — `experimental`

Lets staff place tentative "holds" on tutor slots while a parent conversation is still open. Holds are local only and never written to Wise; they block matching slots inside search results via `proposalHoldBlocksSearchSlot`, and stale ones expire or auto-resolve on a reconcile pass ([`src/lib/proposals/overlap.ts:84`](../../src/lib/proposals/overlap.ts), [`src/lib/proposals/data.ts:171,190,253`](../../src/lib/proposals/data.ts)). 3 endpoints, 2 tables, surfaced inside `/search` rather than on a page of its own. See [proposals](../features/proposals.md).

---

## Student lifecycle

### Leave Requests — `stable`

Pulls tutor leave-form submissions from a Google Sheet, matches each to a Wise identity, computes which sessions the leave affects, and gives admins a review worklist plus status writeback to the source sheet. Its only Wise-facing capability is a **preview** — the affected-session count is computed and selectable for review, but cancellation is never executed against Wise from here ([`src/lib/leave-requests/data.ts:490`](../../src/lib/leave-requests/data.ts)). 5 endpoints, 5 tables, cron at `15,45 * * * *`. See [leave-requests](../features/leave-requests.md).

### Student Schedule — `stable`

Builds a student's monthly calendar from credit-control session data, exports it to A4/PDF, and delivers it to a parent over LINE as a link to the public `/schedule/{token}` page — no account, no login. The token is 32 random bytes and only its SHA-256 hash is stored, so a database read cannot reconstruct a live link; each token is scoped to one student-month and expires ([`src/lib/student-schedule/links.ts:5-13,38`](../../src/lib/student-schedule/links.ts)). This is the sole page in the app deliberately exempted from the auth gate, and the middleware allowlist entry keeps its trailing slash precisely so the authenticated admin page is not caught by it ([`src/middleware.ts:17-21`](../../src/middleware.ts)). 2 endpoints, 1 table. See [student-schedule](../features/student-schedule.md).

### Post-Class Feedback — `stable`

The second-largest subsystem. It reconciles immutable Wise teacher-feedback evidence, derives tutor timeliness and authorship, and carries reviewed deductions into a dedicated payout-adjustment surface. Enforcement is prospective by construction: settings default to `shadow`, and activation is refused until a completed shadow sync has actually been reviewed ([`src/lib/post-class-feedback/settings.ts:180`](../../src/lib/post-class-feedback/settings.ts), [`dashboard.ts:786`](../../src/lib/post-class-feedback/dashboard.ts)). Two independent kill switches sit on the money path — `POST_CLASS_PAYOUT_WRITES_ENABLED` for any payout write and `POST_CLASS_AUTO_APPROVE_ENABLED` for the unattended approval sweep ([`payout-config.ts:50,165`](../../src/lib/post-class-feedback/payout-config.ts)). It never writes to Wise and never writes Payroll's tables. 13 endpoints, 32 tables, hourly accrual cron at `33 * * * *`. See [post-class-feedback](../features/post-class-feedback.md).

### Learning Plans — `stable`

A Years 1–13 syllabus plan builder with a dedicated A4 print/PDF report. Plan content is deliberately never persisted — the builder is stateless — while *access* is database-backed, resolved by a fresh read of the grants table on every server render rather than from a cached session claim ([`src/lib/learning-plans/access.ts:35-37`](../../src/lib/learning-plans/access.ts)). 1 table. See [learning-plans](../features/learning-plans.md).

### Student Promotions — `stable`

The audited annual July 1 workflow that advances Wise student grades and courses and dispositions Year 13 graduations ([`src/lib/student-promotions/rules.ts:145`](../../src/lib/student-promotions/rules.ts)). It gates apply behind a dry-run review, an explicit pay-rate verification step per affected tutor, and a refusal to run before July 1; unresolved graduation decisions block completion ([`src/lib/student-promotions/data.ts:838-845`](../../src/lib/student-promotions/data.ts)). Its cron `5 17 30 6 *` is the only annual entry in `vercel.json`. 9 endpoints, 6 tables. See [student-promotions](../features/student-promotions.md).

### University Admissions — `stable (parity-hardening code unmerged on origin/codex/admissions-parity-hardening; schema landed)`

The largest surface in the app: counselor case management covering cases, versioned checklists, college lists with decision chains, essays, activities, testing, meetings, and notes, plus a mobile-first student portal and a view-only parent dashboard. It is the only route family that is not admin-only — role is re-resolved from Postgres per case under `parent < student < counselor < admin`, and an unknown role, revoked membership, inactive counselor row, or soft-deleted case all deny ([`src/lib/admissions/access.ts:4-5,30-59`](../../src/lib/admissions/access.ts)). Note the caveat in the badge: schema for a later parity expansion has landed on `main` while the corresponding code still sits unmerged on `origin/codex/admissions-parity-hardening`. 61 endpoints, 36 tables, notification cron at `12 1 * * *`. See [university-admissions](../features/university-admissions.md).

### Progress Tests — `stable`

Tracks the every-eight-attended-classes progress-test cadence per student-subject pair through an `accumulating → approaching → due → scheduled → completed` lifecycle, with the threshold at 8 and the "approaching" warning firing at 6 ([`src/lib/progress-tests/config.ts:11,14`](../../src/lib/progress-tests/config.ts)). It drives two outbound nudges: a teacher heads-up at class 6 and a daily admin digest. Fail-closed on unresolvable teachers; its one Wise write capability is off by default. 6 endpoints, 8 tables, crons at `25,55 * * * *` and `35 0 * * *`. See [progress-tests](../features/progress-tests.md).

---

## Market intelligence & reference

### Competitor Intelligence — `stable`

Pulls competitor website, social, and SERP evidence through third-party providers, normalizes each signal into a scored evidence item, and regenerates a daily brief plus a weekly War Room snapshot. Spend is capped before any provider call, with a global monthly USD ceiling and optional per-provider overrides ([`src/lib/competitor-intelligence/budget.ts:19-32`](../../src/lib/competitor-intelligence/budget.ts)). AI read-outs fall back to a deterministic summary when the model is unavailable ([`ai.ts:82-83`](../../src/lib/competitor-intelligence/ai.ts)), and suggestions are never auto-executed — a human promotes one into a tracked task. 9 endpoints, 16 tables, weekly cron `28 18 * * 0`. See [competitor-intelligence](../features/competitor-intelligence.md).

### US Universities (IPEDS) — `stable`

A read-only research console over a curated IPEDS slice: filterable institution search, per-institution dossiers, compare sets, five-year admissions trends, and CSV export. All reads hit Postgres — the source IPEDS files are never touched at runtime. It feeds the Admissions college list through an "Add to case" control, and that link is a deliberate soft reference to `ipeds_institutions.unitId` rather than a foreign key, so an IPEDS re-import can never cascade into a student's case. 5 endpoints, 3 tables, 2 pages. See [us-universities](../features/us-universities.md).

---

## System scale

| Dimension | Count |
|---|---:|
| Database tables | **203** |
| HTTP endpoints (method + path) | **255** |
| Pages (`page.tsx`) | **33** |
| Route files (`route.ts`) | 191 |
| Scheduled crons (`vercel.json`) | 19 |
| Registered jobs (Data Health registry) | 24 |
| Feature areas | 27 |

Tables are counted as `pgTable(...)` declarations in `src/lib/db/schema.ts`. Endpoints are 253 named `export async function GET|POST|PUT|PATCH|DELETE` handlers plus 2 from the Auth.js catch-all, which exports its methods by destructuring (`export const { GET, POST } = handlers` in [`src/app/api/auth/[...nextauth]/route.ts:3`](../../src/app/api/auth/\[...nextauth\]/route.ts)) and so matches no `function` grep; the 2 CORS preflight `OPTIONS` handlers on the public OA-resolver routes are excluded as they carry no business surface. Pages are all 33 `page.tsx` files — 28 in the `(app)` group, 3 print surfaces, `/login`, and the public `/schedule/[token]` parent page.

Mechanical detail lives in the reference section, not here: [database](../reference/database/index.md) for tables and columns, [api](../reference/api/index.md) for endpoint signatures, [crons](../reference/crons.md) for the full schedule, and [env](../reference/env.md) for environment variables. For how the pieces fit together, see [architecture](architecture.md) and [data flow](data-flow.md).

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
