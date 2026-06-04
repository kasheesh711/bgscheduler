# BGScheduler Documentation Handbook

This is the entry point to the BGScheduler handbook. BGScheduler is a tutor-availability
search and scheduling tool for non-technical admin staff, built on a single architectural
bet: the source of truth (the Wise scheduling platform) is slow and rate-limited, so it is
never queried on the request path. A scheduled sync pulls Wise into versioned Postgres
snapshots; a process-global in-memory index serves all reads from RAM. If you read nothing
else first, read [`handbook/not-the-nextjs-you-know.md`](./handbook/not-the-nextjs-you-know.md) —
it lists the assumptions this codebase will break.

The docs are organized into five trees, each with a distinct job:

- **`handbook/`** — the cross-cutting mental model: architecture, data flow, conventions, vocabulary.
- **`features/`** — one document per product feature; owns *meaning* (purpose, rules, flows, why).
- **`reference/`** — mechanical lookup tables: every API endpoint, every database table, crons, env vars.
- **`operations/`** — runbook, auth/access model, observability.
- **`OPEN-QUESTIONS.md`** — the running list of unresolved questions and doc/code gaps.

---

## Reading order

New to the codebase? Read in this order. The first two pages give you the model; the rest
you can read on demand.

1. **[`handbook/not-the-nextjs-you-know.md`](./handbook/not-the-nextjs-you-know.md)** — first-read
   gotchas. Reads never call Wise; reads are pinned to one snapshot; sync must run before serve;
   fail-closed is the default; Next.js 16 cache/runtime conventions. Start here.
2. **[`handbook/overview.md`](./handbook/overview.md)** — the system overview: what BGScheduler is,
   the snapshot-and-index bet, and a one-paragraph tour of all fifteen features. The intended
   second stop in the reading order.
3. **[`handbook/glossary.md`](./handbook/glossary.md)** — the domain vocabulary (snapshot, identity
   group, modality, fail-closed, …), one line each, cited to the code that defines it.
4. **[`handbook/conventions.md`](./handbook/conventions.md)** — the load-bearing naming, error-handling,
   and module conventions you need before editing code.
5. **The feature you're touching** — jump into the matching [`features/*`](#features) page for the
   *why*, then follow its links into [`reference/`](#reference) for the *how*.

---

## Canonical home: who owns what

Every fact in this handbook has exactly one canonical home. When two pages mention the same
thing, the canonical-home rule decides which one is authoritative — and feature docs **link**
to reference detail rather than restating it.

| Concern | Canonical home | Owns | Does **not** own |
|---|---|---|---|
| What a feature is *for*, its rules, flows, and *why* | `features/*` | Purpose, business rules, fail-closed behavior, user flows, edge cases | Column lists, full endpoint request/response signatures |
| Exact HTTP endpoint signatures | `reference/api/*` | Method + path + auth + params + request/response shapes | Why the endpoint exists, how it fits a flow |
| Exact table columns, types, indexes, FKs, enums | `reference/database/*` | Column-level schema, grain, ER diagrams, enum values | The business meaning a table serves |
| Schedules, timeouts, cron auth | [`reference/crons.md`](./reference/crons.md) | When each job fires and what it hits | What the synced data means downstream |
| Environment variables | [`reference/env.md`](./reference/env.md) | Declared/validated vars and their effects | Feature behavior that consumes them |
| Cross-cutting model (pipeline, snapshots, index) | `handbook/*` | Shape and *why* of the whole system | Per-feature specifics |

In short: **`features/*` owns meaning; `reference/*` owns mechanical detail.** A feature doc that
needs a column list or a full endpoint signature links to the reference page instead of copying it.

---

## Maturity legend

Each feature doc declares a maturity badge on its second line. There is no separate authoritative
badge map; the badge shown here is the one the doc itself carries, verified against the code it
describes. Four base levels are used:

| Badge | Meaning |
|---|---|
| **stable** | Built, tested, and live in production. Safe to depend on. |
| **experimental** | Live but actively iterated; shapes and behavior may still change. |
| **legacy** | Superseded path kept for compatibility. Two pages carry a precise variant: **legacy-redirect** ([Tutor Compare](./features/tutor-compare.md) — the `/compare` route redirects to `/search`; the compare *engine* and API are fully active). |
| **in-progress** | Not finished. **Leave Requests** is labeled **in progress (uncommitted)** — present in the working tree but not committed. **Room Capacity** is labeled **partial** — backend wired and tested, parts have no frontend consumer yet. |

---

## Table of contents

### Handbook

The cross-cutting mental model. Read these to understand the system as a whole.

| Doc | What it covers |
|---|---|
| [not-the-nextjs-you-know.md](./handbook/not-the-nextjs-you-know.md) | First-read gotchas — the five assumptions this codebase breaks. |
| [overview.md](./handbook/overview.md) | System overview — what BGScheduler is, the snapshot-and-index bet, and a one-paragraph tour of all fifteen features. |
| [architecture.md](./handbook/architecture.md) | Layered pipeline, snapshot-versioned data model, in-memory `SearchIndex`, fail-closed rule, request lifecycle. |
| [data-flow.md](./handbook/data-flow.md) | The Wise → Postgres → in-memory ETL (the snapshot sync), end to end. |
| [conventions.md](./handbook/conventions.md) | Handbook-level naming, imports, error handling, and module patterns. |
| [glossary.md](./handbook/glossary.md) | Domain vocabulary, one line each, cited to source. |

### Features

One page per product feature. Owns purpose, rules, flows, and the *why*. Badge = the doc's own
declared maturity.

| Feature | Status | Summary |
|---|---|---|
| [Tutor Search](./features/tutor-search.md) | live primary entry point | Which tutors are free and qualified for a class at a given time, with a "Needs Review" bucket for unresolved data. |
| [Tutor Compare](./features/tutor-compare.md) | legacy-redirect | 1–3 tutors side by side for a week: schedules, conflicts, shared free slots. Engine + API active; `/compare` redirects to `/search`. |
| [Tutor Profiles](./features/tutor-profiles.md) | stable | Editorial business context Wise does not store (parent-safe summary, fit, strengths, internal guidance). |
| [Classroom Assignments](./features/classroom-assignments.md) | stable | Turns a day's Wise sessions into a physical-room plan; optional writeback of OFFLINE rooms to Wise. |
| [Room Capacity](./features/room-capacity.md) | partial | Room utilization (live) and demand forecast (backend complete, no frontend consumer yet). |
| [Sales Dashboard](./features/sales-dashboard.md) | stable | Imports monthly sales from Google Sheets; GM-facing revenue-pace + pipeline + scenario command center. |
| [Credit Control](./features/credit-control.md) | stable | Projects when each student's prepaid credit runs low/out; prioritized follow-up queue with outreach logging. |
| [Payroll](./features/payroll.md) | stable | Reconciles tutor pay against Wise sessions/invoices per month; surfaces integrity issues; review + approve. |
| [Wise Activity Audit](./features/wise-activity-audit.md) | stable | Read-only audit log of Wise operational/financial events + package-sales reconciliation workbench. |
| [Student Promotions](./features/student-promotions.md) | stable, pending first production run | Audited July 1, 2026 Wise student grade/course promotion workflow with dry-run review and verified apply. |
| [LINE Integration](./features/line-integration.md) | stable (writeback dry-run) | LINE OA inbox: ingest, classify, draft replies, human-gated review. Scheduler write-path flag-gated/dry-run. |
| [Proposals (Admin Holds)](./features/proposals.md) | experimental | Temporary admin "holds" on tutor slots, with same-tutor overlap detection. Local-only, never written to Wise. |
| [AI Scheduler](./features/ai-scheduler.md) | experimental | LLM reads pasted chat, extracts a request, runs the deterministic search, drafts a parent reply. Never decides availability. |
| [Data Health](./features/data-health.md) | stable | Ops command center for cron firing, data freshness, Wise snapshot fidelity, and unresolved normalization issues. |
| [Leave Requests](./features/leave-requests.md) | in progress (uncommitted) | Tutor leave-request workflow. Present in the working tree but uncommitted; treat shapes as provisional. |

### Reference

Mechanical lookup. Owns exact signatures, columns, schedules, and variables.

#### API — [`reference/api/`](./reference/api/index.md)

| Doc | Covers |
|---|---|
| [index.md](./reference/api/index.md) | Master index of every HTTP endpoint (method + path + group + auth + one-line purpose). |
| [ai-scheduler.md](./reference/api/ai-scheduler.md) | `/api/ai-scheduler/*` — conversations, messages, feedback, metrics. |
| [classrooms-and-assignments.md](./reference/api/classrooms-and-assignments.md) | `/api/class-assignments/*` and `/api/classrooms/*`. |
| [credit-control.md](./reference/api/credit-control.md) | `/api/credit-control/*`. |
| [line.md](./reference/api/line.md) | `/api/line/*` — webhook, contacts, review tooling. |
| [payroll.md](./reference/api/payroll.md) | `/api/payroll/*`. |
| [proposals.md](./reference/api/proposals.md) | `/api/proposals/*`. |
| [room-capacity.md](./reference/api/room-capacity.md) | `/api/room-capacity/*`. |
| [sales-dashboard.md](./reference/api/sales-dashboard.md) | `/api/sales-dashboard/*`. |
| [student-promotions.md](./reference/api/student-promotions.md) | `/api/student-promotions/*` and the July 1 internal cron route. |
| [wise-activity.md](./reference/api/wise-activity.md) | `/api/wise-activity/*`. |
| [internal-crons.md](./reference/api/internal-crons.md) | `/api/internal/*` — cron-triggered sync endpoints. |
| [misc.md](./reference/api/misc.md) | Search, Tutors, Filters, Compare, Data Health, Auth & Admin. |

#### Database — [`reference/database/`](./reference/database/index.md)

| Doc | Covers |
|---|---|
| [index.md](./reference/database/index.md) | Master table index: every table, its grain, owning feature, and ERD link. |
| [enums.md](./reference/database/enums.md) | Every Postgres enum and its values. |
| [erd-core.md](./reference/database/erd-core.md) | Snapshots, sync, audit, auth, tutors, normalization. |
| [erd-sales-dashboard.md](./reference/database/erd-sales-dashboard.md) | Sales Dashboard tables. |
| [erd-credit-control.md](./reference/database/erd-credit-control.md) | Credit Control tables. |
| [erd-classrooms.md](./reference/database/erd-classrooms.md) | Classroom assignment + email tables. |
| [erd-payroll.md](./reference/database/erd-payroll.md) | Payroll tables. |
| [erd-tutor-profiles.md](./reference/database/erd-tutor-profiles.md) | Tutor Profiles tables. |
| [erd-leave-requests.md](./reference/database/erd-leave-requests.md) | Leave Requests tables (uncommitted feature). |
| [erd-ai-and-proposals.md](./reference/database/erd-ai-and-proposals.md) | AI Scheduler + Proposals tables. |
| [erd-line.md](./reference/database/erd-line.md) | LINE tables. |
| [erd-room-capacity.md](./reference/database/erd-room-capacity.md) | Room Capacity tables. |
| [erd-student-promotions.md](./reference/database/erd-student-promotions.md) | Student Promotions audit tables. |

#### Other reference

| Doc | Covers |
|---|---|
| [crons.md](./reference/crons.md) | Every Vercel Cron entry: schedule, endpoint, auth, timeout, behavior. |
| [env.md](./reference/env.md) | Every environment variable BGScheduler reads, reconciled against the env schema. |

### Operations

How to run, secure, and observe the system.

| Doc | Covers |
|---|---|
| [runbook.md](./operations/runbook.md) | Deploys, DB scripts, manual sync triggers, and sync-failure recovery. |
| [auth-and-access.md](./operations/auth-and-access.md) | The two access gates: edge-middleware session check + login-time allowlist. |
| [observability.md](./operations/observability.md) | What's logged, how to inspect sync/runtime state, and where signals live. |

### Open questions & gaps

| Doc | Covers |
|---|---|
| [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) | The running list of unresolved questions and doc/code gaps. Individual feature/operations pages also carry their own inline "Open questions" sections (e.g. [Room Capacity](./features/room-capacity.md), [Data Health](./features/data-health.md), [Observability](./operations/observability.md)). |

---

## A note on the eval reports

The existing top-level eval and audit reports — `docs/ai-scheduler-audit-*.md`,
`docs/ai-scheduler-replay-eval-*.md`, `docs/ai-scheduler-eval-latest.md`,
`docs/ai-scheduler-model-comparison.md`, and `docs/ai-scheduler-eval-cases.json` — are a
**separate body of work** from this handbook. They are point-in-time AI-scheduler evaluation
artifacts, not part of the handbook structure, and are **left untouched**. For the AI Scheduler
feature itself, see [`features/ai-scheduler.md`](./features/ai-scheduler.md).

The `docs/superpowers/` directory (older specs and plans) is likewise outside this handbook.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
