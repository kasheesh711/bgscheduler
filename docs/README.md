# BGScheduler Documentation Handbook

The entry point to the BGScheduler handbook. Start with the [reading order](#reading-order); use the
[canonical-home table](#canonical-home-who-owns-what) to decide which page is authoritative when two
pages mention the same thing; use the [table of contents](#table-of-contents) to jump.

BGScheduler (production hostname `bgscheduler.vercel.app`) is BeGifted Education's internal admin
console, built on top of the external **Wise** scheduling platform. Wise is the single production
source of truth, and it is slow, paginated, and rate-limited — so the whole system is organized
around one bet: **Wise is never queried on the tutor read path.** Scheduled syncs pull Wise into
versioned Postgres snapshots, a fail-closed normalization pipeline decides correctness at *write*
time, and a `globalThis`-anchored in-memory index answers searches from RAM.

If you read nothing else first, read
[`handbook/not-the-nextjs-you-know.md`](./handbook/not-the-nextjs-you-know.md) — it lists the
assumptions this codebase will break.

The docs are organized into five trees plus two loose sets, each with a distinct job:

- **[`handbook/`](#handbook)** — the cross-cutting mental model: architecture, data flow, conventions, vocabulary. **6 pages.**
- **[`features/`](#features)** — one page per product feature; owns *meaning* (purpose, rules, flows, why). **25 pages.**
- **[`reference/`](#reference)** — mechanical lookup: every endpoint, every table, every enum, crons, env vars, the Wise REST contract and its webhook catalogue. **46 pages** (22 API, 20 database, 4 top-level).
- **[`operations/`](#operations)** — runbook, auth/access model, observability, the maintenance kill switch, and one historical release checkpoint. **5 pages.**
- **[`OPEN-QUESTIONS.md`](#open-questions--gaps)** — the running list of things only a human can settle.
- **[`proposals/`](#proposals)** — dated design proposals that are *not* system documentation.
- **[Outside the handbook](#a-note-on-the-eval-reports-and-other-non-handbook-files)** — the AI-scheduler eval reports, `superpowers/`, and the admissions background docs.

### Scale at this revision

Every number below is mechanical, taken from the tree rather than from prose:

| Thing | Count | How it is counted |
|---|---:|---|
| Database tables | **189** | `grep -c "= pgTable(" src/lib/db/schema.ts` (the file is 4,772 lines) |
| Postgres enum types | **61** | `grep -c "= pgEnum(" src/lib/db/schema.ts` |
| Drizzle migrations | **69** | `ls drizzle/*.sql`, latest `drizzle/0068_payout_adjustment_superseded.sql` |
| Route files | **180** | `find src/app/api -name route.ts` |
| HTTP endpoints | **243** | 241 named `export async function GET\|POST\|PUT\|PATCH\|DELETE` handlers, **+2** for the Auth.js catch-all (`src/app/api/auth/[...nextauth]/route.ts:3` exports by destructuring, so it matches no `function` grep), **−2** for the two CORS `OPTIONS` preflights on the public OA-resolver routes |
| Vercel Cron entries | **17** | the `crons` array in `vercel.json` |
| Internal cron route handlers | **22** | `find src/app/api/internal -name route.ts`; the 5 unscheduled ones are `manualOnly: true` in `src/lib/data-health/cron-registry.ts` |
| Pages in the `(app)` group | **26** | plus 3 print surfaces under `src/app/(print)/`, `src/app/login/page.tsx`, and the public `src/app/schedule/[token]/page.tsx` — **31** `page.tsx` files in total |
| Navigation tools | **22** | in 6 sections, 7 with live count badges, 4 pinned as shortcuts (`src/lib/navigation/tools.ts`) |
| Vitest test files | **389** | `*.test.ts(x)` under `src/`, of which **13** are `*.integration.test.ts` |

The mechanical inventories behind the first six rows live in
[`reference/database/index.md`](./reference/database/index.md),
[`reference/api/index.md`](./reference/api/index.md), and
[`reference/crons.md`](./reference/crons.md).

---

## Reading order

New to the codebase? Read in this order. The first two pages give you the model; everything after
that is on demand.

1. **[`handbook/not-the-nextjs-you-know.md`](./handbook/not-the-nextjs-you-know.md)** — **start here.**
   The assumptions this repo violates: the tutor read path never hits Wise, reads are pinned to
   exactly one snapshot, sync-before-serve (no snapshot, no answers), fail-closed is the default
   posture rather than a flag, and the Next.js 16 specifics (`cacheComponents`, `"use cache"`,
   `globalThis` singletons, per-route `maxDuration`).
2. **[`handbook/overview.md`](./handbook/overview.md)** — the system overview: what the app is for,
   the snapshot-and-index bet, and a paragraph-per-feature tour of every workspace reachable from
   the tool navigation. The intended second stop.
3. **[`handbook/architecture.md`](./handbook/architecture.md)** — the layers top to bottom, the
   snapshot-versioned data model, the in-memory `SearchIndex` singleton, the fail-closed rule, and
   the request lifecycle.
4. **[`handbook/data-flow.md`](./handbook/data-flow.md)** — the Wise → Postgres → in-memory ETL
   stage by stage: `runFullSync()`, the promotion gate, and the failure model. Scoped to the tutor
   snapshot sync; the other 16 cron lineages keep their own `*_sync_runs` ledgers.
5. **[`handbook/glossary.md`](./handbook/glossary.md)** — domain vocabulary (snapshot, identity
   group, modality, canonical key, fail-closed), one line each, cited to the code that enforces it.
6. **[`handbook/conventions.md`](./handbook/conventions.md)** — the load-bearing Zod-at-the-boundary,
   fail-closed-default, Asia/Bangkok, and lazy-singleton rules you need *before* editing code.
7. **The feature you're touching** — jump to its [`features/*`](#features) page for the *why* and the
   rules, then follow its links into [`reference/`](#reference) for the *how*.
8. **Before you deploy or debug production** — [`operations/runbook.md`](./operations/runbook.md),
   then [`operations/observability.md`](./operations/observability.md).

Two navigation facts worth knowing before you go looking: `/` is a summary **hub** page that
redirects only single-page restricted users (`src/app/(app)/page.tsx:8-19`), not a blanket redirect;
and `/compare` is a client-side redirect into `/search` that preserves `?tutors=`
(`src/app/(app)/compare/page.tsx:10-17`).

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
| Exact HTTP endpoint surface | [`reference/api/*`](#api--referenceapi) | Method + path + auth tier + params + request/response shapes + status codes | Why an endpoint exists, how it fits a workflow |
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

**Badges are documentation-side.** There is no maturity marker anywhere in the source — `grep -rn
"@deprecated" src --include=*.ts --include=*.tsx` returns **0** matches, and there is no
feature-status constant or registry field. Every badge below comes from this documentation
program's maturity map and was then checked against a code-verifiable mechanism (a cron entry, a
nav registration, a flag, a route shape) on the feature's own page.

The four base levels:

| Badge | Meaning |
|---|---|
| **stable** | Built, tested, and running in production. Safe to depend on. |
| **experimental** | Reachable and running, but actively iterated — shapes, prompts, and behavior may still change. |
| **legacy** | A superseded path kept for compatibility. |
| **in-progress** | Not finished, or finished but not switched on. |

Several features carry a **compound badge** because one word would be false. Those are reconciled
here rather than silently normalized:

| Feature | Applied badge | Base level | What the qualifier means, in code |
|---|---|---|---|
| [Tutor Compare](./features/tutor-compare.md) | *legacy-redirect* | **legacy** (route only) | The standalone `/compare` page renders nothing — it is a `"use client"` component whose only effect is `router.replace("/search?tutors=…")` (`src/app/(app)/compare/page.tsx:10-17`), and it has no nav entry. The compare engine, both API endpoints, and the calendar UI are fully live inside `/search`. |
| [Room Capacity](./features/room-capacity.md) | *stable (utilization); forecast/month engines have no UI caller; sync is manualOnly* | **stable** + **in-progress** | Utilization is wired sync → API → dashboard. The month and forecast engines are implemented, tested, and authenticated but the only fetch of either in `src/` is their own route test, and their sync is registered `schedule: null`, `manualOnly: true` (`src/lib/data-health/cron-registry.ts:369-383`) with no `vercel.json` entry. |
| [LINE Integration](./features/line-integration.md) | *stable (scheduler write-path flag-gated)* | **stable** | `ENABLE_LINE_SCHEDULER` plus the two LINE credentials gate whether the webhook accepts events at all; `WISE_SESSION_OPERATIONS_VERIFIED` only changes a plan's readiness label. No code path in the feature mutates Wise. |
| [Post-Class Feedback](./features/post-class-feedback.md) | *stable*, with the payout write path *stable (writes flag-gated by `POST_CLASS_PAYOUT_WRITES_ENABLED` / `POST_CLASS_AUTO_APPROVE_ENABLED`)* | **stable** | Both flags are real env gates read in `src/lib/post-class-feedback/payout-config.ts:50` and `:165`. Enforcement is prospective: it starts in `shadow` mode and needs an access manager to pick a current-or-future effective instant. |
| [University Admissions](./features/university-admissions.md) | *stable (parity-hardening code unmerged on `origin/codex/admissions-parity-hardening`; schema landed)* | **stable**, with a caveat | Phases 1–6 and the admin Manage UI are on `main`, the nav entry exists, the notification cron is scheduled — but a later parity-hardening commit lives only on that remote branch (which does exist: `git log -1 origin/codex/admissions-parity-hardening` → `caf48eb`) while its migrations reached `main` inside an unrelated PR. `main` therefore declares admissions columns no code on `main` reads. |

No feature currently sits at plain **in-progress**. The level is kept in the legend because
[OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) tracks candidates for it, and because Room Capacity's
forecast half is effectively there.

---

## Table of contents

### Handbook

The cross-cutting mental model — read these to understand the system as a whole. Six pages.

| Doc | What it covers |
|---|---|
| [not-the-nextjs-you-know.md](./handbook/not-the-nextjs-you-know.md) | First-read gotchas: the assumptions this codebase breaks. **Start here.** |
| [overview.md](./handbook/overview.md) | System overview — what the app is, the snapshot-and-index bet, a tour of every navigable workspace. |
| [architecture.md](./handbook/architecture.md) | The layers top to bottom, snapshot-versioned data model, in-memory `SearchIndex`, the fail-closed rule, request lifecycle. |
| [data-flow.md](./handbook/data-flow.md) | The Wise → Postgres → in-memory ETL stage by stage: triggers, transport, the past-session diff hook, promotion, failure model. |
| [conventions.md](./handbook/conventions.md) | Zod at route boundaries, fail-closed defaults, Asia/Bangkok time, lazy singletons, and what CI actually enforces. |
| [glossary.md](./handbook/glossary.md) | Domain vocabulary, one line each, cited to the code that defines it. |

### Features

One page per product feature; owns purpose, rules, flows, and the *why*. **Twenty-five pages** —
`ls docs/features/*.md | wc -l` → 25. The first four groups follow the tool navigation
(`src/lib/navigation/tools.ts`, 22 tools in 6 sections); the last group holds the two pages whose
surface has no nav entry of its own.

#### Scheduling & Tutors

| Feature | Badge | Summary |
|---|---|---|
| [Tutor Search](./features/tutor-search.md) | stable | *Which tutors are free for a class at this time, and are they qualified to teach it?* Sub-slot availability grid plus a fail-closed "Needs Review" list. |
| [Tutor Compare](./features/tutor-compare.md) | legacy-redirect (engine live) | 1–3 tutors side by side for one Bangkok week: what each already teaches, same-student conflicts, shared free slots. Lives inside `/search`. |
| [Tutor Profiles](./features/tutor-profiles.md) | stable | The editorial layer for what Wise does not carry — how a tutor teaches, who they suit, what is parent-safe, and any do-not-offer guidance. Keyed on `canonicalKey` so it survives snapshot rotation. |
| [Classroom Assignments](./features/classroom-assignments.md) | stable | Turns a Bangkok day's Wise sessions into a physical room plan; writes the room back to Wise only on an explicit opt-in publish of eligible OFFLINE sessions. The one routine Wise write path. |
| [Room Capacity](./features/room-capacity.md) | stable (utilization) — see [legend](#maturity-legend) | Room utilization (wired end to end) plus month-pressure and saturation forecasting (implemented and tested, no caller outside tests). |
| [Post-Class Feedback](./features/post-class-feedback.md) | stable (payout writes flag-gated) | Preserves every Wise teacher-feedback version as immutable evidence, scores an objective deadline/content policy, and carries reviewed deductions through a capability-gated finance handoff into the payout ledger. |
| [LINE Integration](./features/line-integration.md) | stable (scheduler write-path flag-gated) | The bridge between BeGifted's LINE Official Account and the app: webhook ingest, classification, drafted replies behind a human review queue, contact/student linking, and the admin schedule bot. |
| [Leave Requests](./features/leave-requests.md) | stable | Pulls tutor time-off rows from a Google Sheet, matches them to a Wise identity, computes affected sessions, and gives admins a triage queue. Wise cancellation is preview-only. |
| [AI Scheduler](./features/ai-scheduler.md) | experimental | An LLM parses pasted parent chat into a structured request; the deterministic search engine decides availability; the model drafts the reply. *"You never decide availability"* is in the prompt. |
| [Proposals (Admin Holds)](./features/proposals.md) | experimental | Temporary local "holds" on tutor slots during negotiation, surfaced inside search so two admins don't sell the same slot. Never written to Wise. |

#### Student Lifecycle

| Feature | Badge | Summary |
|---|---|---|
| [Progress Tests](./features/progress-tests.md) | stable | The every-8-classes progress-test cadence as a tracked lifecycle, with a teacher heads-up, a morning admin digest, and bilingual parent outreach. |
| [Student Schedule](./features/student-schedule.md) | stable | One student's month of classes: admin lookup and print-to-PDF, plus a no-login capability-token link a parent opens from LINE. Same payload across all three surfaces. |
| [Parent Class Report](./features/student-report.md) | stable | What a family actually got for its money over a date range: per-class rows off the credit-control snapshot, optional tutor-feedback sub-rows, an A4 print surface, three CSV exports, and the LINE `/report` command. Nav label **Parent Report**. |
| [Learning Plans](./features/learning-plans.md) | stable | Turns the committed BeGifted syllabus into a printable, student-specific plan. Stateless — plan content lives in the URL; only access grants are stored. |
| [Student Promotions](./features/student-promotions.md) | stable | Audited July 1 workflow to move Wise students up an academic year, review Year 13 graduates, and check pay-band impact before applying. The only annual cron. |
| [University Admissions](./features/university-admissions.md) | stable (see [legend](#maturity-legend)) | Counselor case management replacing per-student Google Sheets workbooks — cases, checklists, college lists, essays, testing — plus student and parent views. The only route family that is not admin-only. |

#### Finance & Revenue

| Feature | Badge | Summary |
|---|---|---|
| [Sales Dashboard](./features/sales-dashboard.md) | stable | Turns the sales team's monthly Google Sheets into a governed Postgres dataset and a GM-facing revenue-pace / pipeline / scenario readout. Owns the shared Sheets access layer. |
| [Credit Control](./features/credit-control.md) | stable | Projects when each student's prepaid credits cross the alert threshold and hit zero, ranks an at-risk worklist, and logs the outreach. Its snapshot tables are read by eleven other modules. |
| [Payroll](./features/payroll.md) | stable | Reconciles a Bangkok month of Wise sessions and payout invoices against a versioned rate card; emits integrity issues, manual adjustments, and an approval step. |

#### Market Intelligence · Research & Reference · Data & Audit

| Feature | Badge | Summary |
|---|---|---|
| [Competitor Intelligence](./features/competitor-intelligence.md) | stable | Weekly market-watch pipeline (sites, social, SERP) into scored evidence, an AI daily brief and War Room snapshot, and human-accepted response tasks. The only weekly cron. |
| [US Universities (IPEDS)](./features/us-universities.md) | stable | Read-only research console over a curated IPEDS slice; feeds the admissions college list. Operator-run offline ingest, no cron, fail-closed nulls on display. |
| [Wise Activity Audit](./features/wise-activity-audit.md) | stable | Read-only mirror of what happened inside Wise, plus a package-sales reconciliation workbench against Sales Dashboard rows. |
| [Data Health](./features/data-health.md) | stable | The admin operations command center: cron firing, data freshness, snapshot fidelity, unresolved normalization issues. Backed by the `cron-watchdog` cron. |

#### Surfaces with no nav tool of their own

Both are reachable — one through the LINE Official Account, one through a cron and the Class Feedback
workspace — but neither has an entry in `src/lib/navigation/tools.ts`, so neither fits the four groups
above. Each was carried inside a neighbouring page until the gap-fill pass gave it one of its own.

| Feature | Badge | Summary |
|---|---|---|
| [LINE Credit Bot](./features/line-credit-bot.md) | stable | The `/credit` and `/report` commands inside the LINE OA plus the 09:03 Bangkok run-out digest: prepaid balances and class reports answered in chat, behind a staff-group allowlist. Dispatch and gating stay in [line-integration.md](./features/line-integration.md); the balances' meaning stays in [credit-control.md](./features/credit-control.md). |
| [Post-Class Payout Runs](./features/post-class-payout.md) | stable (writes flag-gated) | The finance half of [Post-Class Feedback](./features/post-class-feedback.md): the 26→25 payout window, the hourly accrual cron, the publish lease, and the individually recoverable Google Sheets ledger writes behind `POST_CLASS_PAYOUT_WRITES_ENABLED`. |

> **Nav coverage.** The one navigable surface with neither a feature page nor a stand-in is the
> **Home Hub** at `/` (`src/app/(app)/page.tsx`, `src/components/home/home-hub.tsx`,
> `src/lib/home/summary.ts`) — the page that renders the seven nav count badges.

### Reference

Mechanical lookup. Owns exact signatures, columns, schedules, and variables — and nothing about
*why*.

#### API — [`reference/api/`](./reference/api/index.md)

Start at the index; it carries the master method + path + auth + purpose table for all **243**
endpoints and routes you to a detail page per group.

| Doc | Covers |
|---|---|
| [index.md](./reference/api/index.md) | **Master index** of every endpoint under `src/app/api/**/route.ts`: method, path, group, auth tier, one-line purpose — plus how to read the auth column (`public` / `admin` / ``admin + cap:`X` `` / `session (role: X)` / `cron` / `cron \| admin`) and the three places where middleware and handler disagree. |
| [university-admissions.md](./reference/api/university-admissions.md) | `/api/admissions/**` plus the admissions-notifications cron route. The largest group at 61 endpoints (63 with the two cron halves). |
| [internal-crons.md](./reference/api/internal-crons.md) | `/api/internal/*` — 25 of the 31 internal endpoints; the other six are indexed on the page of the subsystem they drive. |
| [line.md](./reference/api/line.md) | `/api/line/*` — webhook, contacts, OA resolver, scheduler reviews. 29 endpoints. |
| [post-class-feedback.md](./reference/api/post-class-feedback.md) | `/api/post-class-feedback/*` — the 13 capability-gated workspace endpoints plus the six internal cron routes that feed them. |
| [sales-dashboard.md](./reference/api/sales-dashboard.md) | `/api/sales-dashboard/*` plus its two internal cron halves. |
| [student-promotions.md](./reference/api/student-promotions.md) | `/api/student-promotions/*` plus the July 1 internal cron route. |
| [classrooms-and-assignments.md](./reference/api/classrooms-and-assignments.md) | `/api/class-assignments/*`, `/api/classrooms/*`, and the two morning/admin-email cron routes. |
| [competitor-intelligence.md](./reference/api/competitor-intelligence.md) | `/api/competitor-intelligence/*` plus the weekly sync cron. |
| [ai-scheduler.md](./reference/api/ai-scheduler.md) | `/api/ai-scheduler/*` — conversations, message turns, feedback, metrics. |
| [credit-control.md](./reference/api/credit-control.md) | `/api/credit-control/*`. |
| [progress-tests.md](./reference/api/progress-tests.md) | `/api/progress-tests/*` plus the sync and admin-digest cron routes. |
| [payroll.md](./reference/api/payroll.md) | `/api/payroll/*`. |
| [leave-requests.md](./reference/api/leave-requests.md) | `/api/leave-requests/*` plus the sheet-sync cron route. |
| [us-universities.md](./reference/api/us-universities.md) | `/api/us-universities/*` — the five read-only IPEDS endpoints and their shared filter query. |
| [wise-activity.md](./reference/api/wise-activity.md) | `/api/wise-activity/*` plus its ingest cron. |
| [tutor-profiles.md](./reference/api/tutor-profiles.md) | `/api/tutor-profiles/*` — roster read, single-profile patch, and the bulk import preview/commit pair. |
| [student-schedule-and-report.md](./reference/api/student-schedule-and-report.md) | `/api/student-schedule/*` and `/api/student-report` — the admin calendar read, the parent capability-link mint, and the Parent Report statement. |
| [room-capacity.md](./reference/api/room-capacity.md) | `/api/room-capacity/*` plus the manual-only utilization sync. |
| [proposals.md](./reference/api/proposals.md) | `/api/proposals/*`. |
| [data-health.md](./reference/api/data-health.md) | `/api/data-health/*` — the dashboard read, the manual job runner, and the watchdog sweep. |
| [misc.md](./reference/api/misc.md) | A real detail page, not a placeholder: the 11 endpoints with no group page of their own — search, compare, tutors/filters, home summary, the session-authed Wise-sync trigger, and the Auth.js catch-all. It opens with a **Where the other families moved** table pointing at the ten families split out into the pages above. |

#### Database — [`reference/database/`](./reference/database/index.md)

| Doc | Covers |
|---|---|
| [index.md](./reference/database/index.md) | **Master table index**: all 189 tables, each with its grain, owning domain, and the `schema.ts` line range that is authoritative for its columns. **Eighteen** domain groupings, one per `erd-*.md` page, so every table is diagrammed in exactly one place. |
| [enums.md](./reference/database/enums.md) | All 61 native Postgres enum types: values, declaration site, and the columns bound to each. |
| [erd-core.md](./reference/database/erd-core.md) | The snapshot/ETL spine and what still hangs directly off it: sync control plane and cron observability, auth & access, tutor identity/normalization/session blocks/data health, and the read-only IPEDS dataset. **22 tables** — it opens with a *Moved* table naming the eight domains that took 102 tables onto their own pages. |
| [erd-university-admissions.md](./reference/database/erd-university-admissions.md) | University Admissions tables (36) — the largest single domain, in four numbered sections. |
| [erd-post-class-feedback.md](./reference/database/erd-post-class-feedback.md) | Post-Class Feedback + payout tables (32) in six named sections: configuration/access/audit, evidence collection, notifications, AI quality review, finance and deductions, payout ledger. |
| [erd-competitor-intelligence.md](./reference/database/erd-competitor-intelligence.md) | Competitor Intelligence tables (16). |
| [erd-line.md](./reference/database/erd-line.md) | LINE tables (13). |
| [erd-credit-control.md](./reference/database/erd-credit-control.md) | Credit Control tables (11) — the de-facto institute-wide student/session store. |
| [erd-classrooms.md](./reference/database/erd-classrooms.md) | Classroom assignment + email tables (9). |
| [erd-payroll.md](./reference/database/erd-payroll.md) | Payroll tables (8). |
| [erd-progress-tests.md](./reference/database/erd-progress-tests.md) | Progress Tests tables (8). |
| [erd-sales-dashboard.md](./reference/database/erd-sales-dashboard.md) | Sales Dashboard tables (7). |
| [erd-ai-and-proposals.md](./reference/database/erd-ai-and-proposals.md) | AI Scheduler + Proposals tables (6). |
| [erd-student-promotions.md](./reference/database/erd-student-promotions.md) | Student Promotions tables (6). |
| [erd-leave-requests.md](./reference/database/erd-leave-requests.md) | Leave Requests tables (5). |
| [erd-room-capacity.md](./reference/database/erd-room-capacity.md) | Room Capacity tables (4). |
| [erd-tutor-profiles.md](./reference/database/erd-tutor-profiles.md) | Tutor Profiles tables (2). |
| [erd-wise-activity.md](./reference/database/erd-wise-activity.md) | Wise Activity Audit tables (2) — the event mirror and its ingest ledger. |
| [erd-learning-plans.md](./reference/database/erd-learning-plans.md) | Learning Plans access grants (1) — the only table the otherwise stateless plan builder owns. |
| [erd-student-schedule.md](./reference/database/erd-student-schedule.md) | Student Schedule capability tokens (1) — `student_schedule_links`, the hashed token behind the public parent page. |

#### Other reference

| Doc | Covers |
|---|---|
| [crons.md](./reference/crons.md) | Every Vercel Cron entry in the repo-root `vercel.json` (**17** at this revision): schedule, Bangkok time, registry key, `maxDuration`, single-flight guard — plus the 5 internal handlers with **no** schedule. There is no in-process scheduler anywhere in the repo. |
| [env.md](./reference/env.md) | Every environment variable actually read by `src/` and `scripts/`, reconciled against the declared Zod schema in `src/lib/env.ts` (the two inventories do not agree; the page says how). |
| [wise-api.md](./reference/wise-api.md) | The external Wise REST contract: transport client, retry/backoff, concurrency limiter, every domain fetcher, the read-only helpers, the writeback operations, and the `WISE_*` variables. |
| [wise-webhooks.md](./reference/wise-webhooks.md) | The Wise **webhook** side: the event catalogue and payload fields, read against the polling fleet BGScheduler runs today. Companion to the [cron-efficiency proposal](./proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md); nothing in the repo subscribes to a webhook at this revision. |
| [production-route-surface.json](./reference/production-route-surface.json) | **Machine-read, not prose.** The recorded production route surface that `npm run guard:production-route-surface` enforces as additive during `verify:release` (`package.json:37-38`). Regenerate with `node scripts/check-production-route-surface.mjs --update`; do not hand-edit. |

### Operations

How to run, secure, and observe the system.

| Doc | Covers |
|---|---|
| [runbook.md](./operations/runbook.md) | Deploys and the release gate (`npm run verify:release` → `deploy:prod`, `package.json:38-39`), DB/test scripts, triggering every scheduled job by hand, and recovering when a sync stalls or fails. |
| [auth-and-access.md](./operations/auth-and-access.md) | Who may sign in and what they may reach: the Google-only Auth.js v5 gate, the `admin_users` allowlist, `allowedPages` scoping, JWT claims, edge middleware, and the per-request re-checks that never trust the token. |
| [observability.md](./operations/observability.md) | The layers of health evidence, where each physically lives, what each failure mode looks like in the data, and how a stale snapshot surfaces to users. |
| [maintenance-mode.md](./operations/maintenance-mode.md) | The `MAINTENANCE_MODE` kill switch and its `MAINTENANCE_BYPASS_EMAILS` allowlist: what the edge middleware gates, what it deliberately does not (crons and the public parent page), and the flip-and-redeploy procedure. |
| [release-checkpoints/2026-06-04-reconcile-live-production.md](./operations/release-checkpoints/2026-06-04-reconcile-live-production.md) | A point-in-time record of the known-good production deployment used as a reconciliation baseline. Historical; not regenerated by documentation passes. |

### Open questions & gaps

| Doc | Covers |
|---|---|
| [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) | The consolidated list of questions **only a human can answer**, in 15 numbered sections: confirmed defects awaiting an owner, maturity and lifecycle governance, suspected dead code, schema and migration questions, time/timezone semantics, operations, auth surface, configuration, ambiguous product rules, retention and cost, testing gaps, reference-doc drift, conventions, items needing access outside this repo, and published claims verification could not settle. Several feature and operations pages also carry their own inline *Open questions* sections. |

### Proposals

Dated design proposals. These are **decision inputs, not system documentation** — a proposal
describes what someone thinks should happen, and only the parts explicitly marked as shipped are
reflected in the rest of this handbook.

| Doc | Covers |
|---|---|
| [proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md](./proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md) | Evaluation of the polling cron fleet against Wise's webhook integration, with Tier 1 fixes shipped and Tier 2/3 designed but not built. Its companion event catalogue is [reference/wise-webhooks.md](./reference/wise-webhooks.md). |

---

## Footer coverage

Every handbook page now carries the same verification footer, so there is no drift table to keep.
`grep -rlx '_Verified against main@0cd1e81 (clean tree) on 2026-09-02._' docs/ | wc -l` → **83** —
all 6 handbook pages, all 25 feature pages, the 4 current operations pages, all 46 reference pages,
this index, and `OPEN-QUESTIONS.md`. The five pages the previous revision listed as stale
(`reference/wise-api.md`, `reference/api/university-admissions.md`,
`reference/api/student-promotions.md`, `reference/database/erd-student-promotions.md`,
`reference/database/erd-university-admissions.md`) were regenerated and now carry it too.

The files **without** that footer are out of scope by design, not drift: the six AI-scheduler eval
and audit artifacts, the four `superpowers/` specs and plans, the two admissions background
documents, and the historical release checkpoint. The one dated proposal carries its own
`_Verified against origin/main fed828d on 2026-09-02._` because it was written against the branch
tip rather than the documentation baseline.

---

## A note on the eval reports and other non-handbook files

The top-level AI-scheduler evaluation and audit artifacts — `docs/ai-scheduler-audit-2026-05-20.md`,
`docs/ai-scheduler-audit-2026-05-21.md`, `docs/ai-scheduler-replay-eval-2026-05-20.md`,
`docs/ai-scheduler-replay-eval-2026-05-21.md`, `docs/ai-scheduler-eval-latest.md`,
`docs/ai-scheduler-model-comparison.md`, and `docs/ai-scheduler-eval-cases.json` — are a **separate
body of work** from this handbook. They are point-in-time evaluation runs of the AI Scheduler's
prompt and model choices, produced by `npm run ai-scheduler:evaluate` and
`npm run ai-scheduler:compare-models` (`package.json:23-24`), not part of the handbook structure.
They are **left untouched** by documentation passes and are deliberately not linked into the table
of contents above. Do not read them as current system documentation; for the feature itself see
[`features/ai-scheduler.md`](./features/ai-scheduler.md).

Two other sets of files under `docs/` are likewise outside the handbook:

- [`superpowers/`](./superpowers) — older design specs and plans (the 2026-04 range-search and
  tutor-compare designs, the 2026-06 competitor-intelligence design), kept for historical context
  only and not maintained.
- `Casemanagementsystem_prd.md` and `casemanagementsystem_design.md` — the University Admissions
  background documents. They are build-time intent, linked from
  [that feature's page](./features/university-admissions.md), and are not maintained as system
  documentation.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
