# Course Demand Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show monthly new and lost subject demand, a common three-month average, and twelve months of additional weekly tutor availability required.

**Architecture:** Extend the approved workforce analytics with a focused `workforce/growth/` module. Preserve booking classification and student–subject lifecycle evidence, calculate demand flows independently from the forecast, and allocate each tutor's capacity once. One typed report supplies the charts, details, assumptions and CSV exports.

**Tech Stack:** Node 24, existing Next.js 16/React/TypeScript, Drizzle/Postgres, Chart.js, Tailwind/shadcn and Vitest. Reuse installed dependencies and existing Bangkok interval helpers.

**Spec:** [Approved course-demand growth design](../specs/2026-10-01-course-demand-growth-design.md), commits `44dc3a22` and `12b1da1f`, approved on 1 October 2026. This extends the [workforce implementation plan](2026-10-01-tutor-workforce-analytics.md).

## Global Constraints

- Keep this inside Tutor Offboarding → Analytics. Make no Wise mutations or tutor removals.
- Use `Asia/Bangkok`, history floor `2026-03-01`, and cohort key student × academic subject. A level change is not a new cohort.
- Label starts as **newly observed**; exclude the March starting cohort from growth averages. Trials/pretests remain separate and do not start regular cohorts.
- Gross demand includes cancellations/no-shows. One Wise credit always equals one teaching hour. Preserve student-hours and tutor-hours separately.
- Churn requires **60 days without a taught class and no future uncancelled booking in that subject**. The loss month follows the last taught month; preserve confirmed events and later reactivations.
- Last taught class on 20 August means loss in September and a baseline of **May, June, July divided by three**. Missing history is not zero.
- Use the **same older, fully observed three months** for new demand, reactivations and churn. Show the dates and maturity lag.
- Project twelve monthly points after the last completed month. Apply cancellation/refund loss once; expose measured inputs and overrides.
- Show extra weekly availability, not hiring headcount. Default buffer is **0%**; 20% means minimum additional availability × 1.20.
- Keep each tutor's availability as one shared pool, including across filtered subjects. Preserve current booking commitments as a staffing floor.
- Unknown source fields remain unknown in UI, detail and export. Do not invent historic availability, complete participant lists or annual seasonality.
- Reuse admin authorization, stable revisions, private/no-store responses, formula-safe CSV and original source timestamps. Read applicable local Next.js guides before changing route/client boundaries.

## Review Focus

1. A returning student or subject mapping correction changes an earlier cohort: preserve event provenance, rebuild derived results deterministically, and never count both old and corrected events. Test in Tasks 1–2.
2. A class crosses Bangkok midnight/month-start, or a gap reaches exactly 60 days: use exact instants and half-open intervals. Test in Task 2.
3. Historical group membership or trial classification is incomplete: known subtotals remain useful, but an automatic complete forecast cannot silently use incomplete inputs. Test in Tasks 1–3.
4. A booking is cancelled, reinstated or moved after a churn check: append a revision, retain the previous evidence, and update the active result without duplicate departures. Test in Tasks 1–2.
5. Filters hide a subject that competes for the same tutor, or known bookings exceed the model: allocate across all subjects before filtering, preserve actual commitments and show any resulting requirement above the raw model. Test in Tasks 3–4.

## Execution and file ownership

Continue in `/Users/kevinhsieh/Developer/Scheduling/.claude/worktrees/slot-a`, branch `codex/tutor-offboarding-workforce`. Complete this plan's review before its implementation. Continue the already-approved workforce work while this plan is reviewed.

Use the user's requested parallel GPT-6.1 Sol/GPT-6 Luna method: Sol high for lifecycle/calculations/allocation and independent reviews; Luna high for bounded source/storage/API work; Sol high for UI. Freeze Task 1 types first. Tasks 2 and the synthetic UI can then progress in parallel. Task 3 consumes Task 2; Task 4 API integration consumes Task 3. Each worker owns its listed files, preserves others' changes, and commits explicit paths. The parent owns integration and production delivery.

All paths below are relative to this worktree. `growth/` means `src/lib/tutor-offboarding/workforce/growth/`. Tests live beside their owning module in `__tests__/`. Reuse `Database` from the existing DB module and `WorkforceMetric`, `WorkforceEvidence`, `WorkforceQuery` from `workforce/types.ts`.

## Shared contract

Task 1 defines these exported types in `growth/types.ts`; consumers do not create competing copies:

- `GrowthBookingMetadata`: session ID, classification `regular|trial|pretest|unknown`, exact source field/value, observation time, completeness and reasons. Classification must be evidenced; zero credits do not identify a trial.
- `GrowthLifecycleEvent`: stable event key, revision, student ID, subject, kind `churn|reactivation`, final taught/return instant, effective month, confirmation instant, baseline month list, evidence revision, source IDs, status `active|superseded`, certainty `observed|inferred`, reasons. An inferred historic event must not claim a past no-future-booking check.
- `GrowthEvidence`: `{ workforce: WorkforceEvidence; bookingMetadata: GrowthBookingMetadata[]; lifecycleEvents: GrowthLifecycleEvent[]; revision: string }`.
- `GrowthAssumptions`: optional overrides per subject for `newStudentHours`, `reactivatedStudentHours`, `churnStudentHours`, `cancellationFraction`, `studentHoursPerTutorHour`; global `bufferPercent` defaults to 0. Hours are nonnegative finite values, fraction is 0–1, mix is positive, buffer is 0–100. Each report input identifies `measured|override|unavailable` and retains its measured default.
- `GrowthQuery`: `{ filters: WorkforceQuery; assumptions: GrowthAssumptions }`. Filters change display scope, never cohort inception, lifecycle history, or the competing capacity pool.
- `GrowthMonthlyRow`: subject/month; newly observed, reactivated and churned student counts; new/reactivated/churn-baseline student-hours; gross booked, net credit and cancellation-loss student-hours; corresponding tutor-hour metrics; trial/pretest metrics; mature/provisional state; contributor keys. All numeric observations use `WorkforceMetric`.
- `GrowthFlows`: monthly rows, retained lifecycle events, selected common three-month window, per-subject averages, observed group mix, cancellation fractions, weekday/time patterns, source coverage and exceptions.
- `GrowthForecast`: base month, twelve forecast months, measured/override inputs, raw booked and credit-adjusted student/tutor hours, flat-demand comparison, current booking commitments, commitment-adjusted capacity requirement, allocation results and exceptions.
- `GrowthReport`: schema version 1, stable report revision, generated time, query, flows, forecast and quality. Detail rows refer to source student/session/event IDs; no independent chart arithmetic.
- `GrowthDetailQuery`: query plus `reportRevision`, `kind: cohort|churn|cancellation|capacity`, contributor key, cursor and page size (default100/max500). `GrowthDrilldown` carries the same revision, contributors, source records and exceptions. `GrowthExportSection` is `months|averages|forecast|gaps`.

### Task 1: Retain booking classification and lifecycle evidence

**Owner:** Luna high; Sol reviews evidence and migration behavior.

**Files:** Create `growth/types.ts`, `growth/source.ts`, `growth/store.ts`, `growth/__tests__/source.test.ts`, `growth/__tests__/store.integration.test.ts`, and additive `drizzle/0106_tutor_course_demand_growth.sql`. Modify `src/lib/db/schema.ts`, `drizzle/meta/_journal.json`, `workforce/wise-source.ts`, `workforce/source-sync.ts`, and the scoped integration fixture cleanup. If 0106 is taken, use the next free migration number and record it.

**Interfaces:** `normalizeGrowthBookingMetadata(raw: unknown, observedAt: string): GrowthBookingMetadata`; `loadGrowthEvidence(db: Database): Promise<GrowthEvidence>`; `storeGrowthBookingMetadata(db: Database, rows: GrowthBookingMetadata[]): Promise<void>`; `reconcileGrowthLifecycleEvents(db: Database, events: GrowthLifecycleEvent[]): Promise<void>`.

- [ ] Write failing source/storage tests: a recorded trial with positive credits stays a trial; a regular free/refunded class stays regular; an absent/unrecognized field is unknown; repeat ingestion is idempotent; a corrected classification is retained as a new version; lifecycle correction supersedes one active event rather than inserting a second active departure. Assert a mapping revision changes report evidence revision.
- [ ] Run `npx vitest run --project unit src/lib/tutor-offboarding/workforce/growth/__tests__/source.test.ts` and the scoped integration suite; record intended failures.
- [ ] Implement metadata retention using explicit source classification fields and reviewed exact aliases. Preserve raw source values. Add two durable tables for classification versions and lifecycle event revisions, indexed by session and student/subject/effective month. Enforce one active revision per natural event key transactionally. Reuse the workforce store for source session/credit facts.
- [ ] Connect metadata capture to the existing GET-only history import and credit-control ingestion. No request-time source fetching. Load the full retained history before applying view filters. Add a dry-run diagnostic for unknown classification and participant coverage to the existing sync CLI.
- [ ] Run the source tests, disposable-DB integration tests, scoped ESLint and typecheck. Require PASS; inspect generated SQL for additive behavior and no cascade into existing history.
- [ ] Commit explicit owned paths as `feat: retain course demand source and lifecycle evidence`.

### Task 2: Calculate cohorts, churn, cancellation losses and the common window

**Owner:** Sol high.

**Files:** Create `growth/lifecycle.ts`, `growth/flows.ts`, `growth/__tests__/lifecycle.test.ts`, `growth/__tests__/flows.test.ts`. Modify only the scoped completion hook in `workforce/source-sync.ts` after coordination with Task 1.

**Interfaces:** `deriveGrowthLifecycleEvents(evidence: GrowthEvidence, now: Date): GrowthLifecycleEvent[]`; `buildGrowthFlows(evidence: GrowthEvidence, query: GrowthQuery, now: Date): GrowthFlows`. Reuse `recordedTeachingMinutes` policy at the student grain: exclude that student's known cancellation/no-show; an ended class needs verified positive student net consumption unless direct teaching evidence resolves it.

- [ ] Write failing tests with these exact assertions: John4 + Evan8 gives12 new Maths student-hours; level change gives0 new cohorts; March starts are excluded; trial→regular starts at the regular class; confirmed churn→return is reactivation. Filtering to September preserves an April cohort start.
- [ ] Add lifecycle tests: last class20August → effectiveSeptember and baselineMay/June/July; future Physics prevents Physics churn but future Maths does not; exactly60 elapsed days confirms only with complete fresh future evidence. Missing May gives an unavailable three-month baseline, while complete May with no classes contributes0. Historical no-booking evidence that was not retained yields `inferred`, never `observed`.
- [ ] Add loss/window tests: one-hour half-charged cancellation loses0.5 student-hours; a group with fractions1 and0.5 loses0.5 student-hours and0.25 tutor-hours; missing member/credit prevents a complete total. Confirm `[1,2,3]→2`, `[1,2,6]→3`, `[1,2,12]→5`. At1October2026, the latest calendar-mature common window is June–August; any incomplete contributing source keeps affected averages unavailable. Cover midnight boundaries, reinstated/moved bookings and revised subject mapping.
- [ ] Run the two new unit suites and confirm intended failures; implement lifecycle reconciliation and flows. Use scheduled class instants for booked demand, preserving cancelled/no-show gross hours. Keep zero months only when coverage proves zero. Track student-level evidence independently from class-level group completeness.
- [ ] Persist lifecycle results after successful evidence ingestion, not from GET reports. Distinguish source corrections that invalidate an event from a later return that adds a reactivation. Include versioned algorithm/evidence identifiers in event and report revisions.
- [ ] Run both suites, scoped lint and typecheck; require PASS. Commit as `feat: calculate subject demand flows and churn`.

### Task 3: Forecast twelve months and allocate shared tutor capacity

**Owner:** Sol high; separate Sol reviewer must inspect the arithmetic and allocation.

**Files:** Create `growth/forecast.ts`, `growth/allocation.ts`, `growth/__tests__/forecast.test.ts`, `growth/__tests__/allocation.test.ts`. Consume existing workforce intervals and dated availability; coordinate a narrow exported helper from `workforce/capacity.ts` if necessary rather than duplicating availability rules.

**Interfaces:** `buildGrowthForecast(evidence: GrowthEvidence, flows: GrowthFlows, query: GrowthQuery, now: Date): GrowthForecast`; `allocateGrowthCapacity(input: GrowthAllocationInput): GrowthAllocationResult`. Define the allocation types in `growth/types.ts`: dated supply intervals per canonical tutor with qualified subjects, dated subject demand intervals, actual booking commitments, completeness and source times; output total/per-subject unmet hours plus attribution and exceptions.

- [ ] Write failing forecast tests: base100/new12/reactivation2/churn4 gives raw110 atmonth1 and220 atmonth12; cancellation0.10 gives99 and198, with no second churn deduction. A mix of2 student-hours/tutor-hour converts99 to49.5 tutor-hours. Missing measured input blocks its automatic series; an explicit override restores the series and is labeled. Reset equals the measured model.
- [ ] Add allocation tests: one Maths/Physics tutor with8 hours and simultaneous Maths8/Physics8 demand leaves an8-hour overall gap; separate nonoverlapping slots remain available; a booked Physics hour consumes the shared pool before flexible allocation. Hiding Physics does not free its commitments. Booked demand12 with a model estimate10 requires at least12. A2-hour gap with20% buffer gives2.4 additional hours. Cover partial30-minute intersections, leave, duplicate accounts, five-Monday months and unavailable qualifications.
- [ ] Run both suites and confirm intended failures. Implement twelve monthly points using `max(0, base + k*(new + reactivated - churn))`, then apply the cancellation fraction once. Preserve a flat-demand comparator and show the observed mix and common source window. Do not generate a confidence interval or annual seasonality.
- [ ] Distribute modeled tutor demand using observed subject/weekday/30-minute patterns and actual calendar occurrences. Preserve existing uncancelled commitments at their dated times/tutors. Allocate those commitments first, then only `max(0, modeled slot demand - matching commitments)` from the remaining supply. This can raise the capacity requirement above the raw monthly model; expose both numbers.
- [ ] Implement deterministic continuous max-flow over dated interval subdivisions: tutor supply nodes connect only to qualified subject demand nodes. Union linked-account availability, subtract approved leave and occupied intervals, and allocate across the whole subject set before filtering. Use stable scarcity-first/subject/key ordering to make equally valid allocations reproducible; explain that subject attribution depends on this allocation. Calculate the overall gap from unmet demand, not by summing overlapping subject supply rows. Unknown supply yields an explicitly incomplete gap, not a verified zero.
- [ ] Run the two suites, scoped lint and typecheck; require PASS. Commit as `feat: project course demand and shared capacity gaps`.

### Task 4: Add authorized report, details and export endpoints

**Owner:** Luna high; can prepare validators/fixtures after Task 1.

**Files:** Create `growth/query.ts`, `growth/service.ts`, `growth/csv.ts`, matching unit tests, and routes/tests under `src/app/api/tutor-offboarding/analytics/workforce/growth/` (`route.ts`, `drilldown/route.ts`, `export/route.ts`).

**Interfaces:** `getGrowthReport(db: Database, query: GrowthQuery, now: Date): Promise<GrowthReport>`; `getGrowthDrilldown(db: Database, query: GrowthDetailQuery, now: Date): Promise<GrowthDrilldown>`; `serializeGrowthCsv(report: GrowthReport, section: GrowthExportSection): string`. GET uses validated filters and measured defaults. POST on the report endpoint accepts validated `{filters, assumptions}` and only calculates a scenario; it writes no assumptions or source data. Detail/export POST receives the same scenario plus revision and bounded selection.

- [ ] Write failing tests for unauthenticated/restricted users, duplicate/prototype/unknown query keys, invalid dates, NaN/negative inputs, fraction>1, mix≤0, buffer>100, oversized scenario bodies, stale revisions, pagination and CSV formula injection. Assert no Wise or DB mutation is called by any report/detail/export handler.
- [ ] Run the new scoped unit/route tests; confirm intended failures. Implement the existing `requireTutorOffboardingAdmin()` boundary before data access, maximum100 subject overrides, request body≤64KiB and private/no-store responses for all outcomes. Derive a stable revision from evidence, algorithm version, the computed maturity/eligible-event state and normalized scenario/filter values. A sixty-day boundary that changes the result must change its revision without hashing volatile response time.
- [ ] Return the same metrics/units/assumptions to chart, drilldown and CSV. Export contributor IDs, exact common/baseline months, certainty, source observation dates and unknown reasons. Require409 for stale detail/export; do not recompute a different revision silently.
- [ ] Run unit/route tests, scoped lint and typecheck; require PASS. Commit as `feat: expose course demand growth reports`.

### Task 5: Build the Growth view and verify real interactions

**Owner:** Sol high; synthetic UI can start after Task 1 types freeze.

**Files:** Create `src/components/tutor-offboarding/workforce/growth-view.tsx`, `growth-charts.tsx`, `growth-assumptions.tsx`, `growth-details.tsx`, and focused tests. Modify `src/components/tutor-offboarding/workforce/dashboard.tsx` to add Growth alongside the approved views.

**Interfaces:** `GrowthView({ filters }: { filters: WorkforceQuery })` owns scenario request state and aborts stale requests. Child components consume `GrowthReport`; all displayed numbers and detail links come from the report. Reuse existing metric formatting, chart/heat-map and source-quality patterns.

- [ ] Write failing behavior tests for monthly new/reactivated/lost demand, the common three-month table, twelve projected points, separate student/tutor units, measured/override labels, reset, provisional/unknown values, source detail and revision-safe CSV. Assert no hiring headcount control and default0% buffer.
- [ ] Implement the view with four sections: monthly demand flows; three-month averages; twelve-month booked/credit-adjusted forecast with flat comparison and known commitments; subject/time additional-availability heat map. Show the capacity allocation explanation and raw model versus commitment-adjusted requirement. Keep all existing analytics/offboarding controls intact.
- [ ] Use synthetic fixtures for any MagicPath refinement. Test the user examples, an all-unknown report, large numbers, many subjects and an empty result. Distinguish provisional/inferred records and unavailable metrics visually and in accessible text; do not render unknown as an empty zero-height chart point.
- [ ] Run focused UI tests, scoped lint and typecheck. In the browser inspect desktop and narrow layouts, change subject/month/assumptions, reset, open each detail type and export; compare results with the report/CSV. Require readable axes/units, keyboard focus and no overflow before committing as `feat: add course demand growth dashboard`.

### Task 6: Independently review, populate and release

**Owner:** Parent; independent Sol high review. Existing production-delivery authorization applies after this plan's approval.

**Files:** Update `docs/features/tutor-offboarding.md`, `docs/reference/api/tutor-offboarding.md`, `docs/reference/database/index.md`, `docs/reference/wise-api.md`. Use the existing private migration/backfill receipt workflow; keep private operational evidence out of Git.

- [ ] Review each task and the complete extension against the spec, exact numeric examples and five Review Focus cases. Fix findings in their owning modules and rerun affected checks. Include evidence-only unknown states in the review, not just populated synthetic fixtures.
- [ ] Run scoped unit/integration tests against a disposable database, then `npm run typecheck`, `npm test`, `npm run build`, `npm run typecheck`, `git diff --check`, and `npm run guard:production-route-surface` with Node24. Require PASS or identify the exact unresolved blocker.
- [ ] Inspect final additive SQL, verified production target and migration journal. Apply only this reviewed migration, record schema read-back and keep the prior application deployment as rollback. Run a bounded dry-run history/classification import, inspect counts/coverage, then apply using the existing GET-only source workflow. Preserve completed checkpoints and original observation times.
- [ ] Verify lifecycle reconciliation and at least one subsequent ingestion, with no duplicate events. Reconcile a source-backed subject across report, detail and CSV. Where the source cannot establish classification, group membership, credits or history, verify the dashboard presents its limitation rather than claiming complete growth/hiring guidance.
- [ ] Push, create and attach the PR, satisfy protected-branch checks, and merge through the existing Git/Vercel integration. Verify the production alias's merged revision and authenticated Growth view, controls and export. Report the live URL, tested formulas, observed source coverage and any still-unavailable inputs.

## Self-review result

All six design sections map to Tasks 1–5; production and evidence checks are in Task 6. Every Review Focus case has an explicit owner/test. Shared types and signatures are defined once; reporting filters cannot reset cohort history or release competing capacity. Source uncertainty, inferred lifecycle history, scenario assumptions and current commitments remain visible through the full report/detail/export path.
