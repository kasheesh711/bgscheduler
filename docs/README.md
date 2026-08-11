# BGScheduler Documentation Handbook

This is the entry point to the BGScheduler handbook.

BGScheduler (production hostname `bgscheduler.vercel.app`) is BeGifted Education's internal admin
console, built on top of the external **Wise** scheduling platform. Wise is the single production
source of truth, and it is slow, paginated, and rate-limited — so the whole system is organized
around one bet: **Wise is never queried on the tutor read path.** Scheduled syncs pull Wise into
versioned Postgres snapshots, a fail-closed normalization pipeline decides correctness at *write*
time, and a `globalThis`-anchored in-memory index answers searches from RAM.

If you read nothing else first, read
[`handbook/not-the-nextjs-you-know.md`](./handbook/not-the-nextjs-you-know.md) — it lists the
assumptions this codebase will break.

The docs are organized into five trees, each with a distinct job:

- **[`handbook/`](#handbook)** — the cross-cutting mental model: architecture, data flow, conventions, vocabulary. **6 pages.**
- **[`features/`](#features)** — one page per product feature; owns *meaning* (purpose, rules, flows, why). **22 pages.**
- **[`reference/`](#reference)** — mechanical lookup: every endpoint, every table, every enum, crons, env vars, the Wise contract.
- **[`operations/`](#operations)** — runbook, auth/access model, observability, release checkpoints. **4 pages.**
- **[`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md)** — the running list of things only a human can settle.

**System scale at this revision.** 188 database tables (`grep -c "= pgTable(" src/lib/db/schema.ts`),
241 HTTP endpoints across 178 `src/app/api/**/route.ts` files, 25 pages under the `src/app/(app)/`
route group (plus `src/app/login/page.tsx`, the token-gated parent page
`src/app/schedule/[token]/page.tsx`, and two shell-free print reports under `src/app/(print)/`),
21 navigation tools in six sections (`src/lib/navigation/tools.ts`), 15 Vercel Cron entries
(`vercel.json`), 66 Drizzle migrations (latest `drizzle/0065_line_group_settings_skip_confirm.sql`), and 369
Vitest test files. The mechanical inventories behind those numbers live in
[`reference/api/index.md`](./reference/api/index.md) and
[`reference/database/index.md`](./reference/database/index.md).

---

## Reading order

New to the codebase? Read in this order. The first two pages give you the model; everything after
that is on-demand.

1. **[`handbook/not-the-nextjs-you-know.md`](./handbook/not-the-nextjs-you-know.md)** — **start here.**
   The five assumptions this repo violates: the tutor read path never hits Wise live, reads are
   pinned to exactly one snapshot, sync-before-serve (no snapshot, no answers), fail-closed is the
   default posture rather than a flag, and the Next.js 16 specifics (`cacheComponents`,
   `"use cache"`, `globalThis` singletons, per-route `maxDuration`).
2. **[`handbook/overview.md`](./handbook/overview.md)** — the system overview: what the app is for,
   the snapshot-and-index bet, and a paragraph-per-feature tour of the workspaces reachable from the
   tool navigation. The intended second stop.
3. **[`handbook/architecture.md`](./handbook/architecture.md)** — the layers top to bottom, the
   snapshot-versioned data model, the in-memory `SearchIndex` singleton, the fail-closed rule, and
   the request lifecycle.
4. **[`handbook/data-flow.md`](./handbook/data-flow.md)** — the Wise → Postgres → in-memory ETL
   stage by stage, including the promotion gate and the failure model.
5. **[`handbook/glossary.md`](./handbook/glossary.md)** — domain vocabulary (snapshot, identity
   group, modality, canonical key, fail-closed), one line each, cited to the code that enforces it.
6. **[`handbook/conventions.md`](./handbook/conventions.md)** — the load-bearing Zod-at-the-boundary,
   fail-closed-default, Asia/Bangkok, and lazy-singleton rules you need *before* editing code.
7. **The feature you're touching** — jump to its [`features/*`](#features) page for the *why* and the
   rules, then follow its links into [`reference/`](#reference) for the *how*.
8. **Before you deploy or debug production** — [`operations/runbook.md`](./operations/runbook.md).

Two navigation facts worth knowing before you go looking: `/` is a summary **hub** page
(`HomeHub`, `src/app/(app)/page.tsx:8-19`), not a redirect; and `/compare` is a client-side redirect
into `/search` that preserves `?tutors=` (`src/app/(app)/compare/page.tsx:10-18`).

---

## Canonical home: who owns what

Every fact in this handbook has exactly one canonical home. When two pages mention the same thing,
this table decides which one is authoritative.

**In one line: `features/*` owns meaning; `reference/*` owns mechanical detail.**

A feature page explains what a thing is *for*, the business rules it enforces, the flows a user
moves through, and why the design is what it is. It must **not** restate column lists or full
endpoint request/response signatures — it links to the reference page instead. A reference page
carries the exact mechanics and says nothing about *why*.

| Concern | Canonical home | Owns | Does **not** own |
|---|---|---|---|
| What a feature is *for*, its rules, flows, edge cases, and *why* | [`features/*`](#features) | Purpose, business rules, fail-closed behavior, user flows, state machines, per-feature open questions | Column lists, full endpoint request/response signatures |
| Exact HTTP endpoint surface | [`reference/api/*`](#api--referenceapi) | Method + path + auth tier + params + request/response shapes + error codes | Why an endpoint exists, how it fits a workflow |
| Exact tables, columns, grain, indexes, FKs | [`reference/database/*`](#database--referencedatabase) | Column-level schema, per-row grain, ER diagrams, `schema.ts` line ranges | The business meaning a table serves |
| Enum value sets | [`reference/database/enums.md`](./reference/database/enums.md) | Allowed values, declaration site, columns bound to each enum | What a state *means* in the workflow |
| Schedules, timeouts, cron auth | [`reference/crons.md`](./reference/crons.md) | When each job fires, what it hits, which guard protects it | What the synced data means downstream |
| Environment variables | [`reference/env.md`](./reference/env.md) | Declared-vs-actually-read variables, defaults, absence behavior | Feature behavior that consumes them |
| The external Wise contract | [`reference/wise-api.md`](./reference/wise-api.md) | Transport client, fetchers, writeback ops, `WISE_*` vars | How BGScheduler interprets what Wise returns |
| Cross-cutting model (pipeline, snapshots, index, conventions) | [`handbook/*`](#handbook) | Shape and *why* of the whole system | Per-feature specifics |
| How to run, deploy, secure, and observe it | [`operations/*`](#operations) | Procedures, gates, evidence trails | Job semantics and data rules (those live in features) |
| Questions no document can settle | [`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md) | Design intent, production state, ownership, dead-or-dormant calls | Anything derivable from code |

---

## Maturity legend

**No maturity map was supplied for this documentation pass — the map handed to this page was empty —
and there is no maturity marker in code**: no `@deprecated` annotations, no feature-status constant,
no per-feature flag registry. So no badge here is inferred from source. Each badge in the
[Features](#features) table is the one **that feature's own page declares on its status line**, and
several pages deliberately decline to assert a single word. See
[OPEN-QUESTIONS.md → Maturity, lifecycle & documentation governance](./OPEN-QUESTIONS.md) for the
confirmations still outstanding.

The four base levels this documentation set uses:

| Badge | Meaning |
|---|---|
| **stable** | Built, tested, and running in production. Safe to depend on. |
| **experimental** | Reachable and running, but actively iterated — shapes, prompts, and behavior may still change. |
| **legacy** | A superseded path kept for compatibility. |
| **in-progress** | Not finished, or finished but not switched on. |

At this revision the pages use those four words unevenly, so the non-standard status lines are
reconciled here rather than silently normalized:

| Feature page | Declares | Nearest base level | Why the wording differs |
|---|---|---|---|
| [Credit Control](./features/credit-control.md) | *live* | stable | The page states the mechanism instead of a grade: cron registered (`20,50 * * * *`), page → API → sync path wired, nine test suites. |
| [Data Health](./features/data-health.md) | *wired end to end at HEAD* | stable | Page, both API routes, and the `/api/internal/cron-watchdog` entry all exist; whether crons actually fire in production is a runtime fact the repo cannot attest. |
| [Leave Requests](./features/leave-requests.md) | *committed, cron-scheduled, nav-registered* | stable, with a caveat | Stated from code because no badge is derivable. Its only Wise-facing capability is a dry-run cancellation preview. |
| [Room Capacity](./features/room-capacity.md) | *no single badge fits* | split | Utilization is wired sync → API → dashboard; the month/forecast engines are implemented, tested, and authenticated but have no caller outside their own tests, and their sync is `manualOnly: true` with no `vercel.json` entry. |
| [Progress Tests](./features/progress-tests.md) | *no maturity label asserted* | — | The page refuses a badge for the same reason this legend does (empty map, no code marker) and lists the code-provable facts instead. |
| [University Admissions](./features/university-admissions.md) | *merged to `main`, nav-registered, cron-registered* | — | No badge asserted; mechanisms are code-verified, the label is not. Carries one caveat: a later schema expansion landed on `main` without its code. |
| [Tutor Compare](./features/tutor-compare.md) | *no badge asserted* | **legacy** (route only) | The one precise legacy variant in the tree: the standalone `/compare` page is a client-side redirect (`src/app/(app)/compare/page.tsx:10-18`) and is absent from the nav, while the compare engine, both API endpoints, and the calendar UI stay fully live inside `/search`. |
| [Learning Plans](./features/learning-plans.md) | *(no status line at all)* | — | The page opens directly on `## Purpose`. |

No feature page currently declares **in-progress**. The level is kept in the legend because
[OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) tracks candidates for it and earlier revisions used it.

---

## Table of contents

### Handbook

The cross-cutting mental model — read these to understand the system as a whole. Six pages.

| Doc | What it covers |
|---|---|
| [not-the-nextjs-you-know.md](./handbook/not-the-nextjs-you-know.md) | First-read gotchas: the five assumptions this codebase breaks. **Start here.** |
| [overview.md](./handbook/overview.md) | System overview — what the app is, the snapshot-and-index bet, a tour of every navigable workspace. |
| [architecture.md](./handbook/architecture.md) | The layers top to bottom, snapshot-versioned data model, in-memory `SearchIndex`, the fail-closed rule, request lifecycle. |
| [data-flow.md](./handbook/data-flow.md) | The Wise → Postgres → in-memory ETL stage by stage: triggers, transport, the PAST-01 diff hook, promotion, failure model. |
| [conventions.md](./handbook/conventions.md) | Zod at route boundaries, fail-closed defaults, Asia/Bangkok time, lazy singletons, and what CI actually enforces. |
| [glossary.md](./handbook/glossary.md) | Domain vocabulary, one line each, cited to the code that defines it. |

### Features

One page per product feature; owns purpose, rules, flows, and the *why*. **Twenty-two pages.** The
Status column reproduces each page's own declared status line — see the
[maturity legend](#maturity-legend) for why there is no external authority behind it.

| Feature | Status (as the page declares) | Summary |
|---|---|---|
| [Tutor Search](./features/tutor-search.md) | stable | *Which tutors are free for a class at this time, and are they qualified to teach it?* Sub-slot availability grid plus a fail-closed "Needs Review" list. |
| [Tutor Compare](./features/tutor-compare.md) | *no badge asserted* — standalone route is a redirect | 1–3 tutors side by side for one Bangkok week: what each already teaches, same-student conflicts, shared free slots. |
| [Tutor Profiles](./features/tutor-profiles.md) | stable | The editorial layer for what Wise does not carry — how a tutor teaches, who they suit, what is parent-safe, and any do-not-offer guidance. |
| [Classroom Assignments](./features/classroom-assignments.md) | stable | Turns a Bangkok day's Wise sessions into a physical room plan; writes the room back to Wise only on an explicit opt-in publish of eligible OFFLINE sessions. |
| [Room Capacity](./features/room-capacity.md) | *no single badge* — see the page | Room utilization (wired end to end) and month-pressure / saturation forecasting (implemented and tested, no caller outside tests). |
| [Sales Dashboard](./features/sales-dashboard.md) | stable | Turns the sales team's monthly Google Sheets into a governed Postgres dataset and a GM-facing revenue-pace / pipeline / scenario readout. |
| [Credit Control](./features/credit-control.md) | live | Projects when each student's prepaid credits cross the alert threshold and hit zero, ranks an at-risk worklist, and logs the outreach. |
| [Payroll](./features/payroll.md) | stable | Reconciles a Bangkok month of Wise sessions and payout invoices against a versioned rate card; emits integrity issues, adjustments, approval. |
| [Wise Activity Audit](./features/wise-activity-audit.md) | stable | Read-only mirror of what happened inside Wise, plus a package-sales reconciliation workbench against Sales Dashboard rows. |
| [Post-Class Feedback](./features/post-class-feedback.md) | stable | Preserves every Wise teacher-feedback version as immutable evidence, scores an objective deadline/content policy, and carries reviewed deductions to a capability-gated finance handoff. |
| [Progress Tests](./features/progress-tests.md) | *no label asserted* — see the page | The every-8-classes progress-test cadence as a tracked lifecycle, with teacher heads-up email, a morning admin digest, and one-click bilingual parent outreach. |
| [Student Schedule](./features/student-schedule.md) | stable | One student's month of classes: admin lookup and print-to-PDF, plus a no-login token link a parent opens from LINE. Same payload across three surfaces; the parent page renders a phone-first agenda. |
| [Learning Plans](./features/learning-plans.md) | *(no status line)* | Turns the committed BeGifted syllabus into a printable, student-specific plan. A stateless document generator — plan content lives in the URL, only access grants are stored. |
| [Student Promotions](./features/student-promotions.md) | stable | Audited July 1 workflow to move Wise students up an academic year, review Year 13 graduates, and check pay-band impact before applying. |
| [University Admissions](./features/university-admissions.md) | *no badge asserted* — merged, nav- and cron-registered | Counselor case management replacing per-student Google Sheets workbooks — cases, checklists, college lists, essays, testing, plus student and parent views. Background: [PRD](./Casemanagementsystem_prd.md) · [design](./casemanagementsystem_design.md). |
| [US Universities (IPEDS)](./features/us-universities.md) | stable | Read-only research console over a curated IPEDS slice; feeds the admissions college list. Offline operator-run ingest, no cron, fail-closed nulls on display. |
| [Competitor Intelligence](./features/competitor-intelligence.md) | stable | Weekly market-watch pipeline (sites, social, SERP) into scored evidence, an AI daily brief and War Room snapshot, and human-accepted response tasks. |
| [LINE Integration](./features/line-integration.md) | stable (Wise write-path dry-run only) | The bridge between BeGifted's LINE Official Account and the app: ingest, classify, draft, human-gated review, contact/student linking, schedule bot. |
| [Proposals (Admin Holds)](./features/proposals.md) | experimental | Temporary local "holds" on tutor slots during negotiation, surfaced inside search so two admins don't sell the same slot. Never written to Wise. |
| [AI Scheduler](./features/ai-scheduler.md) | experimental | LLM parses pasted parent chat into a structured request; the deterministic search decides availability; the model drafts the reply. |
| [Data Health](./features/data-health.md) | wired end to end at HEAD | The admin operations command center: cron firing, data freshness, snapshot fidelity, unresolved normalization issues. |
| [Leave Requests](./features/leave-requests.md) | committed, cron-scheduled, nav-registered | Pulls tutor time-off rows from a Google Sheet, matches them to a Wise identity, computes affected sessions, and gives admins a triage queue. Wise cancellation is preview-only. |

> **Coverage.** All 21 navigation tools registered in `src/lib/navigation/tools.ts` now have a
> feature page (Tutor Compare and Proposals have pages but no nav entry, by design). The one
> navigable surface still without a `features/*` page is the **Home Hub** at `/`
> (`src/app/(app)/page.tsx`, `src/components/home/home-hub.tsx`, `src/lib/home/summary.ts`) —
> tracked as CR-3 in [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md). Note that CR-2 in that file (four
> workspaces with no feature page) is **now stale**: `competitor-intelligence.md`,
> `progress-tests.md`, `student-schedule.md`, and `us-universities.md` all exist.

### Reference

Mechanical lookup. Owns exact signatures, columns, schedules, and variables — and nothing about
*why*.

#### API — [`reference/api/`](./reference/api/index.md)

Start at the index; it carries the master method + path + auth + purpose table for all 241 endpoints
and routes you to a detail page per group.

| Doc | Covers |
|---|---|
| [index.md](./reference/api/index.md) | **Master index** of every HTTP endpoint under `src/app/api/**/route.ts`: method, path, group, auth tier, one-line purpose — plus how to read the auth column (`public` / `admin` / `admin + cap:X` / `session (role: X)` / `cron` / `cron \| admin`). |
| [ai-scheduler.md](./reference/api/ai-scheduler.md) | `/api/ai-scheduler/*` — conversations, message turns, feedback, metrics. |
| [classrooms-and-assignments.md](./reference/api/classrooms-and-assignments.md) | `/api/class-assignments/*` and `/api/classrooms/*`. |
| [credit-control.md](./reference/api/credit-control.md) | `/api/credit-control/*`. |
| [line.md](./reference/api/line.md) | `/api/line/*` — webhook, contacts, OA resolver, scheduler reviews. |
| [payroll.md](./reference/api/payroll.md) | `/api/payroll/*`. |
| [proposals.md](./reference/api/proposals.md) | `/api/proposals/*`. |
| [room-capacity.md](./reference/api/room-capacity.md) | `/api/room-capacity/*`. |
| [sales-dashboard.md](./reference/api/sales-dashboard.md) | `/api/sales-dashboard/*`. |
| [student-promotions.md](./reference/api/student-promotions.md) | `/api/student-promotions/*` plus the July 1 internal cron route. |
| [university-admissions.md](./reference/api/university-admissions.md) | `/api/admissions/**` plus the admissions-notifications cron route. |
| [wise-activity.md](./reference/api/wise-activity.md) | `/api/wise-activity/*`. |
| [internal-crons.md](./reference/api/internal-crons.md) | `/api/internal/*` — every cron-triggered sync and automation endpoint. |
| [misc.md](./reference/api/misc.md) | The groups without their own page: search, tutors, filters, compare, home, data-health, leave-requests, tutor-profiles, auth, admin. |

> **Gap.** The API index links five detail pages that **do not exist in `docs/reference/api/` at
> this revision** — `competitor-intelligence.md`, `post-class-feedback.md`, `progress-tests.md`,
> `student-schedule.md`, `us-universities.md`. They are named here without links so this page has no
> broken links. Until they land, the master table in [index.md](./reference/api/index.md) plus the
> handlers under the matching `src/app/api/<prefix>/` directory are the source of truth for those
> groups. Tracked as CR-1 in [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md).

#### Database — [`reference/database/`](./reference/database/index.md)

| Doc | Covers |
|---|---|
| [index.md](./reference/database/index.md) | **Master table index**: all 188 tables, each with its grain, owning domain, and the `schema.ts` line range that is authoritative for its columns. |
| [enums.md](./reference/database/enums.md) | Every native Postgres enum: values, declaration site, and the columns bound to it. |
| [erd-core.md](./reference/database/erd-core.md) | The snapshot/ETL spine **plus** every subsystem that hangs directly off it — competitor intelligence, student promotions, tutor identity/normalization, progress tests, US universities, post-class feedback, university admissions, student monthly schedule. |
| [erd-sales-dashboard.md](./reference/database/erd-sales-dashboard.md) | Sales Dashboard tables. |
| [erd-credit-control.md](./reference/database/erd-credit-control.md) | Credit Control tables. |
| [erd-classrooms.md](./reference/database/erd-classrooms.md) | Classroom assignment + email tables. |
| [erd-payroll.md](./reference/database/erd-payroll.md) | Payroll tables. |
| [erd-tutor-profiles.md](./reference/database/erd-tutor-profiles.md) | Tutor Profiles tables. |
| [erd-leave-requests.md](./reference/database/erd-leave-requests.md) | Leave Requests tables. |
| [erd-ai-and-proposals.md](./reference/database/erd-ai-and-proposals.md) | AI Scheduler + Proposals tables. |
| [erd-line.md](./reference/database/erd-line.md) | LINE tables. |
| [erd-room-capacity.md](./reference/database/erd-room-capacity.md) | Room Capacity tables. |
| [erd-student-promotions.md](./reference/database/erd-student-promotions.md) | Student Promotions audit tables (also a `erd-core.md` sub-area). |
| [erd-university-admissions.md](./reference/database/erd-university-admissions.md) | University Admissions `admissions_*` tables (also a `erd-core.md` sub-area). |

> Post-Class Feedback has no `erd-*` page of its own — its 32 `post_class_*` tables are documented
> inside [erd-core.md](./reference/database/erd-core.md), and the feature page adds a durable
> data-model narrative on top.

#### Other reference

| Doc | Covers |
|---|---|
| [crons.md](./reference/crons.md) | Every Vercel Cron entry in the repo-root `vercel.json` (15 at this revision): schedule, endpoint, auth, timeout, single-flight guard — plus the internal handlers with **no** schedule. There is no in-process scheduler anywhere in the repo. |
| [env.md](./reference/env.md) | Every environment variable actually read by `src/` and `scripts/`, reconciled against the declared Zod schema in `src/lib/env.ts` (the inventories do not agree; the page says how). |
| [wise-api.md](./reference/wise-api.md) | The external Wise contract: transport client, retry/backoff, concurrency limiter, every domain fetcher, the read-only helpers, the writeback operations, and the `WISE_*` variables. |
| [production-route-surface.json](./reference/production-route-surface.json) | **Machine-read, not prose.** The recorded production route surface that `npm run guard:production-route-surface` enforces as additive during `verify:release` (`package.json`). Regenerate with `node scripts/check-production-route-surface.mjs --update`; do not hand-edit. |

### Operations

How to run, secure, and observe the system.

| Doc | Covers |
|---|---|
| [runbook.md](./operations/runbook.md) | Deploys and the release gate, DB/test scripts, triggering every scheduled job by hand, and recovering when a sync stalls or fails. |
| [auth-and-access.md](./operations/auth-and-access.md) | Who may sign in and what they may reach: the Google-only Auth.js v5 gate (no password login, no second provider, no DB session adapter), JWT claims, edge middleware, per-request re-checks. |
| [observability.md](./operations/observability.md) | The layers of health evidence, where each lives, what each failure mode looks like in the data, and how a stale snapshot surfaces to users. |
| [release-checkpoints/2026-06-04-reconcile-live-production.md](./operations/release-checkpoints/2026-06-04-reconcile-live-production.md) | A point-in-time record of the known-good production deployment used as the reconciliation baseline. Historical; not regenerated by documentation passes. |

### Open questions & gaps

| Doc | Covers |
|---|---|
| [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) | The consolidated list of questions **only a human can answer** — confirmed defects awaiting an owner, maturity and lifecycle governance, suspected dead code, schema and migration questions, time/timezone semantics, operations, auth surface, configuration, ambiguous product rules, retention and cost, testing gaps, reference-doc drift, and items needing access outside this repo. Ends with a numbered completeness review (CR-1…CR-10). Several feature and operations pages also carry their own inline *Open questions* sections. |

> **Footer drift.** Five reference pages were not regenerated by the latest documentation pass and
> carry an older footer or none at all: `reference/wise-api.md`,
> `reference/api/university-admissions.md`, `reference/api/student-promotions.md`,
> `reference/database/erd-student-promotions.md`, and
> `reference/database/erd-university-admissions.md`. Treat their contents as verified against an
> earlier revision than the rest of this tree.

---

## A note on the eval reports

The top-level AI-scheduler evaluation and audit artifacts — `docs/ai-scheduler-audit-2026-05-20.md`,
`docs/ai-scheduler-audit-2026-05-21.md`, `docs/ai-scheduler-replay-eval-2026-05-20.md`,
`docs/ai-scheduler-replay-eval-2026-05-21.md`, `docs/ai-scheduler-eval-latest.md`,
`docs/ai-scheduler-model-comparison.md`, and `docs/ai-scheduler-eval-cases.json` — are a **separate
body of work** from this handbook. They are point-in-time evaluation runs of the AI Scheduler's
prompt and model choices, produced by `npm run ai-scheduler:evaluate` and
`npm run ai-scheduler:compare-models` (`package.json`), not part of the handbook structure. They are
**left untouched** by documentation passes and are deliberately not linked into the table of
contents above. Do not read them as current system documentation; for the feature itself see
[`features/ai-scheduler.md`](./features/ai-scheduler.md).

The [`superpowers/`](./superpowers) directory (older design specs and plans — the 2026-04 range-search
and tutor-compare designs, the 2026-06 competitor-intelligence design) is likewise outside this
handbook and kept for historical context only. `Casemanagementsystem_prd.md` and
`casemanagementsystem_design.md` are the University Admissions background documents: they are
build-time intent, linked from that feature's page, and are not maintained as system documentation.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
