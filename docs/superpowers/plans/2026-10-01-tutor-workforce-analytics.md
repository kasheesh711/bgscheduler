# Tutor Workforce Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Tutor Offboarding analytics dashboard with monthly turnover, changing subject supply/demand, and individual utilization based on verified credit consumption.

**Architecture:** Keep the existing offboarding workflow and add a focused `src/lib/tutor-offboarding/workforce/` domain. Existing syncs feed durable observations and lesson/credit facts; pure calculations produce one typed report used by authenticated APIs, charts, drilldowns and exports. Missing source evidence remains an explicit state.

**Tech Stack:** Node 24, Next.js 16.2.2 App Router with cache components, React 19, TypeScript, Drizzle/Postgres, existing Chart.js, Tailwind/shadcn, Vitest; MagicPath for the visual design.

**Spec:** [Approved dashboard design](../specs/2026-10-01-tutor-workforce-analytics-design.md), committed as `24109d75` and approved by the user on 1 October 2026.

## Global Constraints

- Keep the dashboard in Tutor Offboarding → Analytics. Include tutors and teaching administrators; count linked Wise accounts once per person.
- All date boundaries use `Asia/Bangkok`. The history floor is `2026-03-01`.
- Turnover = departures during the month ÷ roster at the start of that month. Use earliest retained Wise account-join date and the approved final-class rule; pending future classes prevent a completed departure.
- Demand includes cancelled classes and no-shows. Show unique students, student bookings, distinct classes and booked tutor-hours separately.
- Consumed hours = scheduled duration × arithmetic mean of each booked student's net-credit/normal-credit fraction. A full refund is zero; missing evidence is unknown.
- Use gross offered hours minus approved leave as the utilization denominator. Include outside-hours teaching; allow rates above 100%.
- Subject capacity is shared. Subtract all blocking commitments from a person's time, regardless of the booked subject; never sum overlapping subject rows into an organization total.
- Do not fabricate historical availability or qualifications. Align each utilization numerator and denominator to the same verified period and show coverage.
- Use the approved recorded-teaching fallback: ENDED plus credit consumption, excluding known cancellations/no-shows. Label scheduled-duration estimates as recorded class data.
- Make no Wise mutations or tutor removals. Preserve existing authorization and owner removal controls. Use synthetic/anonymized fixtures in MagicPath.
- Read applicable local Next guides before changing routes or client boundaries. Reuse installed dependencies and existing brand tokens.
- Use explicit file ownership and pathspec commits. Do not modify unrelated work or expose credentials/private evidence in Git.

## Review Focus

1. A refund is represented as a replacement balance or as separate movements: never subtract it twice or retain an obsolete positive charge. Pin this in the source and credit tests.
2. One student in a group has unknown credits or a different normal charge: do not average only the convenient rows or weight fractions by price. Pin this in calculation tests.
3. An outage or partial sync occurs between observations: preserve the previous snapshot for scheduling but mark the analytics gap, rather than extending capacity indefinitely. Pin this in persistence and interval tests.
4. A class or roster boundary falls on Bangkok midnight/month-start: count it in the correct month, including joins, final classes and interval clipping. Pin this in turnover and aggregation tests.
5. A course label changes or a selected month has five Mondays: preserve mapping provenance and comparable heat-map units; do not silently reclassify or inflate an average week. Pin this in mapping, aggregation and UI tests.

## Execution and ownership

Continue in `/Users/kevinhsieh/Developer/Scheduling/.claude/worktrees/slot-a`, branch `codex/tutor-offboarding-workforce`. The user explicitly requested parallel delegation to GPT-6.1 Sol and GPT-6 Luna. Use Sol at high effort for schema, calculations and UI; use Luna at medium/high effort for bounded source adapters, API/export work and documentation. Use independent Sol review for calculations, authorization and the complete branch.

Freeze the shared types first. Then storage/calculations and MagicPath/UI can progress in parallel against those types. Workers own separate files and must preserve each other's changes. The parent owns shared schema integration, dependency order, final verification and production rollout.

The following tasks are completed only after this written plan is reviewed by the user.

### Task 1: Freeze report types and verify Wise source contracts

**Owner:** Luna (high), with Sol reviewing financial/source assumptions.

**Files:** Create `src/lib/tutor-offboarding/workforce/types.ts`, `wise-source.ts`, `scripts/probe-tutor-workforce-history.ts`, and `src/lib/tutor-offboarding/workforce/__tests__/wise-source.test.ts`. Read existing `src/lib/credit-control/wise.ts`, `src/lib/wise/client.ts`, and `src/lib/wise/fetchers.ts`.

**Interfaces:**

- `WorkforceQuery`: `from`/`to` inclusive Bangkok dates, `viewMonth` (`YYYY-MM`), `role: all|tutor|teaching_admin`, optional `subject`/`curriculum`/`level`, `modality: all|online|onsite`.
- `WorkforceMetric`: `{ value: number|null; completeness: complete|partial|unknown; reasonCodes: string[] }`. Counts, hours and percentages have distinct field names; unknown never means zero.
- `WorkforceEvidence`: canonical people, dated observations, session/tutor facts, historical booked participants, student credit evidence, reviewed subject mappings, termination marks and source coverage.
- Define `WorkforceSession` with Wise session/class IDs, start/end instants, scheduled minutes, canonical tutor keys, historical booked student IDs, completeness, meeting/attendance states and optional direct teaching evidence. Define `StudentCreditEvidence` with session/student IDs, net/normal credits (nullable), evidence status, source interpretation, observation time and issue codes. These shared shapes are owned by this task.
- `WorkforceReport`: `{ schemaVersion: 1; generatedAt; query; months; subjects; weekCells; people; quality }`; month rows expose opening/closing roster, joins, departures, pending and turnover; other rows expose applicable demand, offered/usable/free hours and the three utilization measures.
- `WorkforceDrilldown`: `{ query; reportRevision; kind: person|subject_cell|turnover; key; contributors; exceptions }`. Define contributing entity IDs once in this file.
- `WorkforceDrilldownQuery` extends the report query with `kind`, `key`, `reportRevision`, optional cursor and a page size (default 100, maximum 500). `WorkforceExportSection` is `months|subjects|week|people`. Task-local request/result types below are exported by their owning module; they must use these shared evidence/report types.
- `fetchWorkforceSourceWindow(input: SourceWindowRequest): Promise<SourceWindowResult>` returns normalized evidence plus requested/returned window, paging counts, truncation, completeness and contract issues. `probeWorkforceSources(options: ProbeOptions): Promise<SourceContractReport>` has explicit date, page, request and credit-example caps.

- [ ] Write fixture tests proving exact-page-boundary pagination, duplicate IDs, incomplete historical participant lists, 7-day availability limits and exclusively GET requests. Assert ambiguous refund movements and unverified historical normal charges return unknown, not a number; assert an exhausted request cap leaves coverage incomplete.
- [ ] Run `npx vitest run --project unit src/lib/tutor-offboarding/workforce/__tests__/wise-source.test.ts`; confirm the new adapter is initially missing and the tests fail for the intended reason.
- [ ] Implement the types and capped read-only adapter. Reuse the existing client limiter; stop the probe on rate limit or cap exhaustion. Check default/multiple availability schedule resolution as well as session/student credit history. Do not alter shared fetcher behavior without a demonstrated mismatch and a regression test.
- [ ] Run the fixture tests again and `npm run typecheck`; require both to pass.
- [ ] Run the probe with an explicit March sample, a recent sample, known partial/refunded and group examples, and a tutor availability example. Use private local output with restrictive permissions; print only counts, contract conclusions and completeness. Record whether credits are current balances or ledger movements and whether historical normal charges are actually exposed. No database writes or private committed fixtures.
- [ ] Commit scoped files as `feat: define workforce source contracts`. Record metric-specific unsupported contracts as issue codes; these block a numeric consumed-hours result, not truthful demand charts or the rest of the implementation.

### Task 2: Retain availability and source history independently of snapshots

**Owner:** Sol (high); sole owner of the schema, migration and shared sync edits.

**Files:** Modify `src/lib/db/schema.ts` and `src/lib/sync/orchestrator.ts`; create `drizzle/0105_tutor_workforce_analytics.sql` and the matching journal entry (recheck the next migration number before writing), `workforce/observations.ts`, `workforce/observation-store.ts`, `workforce/source-db.ts`, and `workforce/__tests__/observations.test.ts`, `observations.integration.test.ts`, `source-db.integration.test.ts`. Here and below, `workforce/` means `src/lib/tutor-offboarding/workforce/`.

**Interfaces:** `captureWorkforceObservation(db: Database, input: WorkforceObservationInput): Promise<CaptureResult>`; `persistWorkforceSourceWindow(db: Database, window: SourceWindowResult): Promise<CaptureResult>`; `loadWorkforceEvidence(db: Database, query: WorkforceQuery, now: Date): Promise<WorkforceEvidence>`.

Use additive tables for capture runs/coverage, person observations and payload versions, session/tutor versions, session/student credit versions, and reviewed subject mappings. Keys are canonical person, Wise session, and Wise session/student as appropriate. Store source timestamps, normalized content hashes, quality and original source IDs. No foreign key may cascade from a pruned snapshot. Skip unchanged payload versions; record genuine A→B→A changes. Lightweight run/coverage records establish later observations without recopying every payload.

- [ ] Write tests asserting duplicate ingestion is idempotent, unchanged input does not add payload versions, A→B→A is retained, snapshot pruning leaves history intact, and a failed/partial capture cannot replace complete evidence or advance its coverage. Test one failed teacher without turning their missing qualifications or hours into zero.
- [ ] Run `npx vitest run --project unit src/lib/tutor-offboarding/workforce/__tests__/observations.test.ts` and the two named integration files with `--project integration`; confirm intended failures against a disposable database.
- [ ] Implement the additive schema and capture/load functions. Archive promoted roster observations before pruning; expose complete lesson/credit-window persistence for Task 3. Preserve raw credit semantics needed by Task 1, rather than copying only positive `creditApplied`. An archive failure must be recorded as an analytics gap without breaking the existing scheduling snapshot.
- [ ] Apply the migration in the disposable database and rerun these tests. Verify old readers still work and the loader chooses the latest complete evidence rather than an incomplete later attempt.
- [ ] Commit scoped schema/store/sync files as `feat: retain workforce observations and lesson evidence`.

### Task 3: Backfill lesson evidence and review academic subject mappings

**Owner:** Luna (high), with Sol reviewing persistence and credit provenance. Shared sync/schema changes are coordinated through Task 2's owner.

**Files:** Create `workforce/source-sync.ts`, `workforce/subject-mappings.ts`, `scripts/sync-tutor-workforce-history.ts`, `workforce/__tests__/source-sync.test.ts`, `subject-mappings.test.ts`, and `src/app/api/tutor-offboarding/analytics/workforce/mappings/route.ts` with its route test. Modify `src/lib/credit-control/sync.ts` to capture complete normalized evidence. Consume Task 2 stores without independently changing the migration.

**Interfaces:** `syncWorkforceHistory(input: HistorySyncRequest): Promise<HistorySyncResult>` uses explicit `from`, `to`, request caps, checkpoint and dry-run/apply mode. `resolveAcademicSubject(input: ClassIdentity, mappings: SubjectMapping[]): SubjectResolution`; `saveSubjectMapping(db: Database, input: ReviewedSubjectMapping, actorEmail: string): Promise<SubjectMapping>`.

- [ ] Write tests for a completed March window followed by a failed window (only the first advances), safe resume, corrected/refunded credits, historical participants differing from today's class roster, and confirmed zero versus missing evidence. Mapping tests assert exact class-ID precedence, reviewed exact aliases, ambiguous/unmapped outcomes and stale-edit rejection.
- [ ] Run the new unit tests and mapping route test; confirm intended failures.
- [ ] Implement the bounded backfill with at most two concurrent source requests, finite per-run request caps and stop-on-rate-limit behavior. Persist completed windows independently; retain incomplete-window diagnostics. Default the CLI to dry-run and require `--apply` for its own database writes. Continue later observations through the existing sync integration; preserve per-month source observation times for older facts.
- [ ] Implement the local mapping review API with `requireTutorOffboardingAdmin()`, server-derived reviewer identity and expected-revision checks. Never infer a discipline from a pricing/year band or a tutor's skill list. A changed class label requires review before a stale mapping is silently treated as current.
- [ ] Rerun tests and a capped dry run. Require a report of coverage, unmapped hours, missing participants, normal-charge evidence and refund semantics; do not declare the entire March period complete from a sample.
- [ ] Commit as `feat: backfill workforce facts and review subject mappings`.

### Task 4: Calculate turnover, shared capacity and credit consumption

**Owner:** Sol (high), independently reviewed by Sol.

**Files:** Create `workforce/credits.ts`, `workforce/turnover.ts`, `workforce/intervals.ts`, `workforce/capacity.ts`, `workforce/aggregate.ts`, `workforce/service.ts`, and matching `__tests__/credits.test.ts`, `turnover.test.ts`, `capacity.test.ts`, `aggregate.test.ts`, `service.test.ts`.

**Interfaces:** `computeConsumedMinutes(session: WorkforceSession, credits: StudentCreditEvidence[]): WorkforceMetric`; `buildTurnoverMonths(evidence: WorkforceEvidence, query: WorkforceQuery, now: Date): WorkforceMonth[]`; `buildCapacity(evidence: WorkforceEvidence, query: WorkforceQuery, now: Date): CapacityResult`; `buildWorkforceReport(evidence: WorkforceEvidence, query: WorkforceQuery, now: Date): WorkforceReport`; `getWorkforceReport(db: Database, query: WorkforceQuery, now: Date): Promise<WorkforceReport>`; `getWorkforceDrilldown(db: Database, query: WorkforceDrilldownQuery, now: Date): Promise<WorkforceDrilldown>`.

- [ ] Write calculation tests with exact expectations: `3/60 = 5%`; `3/(8-2) = 50%`; `10/8 = 125%`; a 60-minute class with fractions `[1, 0.5]` consumes `45` minutes; five fully charged students consume `60`, not `300`. One missing participant/normal charge makes consumed minutes unknown. Test equal averaging when students have different prices, verified full refunds, confirmed free classes, charged cancellations and no-show exclusions from taught classes. Unexplained negative or over-expected net charges remain unknown rather than silently clamped.
- [ ] Add turnover tests for Bangkok month-start, duplicate online/onsite accounts, a join and departure in one month, pending future classes, teaching admins and missing join dates. Assert unknown departure dates are visible rather than invented. Teaching-admin evidence can be a teaching qualification, declared teaching availability or recorded teaching history, including someone awaiting their first class; retain uncertain classifications in quality output. Label roles reconstructed before role-history capture.
- [ ] Add interval/aggregation tests: eight shared hours minus one Physics hour leaves seven for Maths and Physics and seven overall; overlapping bookings block union time only; outside-hours work increases utilization; March missing availability stays unknown; partial-month numerators and denominators use the same coverage mask; four versus five Mondays produce the same average-week value for the same weekly pattern.
- [ ] Run the named Task 4 unit tests and confirm intended failures.
- [ ] Implement pure calculations and the database service. Use exact half-open intervals, Bangkok boundaries and 30-minute display buckets. Measured carry-forward ends at the earliest next observation, explicit error or **90 minutes** after the observation (three normal sync cycles); beyond that is unknown. Label future recurrence separately as projected. Count each distinct tutor/session once for hours, and each student once for overall student totals.
- [ ] Implement the approved recorded-teaching fallback and identity/subject exceptions. Use complete historical participant membership for the group mean; never drop unknown or zero-credit students. A confirmed free class with known zero normal and net credits has zero consumed hours; a missing normal charge remains unknown. Reserve non-cancelled bookings regardless of credit status, and keep all cancelled bookings in demand. Calculate shared capacity independently of the financial consumed-hours measure.
- [ ] Rerun the Task 4 tests and `npm run typecheck`; require exact arithmetic and explicit reasons for unavailable metrics. Commit as `feat: calculate workforce turnover and utilization`.

### Task 5: Serve authorized reports, drilldowns and matching CSV exports

**Owner:** Luna (medium), with Sol reviewing access and reconciliation.

**Files:** Create `workforce/query.ts`, `workforce/csv.ts`, their unit tests, and `src/app/api/tutor-offboarding/analytics/workforce/route.ts`, `drilldown/route.ts`, `export/route.ts` with route tests. Preserve the existing `/api/tutor-offboarding/analytics` contract.

**Interfaces:** `parseWorkforceQuery(params: URLSearchParams): WorkforceQuery`; `serializeWorkforceCsv(report: WorkforceReport, section: WorkforceExportSection): string`. Report and detail routes call Task 4 services; exports use the same calculated values, not a second implementation of the metrics.

- [ ] Write tests proving unauthorized requests never call the service; invalid dates/roles/filters return 400; missing data remains null with reasons; report, drilldown and CSV reconcile for one filtered fixture. A changed source/mapping revision must produce 409 for an old detail/export revision rather than mix totals. Assert CSV quotes/newlines are valid and formula-leading labels are neutralized. Assert no analytics route calls Wise or a removal service.
- [ ] Run `npx vitest run --project unit src/app/api/tutor-offboarding/analytics/workforce src/lib/tutor-offboarding/workforce/__tests__/query.test.ts src/lib/tutor-offboarding/workforce/__tests__/csv.test.ts`; confirm intended failures.
- [ ] Implement strict query parsing with the March history floor, ordered dates, valid month/filter enums and bounded drilldown pagination. Apply `requireTutorOffboardingAdmin()` before reads, use safe error responses and private/no-store responses. Include report revision, source time, coverage and units in detail/export payloads.
- [ ] Rerun the same tests and typecheck. Commit as `feat: expose workforce reports and exports`.

### Task 6: Build the MagicPath design and interactive Analytics tab

**Owner:** Sol (high). May begin the design after Task 1 freezes the report types, in parallel with backend tasks.

**Files:** Modify `src/components/tutor-offboarding/analytics-tab.tsx` and its existing tests; create `src/components/tutor-offboarding/workforce/` containing `dashboard.tsx`, `filters.tsx`, `turnover-chart.tsx`, `subject-matrix.tsx`, `week-heatmap.tsx`, `utilization-table.tsx`, `detail-drawer.tsx`, `quality-panel.tsx`, `requests.ts`, `fixtures.ts` and focused tests. Reuse the installed chart library and application tokens.

**Interfaces:** `WorkforceDashboard({ report, onQueryChange }: WorkforceDashboardProps)` where the props are `report: WorkforceReport` and `onQueryChange: (query: WorkforceQuery) => void`; chart/grid/table components receive the corresponding Task 1 report section and selection callbacks. `fetchWorkforceReport(query: WorkforceQuery, signal: AbortSignal): Promise<WorkforceReport>` and `fetchWorkforceDrilldown(query: WorkforceDrilldownQuery, signal: AbortSignal): Promise<WorkforceDrilldown>` consume Task 5 routes. Keep stale responses from replacing a newer filter selection; handle stale report revisions by refreshing the report before retrying detail/export.

- [ ] Read the local Next guides for server/client components and route handlers, the MagicPath skill, and the existing Analytics component/style patterns. Use the approved spec and synthetic fixtures that include missing history, partial credit, pending departures and 125% utilization.
- [ ] Create the MagicPath project and immediately open its canvas; check success before generating components through the code-session workflow. Produce the main dashboard, expanded subject view and tutor detail. Record returned project/component identifiers and inspect the build/preview. Do not create a `.magicpath` file or send production student/payment data to the design service.
- [ ] Write UI behavior tests for shared filter state, hierarchy expansion, cell/detail selection, unavailable versus zero, all three utilization labels, source-quality explanations, safe export and stale-request cancellation. Run the focused unit suite to confirm intended failures before binding the product components.
- [ ] Implement the design using existing Chart.js and brand tokens. Render workforce trends first, subject/month and average-week heat maps second, and individual utilization third. Keep fixed comparable color domains across selected months, visible units, accessible cell buttons and keyboard focus. Preserve the existing affected-course/offboarding context and owner removal controls.
- [ ] Implement the quality/mapping review drawer against Task 3 with reviewable class labels and unmapped hours. Wire the filters, drilldowns and exports to the report API; show the user's agreed formulas and coverage reasons without exposing implementation internals.
- [ ] Run the focused UI tests and typecheck, then inspect desktop/narrow layouts and all selections in the browser. Compare the rendered 45-minute group example and seven shared hours with their fixture/API values. Commit as `feat: redesign tutor workforce analytics`.

### Task 7: Integrate, verify and release the approved dashboard

**Owner:** Parent, with independent Sol review.

**Files:** Update `docs/features/tutor-offboarding.md`, `docs/reference/wise-api.md`, and the relevant database/API reference entries. Use the migration and scripts from Tasks 2–3 and the existing CI/deploy path; add no Wise write operation.

**Interfaces:** Consumes the completed report API, observation/source capture, UI and backfill commands. Produces a verified production revision and a concise private evidence report containing source coverage, checks, migration receipt and deployment identity.

- [ ] Review the complete diff against every spec acceptance example and the five Review Focus cases. Confirm no unrelated files or Wise mutation paths changed and fix actionable review findings in their owning modules.
- [ ] Run the new scoped unit/integration suites and existing offboarding, Wise normalization and sync regressions. Integration tests must use the disposable test database, never `.env.local`'s production database. Require the affected suites to pass.
- [ ] Run scoped ESLint, `npm run typecheck`, `npm test`, `npm run build`, `npm run typecheck`, `git diff --check`, and `npm run guard:production-route-surface`. Inspect failures and fix regressions; record unrelated blockers precisely rather than reporting green.
- [ ] Verify the actual interface in a browser at desktop and narrow widths: select month/role/subject, expand hierarchy, select heat-map cells, inspect a tutor, export CSV, and exercise keyboard focus. Reconcile chart totals against API/CSV examples, including unknown data, group 0.75 hours and 125% utilization. Check existing offboarding and removal authorization remains intact without performing a removal.
- [ ] Review generated SQL and apply only the additive workforce migration to the verified target before deploying dependent code. Inspect the migration journal first; do not run unrelated pending migrations opportunistically. Record schema read-back and retain the prior application deployment as the rollback target; do not delete historical rows as a rollback.
- [ ] Run the bounded initial history backfill after source contracts pass, preserving successful checkpoints. Import the saved 1 October baseline with its original observation time and evidence hash, then verify ongoing capture through the existing sync. Do not backdate later observations or claim the baseline filled intervening gaps.
- [ ] Push the feature branch, create and attach its PR, and complete required checks/reviews. Merge through the existing Git integration; do not run bare `vercel --prod` from this worktree. This uses the user's existing production-delivery authorization.
- [ ] Verify the production alias points to the merged revision, open the authenticated Analytics tab, check current API/CSV results, and confirm at least one post-deploy sync produced durable observations. Report observed history coverage and any still-unverified metric separately from deployment success.
- [ ] Commit documentation and verification fixes with explicit paths. Close out with the live URL, concise feature summary, checked revision, and any remaining source limitation.
