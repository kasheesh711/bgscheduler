# BGScheduler Documentation Handbook

This is the entry point to the BGScheduler handbook. BGScheduler (now branded internally as
"BeGifted Ops", still served at `bgscheduler.vercel.app`) is the admin console BeGifted
Education's non-technical staff use to run their tutoring operation on top of the
[Wise](https://api.wiseapp.live) scheduling platform. It is built on a single architectural
bet: the source of truth (Wise) is slow and rate-limited, so it is **never** queried on the
request path. A scheduled sync pulls Wise into versioned Postgres snapshots; a process-global
in-memory index serves all reads from RAM. If you read nothing else first, read
[`handbook/not-the-nextjs-you-know.md`](./handbook/not-the-nextjs-you-know.md) — it lists the
assumptions this codebase will break.

The docs are organized into five trees, each with a distinct job:

- **`handbook/`** — the cross-cutting mental model: architecture, the ETL data flow, conventions, vocabulary.
- **`features/`** — one document per product feature; owns *meaning* (purpose, rules, flows, why).
- **`reference/`** — mechanical lookup tables: every API endpoint, every database table, crons, env vars.
- **`operations/`** — runbook, auth/access model, observability, and dated release checkpoints.
- **`OPEN-QUESTIONS.md`** — the running list of unresolved questions and doc/code gaps.

---

## Reading order

New to the codebase? Read in this order. The first two pages give you the model; the rest you
can read on demand.

1. **[`handbook/not-the-nextjs-you-know.md`](./handbook/not-the-nextjs-you-know.md)** — first-read
   gotchas. Reads never call Wise; reads are pinned to one snapshot; sync must run before serve;
   fail-closed is the default; this is Next.js 16 with its own cache/runtime conventions. **Start here.**
2. **[`handbook/overview.md`](./handbook/overview.md)** — the system overview: what the app is, the
   snapshot-and-index bet, and a one-paragraph tour of every feature. The intended second stop.
3. **[`handbook/architecture.md`](./handbook/architecture.md)** — the layered pipeline, the
   snapshot-versioned data model, the in-memory `SearchIndex`, the fail-closed rule, and the
   request lifecycle.
4. **[`handbook/data-flow.md`](./handbook/data-flow.md)** — the Wise → Postgres → in-memory ETL
   (the snapshot sync) traced end to end. Read this when you need to understand *how the data
   gets there* before touching sync or normalization.
5. **[`handbook/glossary.md`](./handbook/glossary.md)** — the domain vocabulary (snapshot, identity
   group, modality, fail-closed, …), one line each, cited to the code that defines it.
6. **[`handbook/conventions.md`](./handbook/conventions.md)** — the load-bearing naming,
   error-handling, and module conventions you need before editing code.
7. **The feature you're touching** — jump into the matching [`features/*`](#features) page for the
   *why*, then follow its links into [`reference/`](#reference) for the *how*.

---

## Canonical home: who owns what

Every fact in this handbook has exactly one canonical home. When two pages mention the same thing,
the canonical-home rule decides which one is authoritative — and feature docs **link** to
reference detail rather than restating it.

| Concern | Canonical home | Owns | Does **not** own |
|---|---|---|---|
| What a feature is *for*, its rules, flows, and *why* | `features/*` | Purpose, business rules, fail-closed behavior, user flows, edge cases | Column lists, full endpoint request/response signatures |
| Exact HTTP endpoint signatures | `reference/api/*` | Method + path + auth + params + request/response shapes | Why the endpoint exists, how it fits a flow |
| Exact table columns, types, indexes, FKs, enums | `reference/database/*` | Column-level schema, grain, ER diagrams, enum values | The business meaning a table serves |
| Schedules, timeouts, cron auth | [`reference/crons.md`](./reference/crons.md) | When each job fires and what it hits | What the synced data means downstream |
| Environment variables | [`reference/env.md`](./reference/env.md) | Declared/validated vars and their effects | Feature behavior that consumes them |
| The Wise external contract | [`reference/wise-api.md`](./reference/wise-api.md) | The shape of the Wise API the client calls | How normalized Wise data is used per feature |
| Cross-cutting model (pipeline, snapshots, index) | `handbook/*` | Shape and *why* of the whole system | Per-feature specifics |

In short: **`features/*` owns meaning; `reference/*` owns mechanical detail.** A feature doc that
needs a column list or a full endpoint signature links to the reference page instead of copying it.

---

## Maturity legend

Each feature doc declares a maturity badge on its second line. There is no separate authoritative
badge map and no `@deprecated` marker in the code; the badge shown here is the one the doc itself
carries, verified against the code it describes. Four base levels are used, plus two precise
variants:

| Badge | Meaning |
|---|---|
| **stable** | Built, tested, and live in production. Safe to depend on. |
| **experimental** | Live but actively iterated; shapes and behavior may still change. |
| **legacy** | Superseded path kept for compatibility. One page carries the precise variant **legacy-redirect** ([Tutor Compare](./features/tutor-compare.md) — the `/compare` route redirects to `/search`; the compare *engine*, API, and embedded UI are fully active). |
| **in-progress** | Not finished. [Leave Requests](./features/leave-requests.md) is labeled **in progress** — now fully committed and tracked (the earlier "uncommitted" framing is no longer accurate), but the Wise-cancellation path is preview-only and the parser heuristics are young. |
| **partial** | A documented variant of *in-progress*: [Room Capacity](./features/room-capacity.md) — the utilization path is shipped, but the month-view and forecast engines are complete and tested with **no frontend consumer**. |
| **stable, pending first production run** | [Student Promotions](./features/student-promotions.md) — built, tested, and verified against live Wise via dry run, but the apply path waits on the July 1, 2026 cron (or manual fallback) for its first real execution. |

---

## Table of contents

### Handbook

The cross-cutting mental model. Read these to understand the system as a whole.

| Doc | What it covers |
|---|---|
| [not-the-nextjs-you-know.md](./handbook/not-the-nextjs-you-know.md) | First-read gotchas — the assumptions this codebase breaks (no Wise on the request path, snapshot-pinned reads, sync-before-serve, fail-closed, Next.js 16 cache/runtime). |
| [overview.md](./handbook/overview.md) | System overview — what the app is, the snapshot-and-index bet, and a one-paragraph tour of every feature. |
| [architecture.md](./handbook/architecture.md) | Layered pipeline, snapshot-versioned data model, in-memory `SearchIndex`, fail-closed rule, request lifecycle. |
| [data-flow.md](./handbook/data-flow.md) | The Wise → Postgres → in-memory ETL (the snapshot sync), end to end. |
| [conventions.md](./handbook/conventions.md) | Handbook-level naming, imports, error handling, and module patterns. |
| [glossary.md](./handbook/glossary.md) | Domain vocabulary, one line each, cited to source. |

### Features

One page per product feature. Owns purpose, rules, flows, and the *why*. The **Status** column is
each doc's own declared maturity badge (see the [legend](#maturity-legend)).

| Feature | Status | Summary |
|---|---|---|
| [Tutor Search](./features/tutor-search.md) | stable (live primary entry point) | Which tutors are free and qualified for a class at a given time, with a fail-closed "Needs Review" bucket for unresolved data. |
| [Tutor Compare](./features/tutor-compare.md) | legacy-redirect | 1–3 tutors side by side for a week: schedules, conflicts, shared free slots. Engine + API + UI active; `/compare` redirects to `/search`. |
| [Tutor Profiles](./features/tutor-profiles.md) | stable | Editorial business context Wise does not store (parent-safe summary, fit, strengths, internal guidance), keyed to a stable `canonicalKey`. |
| [Classroom Assignments](./features/classroom-assignments.md) | stable | Turns a day's Wise sessions into a physical-room plan; optional opt-in writeback of OFFLINE rooms to Wise; nightly automation. |
| [Room Capacity](./features/room-capacity.md) | partial | Room utilization (live) and demand forecast (backend complete and tested, no frontend consumer yet). |
| [Sales Dashboard](./features/sales-dashboard.md) | stable | Imports monthly sales from Google Sheets; GM-facing revenue-pace + pipeline + Bear/Base/Bull scenario command center. |
| [Credit Control](./features/credit-control.md) | stable | Projects when each student's prepaid credit runs low/out; prioritized per-admin follow-up queue with outreach logging. |
| [Payroll](./features/payroll.md) | stable | Reconciles tutor pay against Wise sessions/invoices per Bangkok month; surfaces integrity issues; review + adjust + approve. |
| [Wise Activity Audit](./features/wise-activity-audit.md) | stable | Read-only audit log of Wise operational/financial events + package-sales reconciliation workbench. |
| [Student Promotions](./features/student-promotions.md) | stable, pending first production run | Audited July 1, 2026 Wise grade/course promotion workflow with live-Wise dry run, verified apply, and per-action revalidation. |
| [LINE Integration](./features/line-integration.md) | stable (writeback dry-run) | LINE OA inbox: ingest, classify, draft replies, human-gated review. Scheduler write-path flag-gated and dry-run only. |
| [Proposals (Admin Holds)](./features/proposals.md) | experimental | Temporary admin "holds" on tutor slots, with same-tutor overlap detection. Local-only, never written to Wise. |
| [AI Scheduler](./features/ai-scheduler.md) | experimental | LLM reads pasted chat, extracts a request, runs the deterministic search, drafts a parent reply. Never decides availability itself. |
| [Data Health](./features/data-health.md) | stable | Ops command center for cron firing, data freshness, Wise snapshot fidelity, and unresolved normalization issues. |
| [Leave Requests](./features/leave-requests.md) | in progress | Tutor leave-request triage from a Google Form → Sheet → Postgres; Wise-cancel path is preview-only. Now committed; treat shapes as stabilizing. |
| [Progress Tests](./features/progress-tests.md) | stable | Every-8-attended-classes progress-test tracker — attendance ledger + cycle state, booking/at-home flows, parent LINE outreach + email, teacher heads-up, scoped read-only teacher view, and a daily admin digest. |
| [Ops Hub](./features/ops-hub.md) | stable | Operations landing at `/` — an access-filtered command center aggregating per-queue action counts (leave requests, LINE reviews, progress tests, credit control, payroll, Wise reconciliation, data health) plus a data-freshness strip; backed by `GET /api/home/summary` and the `NAV_TOOLS` registry. |

> **17 features, 17 feature docs.** Every feature linked above has a dedicated page under
> `features/`, including Progress Tests (the `/progress-tests` page, six public API routes plus
> two internal cron routes, and the `progress_test_*` tables) and the Ops Hub landing at `/`.

### Reference

Mechanical lookup. Owns exact signatures, columns, schedules, and variables. The two index pages
are the canonical inventories: **130 endpoints across 111 route files** (per the
[API index](./reference/api/index.md)) and **90 tables** (per the
[database index](./reference/database/index.md)).

#### API — [`reference/api/`](./reference/api/index.md)

The [API index](./reference/api/index.md) lists every endpoint (method + path + group + auth +
one-line purpose); the detail pages below carry the request/response shapes. The detail files are
**consolidated** — several API-index group headings (Search, Compare, Tutors, Filters, Data Health,
Auth, Admin) map onto `misc.md` rather than a file-per-group.

| Doc | Covers |
|---|---|
| [index.md](./reference/api/index.md) | Master index of every HTTP endpoint (method + path + group + auth + one-line purpose), plus the auth-tier model. |
| [ai-scheduler.md](./reference/api/ai-scheduler.md) | `/api/ai-scheduler/*` — conversations, messages, feedback, metrics. |
| [classrooms-and-assignments.md](./reference/api/classrooms-and-assignments.md) | `/api/class-assignments/*` and `/api/classrooms/*`. |
| [credit-control.md](./reference/api/credit-control.md) | `/api/credit-control/*`. |
| [line.md](./reference/api/line.md) | `/api/line/*` — webhook, contacts, review tooling, OA-resolver. |
| [payroll.md](./reference/api/payroll.md) | `/api/payroll/*`. |
| [proposals.md](./reference/api/proposals.md) | `/api/proposals/*`. |
| [room-capacity.md](./reference/api/room-capacity.md) | `/api/room-capacity/*`. |
| [sales-dashboard.md](./reference/api/sales-dashboard.md) | `/api/sales-dashboard/*`. |
| [student-promotions.md](./reference/api/student-promotions.md) | `/api/student-promotions/*` and the July 1 internal cron route. |
| [wise-activity.md](./reference/api/wise-activity.md) | `/api/wise-activity/*`. |
| [internal-crons.md](./reference/api/internal-crons.md) | `/api/internal/*` — cron-triggered sync and automation endpoints. |
| [misc.md](./reference/api/misc.md) | Search, Compare, Tutors, Filters, Data Health, Auth, and Admin endpoints. |

#### Database — [`reference/database/`](./reference/database/index.md)

The [database index](./reference/database/index.md) lists every table (SQL name, Drizzle export,
grain, owning feature, ERD link); the `erd-*` pages carry the per-domain column/type/index detail.

| Doc | Covers |
|---|---|
| [index.md](./reference/database/index.md) | Master table index: every table, its grain, owning feature, and ERD link. |
| [enums.md](./reference/database/enums.md) | Every Postgres enum and its values. |
| [erd-core.md](./reference/database/erd-core.md) | Snapshots, sync, audit, auth, tutors, normalization, Wise-activity, and Progress Tests. |
| [erd-student-promotions.md](./reference/database/erd-student-promotions.md) | Student Promotions audit tables (Core domain, separate diagram). |
| [erd-sales-dashboard.md](./reference/database/erd-sales-dashboard.md) | Sales Dashboard tables. |
| [erd-credit-control.md](./reference/database/erd-credit-control.md) | Credit Control tables. |
| [erd-classrooms.md](./reference/database/erd-classrooms.md) | Classroom assignment + email tables. |
| [erd-payroll.md](./reference/database/erd-payroll.md) | Payroll tables. |
| [erd-tutor-profiles.md](./reference/database/erd-tutor-profiles.md) | Tutor Profiles tables. |
| [erd-leave-requests.md](./reference/database/erd-leave-requests.md) | Leave Requests tables. |
| [erd-ai-and-proposals.md](./reference/database/erd-ai-and-proposals.md) | AI Scheduler + Proposals tables. |
| [erd-line.md](./reference/database/erd-line.md) | LINE tables. |
| [erd-room-capacity.md](./reference/database/erd-room-capacity.md) | Room Capacity tables. |

#### Other reference

| Doc | Covers |
|---|---|
| [crons.md](./reference/crons.md) | Every Vercel Cron entry: schedule, endpoint, auth, timeout, behavior. |
| [env.md](./reference/env.md) | Every environment variable BGScheduler reads, reconciled against the env schema. |
| [wise-api.md](./reference/wise-api.md) | The external Wise API contract the client calls (auth, fetchers, payload shapes). |
| [production-route-surface.json](./reference/production-route-surface.json) | Machine-readable snapshot of the deployed route surface (referenced by release checkpoints). |

### Operations

How to run, secure, and observe the system.

| Doc | Covers |
|---|---|
| [runbook.md](./operations/runbook.md) | Deploys, DB scripts, manual sync triggers, and sync-failure recovery. |
| [auth-and-access.md](./operations/auth-and-access.md) | The access gates: edge-middleware session check + login-time allowlist + per-page restrictions. |
| [observability.md](./operations/observability.md) | What's logged, how to inspect sync/runtime state, and where signals live. |
| [release-checkpoints/2026-06-04-reconcile-live-production.md](./operations/release-checkpoints/2026-06-04-reconcile-live-production.md) | The known-good production state captured before the 2026-06-04 reconciliation merge (deployment IDs, migration state, rollback gate). |

### Open questions & gaps

| Doc | Covers |
|---|---|
| [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) | The running list of unresolved questions and doc/code gaps. Individual feature/operations pages also carry their own inline "Open questions" sections (e.g. [Room Capacity](./features/room-capacity.md), [Data Health](./features/data-health.md), [Leave Requests](./features/leave-requests.md), [Observability](./operations/observability.md)). |

---

## A note on the eval reports

The top-level AI-scheduler eval and audit reports — `docs/ai-scheduler-audit-*.md`,
`docs/ai-scheduler-replay-eval-*.md`, `docs/ai-scheduler-eval-latest.md`,
`docs/ai-scheduler-model-comparison.md`, and `docs/ai-scheduler-eval-cases.json` — are a
**separate body of work** from this handbook. They are point-in-time AI-scheduler evaluation
artifacts, not part of the handbook structure, and are **left untouched** by this documentation
pass. For the AI Scheduler feature itself, see [`features/ai-scheduler.md`](./features/ai-scheduler.md).

The `docs/superpowers/` directory (older specs and plans) is likewise outside this handbook.

_Verified against HEAD `d4fe6d3` on 2026-06-05._
