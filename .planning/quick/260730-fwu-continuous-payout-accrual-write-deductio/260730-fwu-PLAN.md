---
quick_id: 260730-fwu
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - drizzle/0061_payout_line_source_anchor.sql
  - drizzle/meta/_journal.json
  - src/lib/db/schema.ts
  - src/lib/post-class-feedback/payout-master.ts
  - src/lib/post-class-feedback/payout-repository.ts
  - src/lib/post-class-feedback/payout-run.ts
  - src/lib/post-class-feedback/auto-approval.ts
  - src/lib/post-class-feedback/payout-accrual.ts
  - src/app/api/internal/post-class-feedback/payout-accrual/route.ts
  - src/lib/data-health/cron-registry.ts
  - src/lib/post-class-feedback/__tests__/auto-approval.integration.test.ts
  - src/lib/post-class-feedback/__tests__/payout-accrual.integration.test.ts
  - src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts
  - src/lib/post-class-feedback/__tests__/migration.test.ts
  - docs/features/post-class-feedback.md
  - docs/reference/crons.md
autonomous: true
requirements:
  - P0-source-anchor-fingerprint
  - P1-auto-approval
  - P2-accrual-pass
  - P3-auto-finalize
  - P4-route-and-registry
  - P5-tests
  - P6-docs
source_plan: /Users/kevinhsieh/.claude/plans/deployment-phase-is-complete-structured-mochi.md
branch: feat/payout-accrual
worktree: /Users/kevinhsieh/Developer/bgscheduler-payout

must_haves:
  truths:
    - "A pending_review deduction whose session deadline is past the grace window, with enforcement live and source ready, becomes approved with no reviewer click"
    - "An approved-but-unwritten deduction that loses proof (session no longer eligible, or source no longer ready) is automatically reopened to pending_review, so unprovenApprovedDeductions stays 0"
    - "Invoking the accrual pass mid-window appends new deduction rows to the Feedback Deductions tab but the run status never becomes published, and csvStatus/csvFileId/csvAttemptedAt are left untouched"
    - "Invoking the finalize pass after the window has ended appends any remainder, uploads the CSV, and reaches published when coverage is clean"
    - "A written line whose source anchor fingerprint is no longer present in the raw grid opens one source_anchor_missing exception and blocks only that tutor's remaining lines this pass; other tutors keep appending"
    - "The existing manual /api/post-class-feedback/payout-runs publish endpoint behaves exactly as before (default operator mode, unchanged)"
    - "The new payout-accrual route is reachable only manually from Data Health (parked, dangerous, no vercel.json entry) -- nothing runs it on a schedule"
  artifacts:
    - path: "drizzle/0061_payout_line_source_anchor.sql"
      provides: "nullable source_anchor_fingerprint column on post_class_payout_run_lines"
    - path: "src/lib/post-class-feedback/payout-master.ts"
      provides: "computeSourceAnchorFingerprint, buildAnchorFingerprintIndex"
      exports: ["computeSourceAnchorFingerprint", "buildAnchorFingerprintIndex"]
    - path: "src/lib/post-class-feedback/payout-repository.ts"
      provides: "sourceAnchorFingerprint patch field, recordPayoutAnchorMissingException, skipCsv on finalizePayoutRunPass"
      exports: ["recordPayoutAnchorMissingException"]
    - path: "src/lib/post-class-feedback/payout-run.ts"
      provides: "fingerprint-based per-tutor quarantine in planDedicatedAppends; mode param on publishPayoutRun"
      exports: ["publishPayoutRun"]
    - path: "src/lib/post-class-feedback/auto-approval.ts"
      provides: "auto-approve + reopen sweep, driving applyPostClassReviewAction only"
      exports: ["runPostClassAutoApprovalSweep", "runPostClassAutoApprovals", "runPostClassAutoReopens"]
    - path: "src/lib/post-class-feedback/payout-accrual.ts"
      provides: "runPayoutAccrualPass, runPayoutFinalizePass"
      exports: ["runPayoutAccrualPass", "runPayoutFinalizePass"]
    - path: "src/app/api/internal/post-class-feedback/payout-accrual/route.ts"
      provides: "parked cron-secret-guarded GET route"
      exports: ["GET", "maxDuration"]
    - path: "src/lib/data-health/cron-registry.ts"
      provides: "parked post_class_feedback_payout_accrual registry entry"
  key_links:
    - from: "src/lib/post-class-feedback/payout-accrual.ts"
      to: "src/lib/post-class-feedback/auto-approval.ts"
      via: "runPayoutAccrualPass/runPayoutFinalizePass call runPostClassAutoApprovalSweep before previewing"
      pattern: "runPostClassAutoApprovalSweep"
    - from: "src/lib/post-class-feedback/payout-accrual.ts"
      to: "src/lib/post-class-feedback/payout-run.ts"
      via: "publishPayoutRun(..., { mode: \"accrual\" })"
      pattern: "mode:\\s*[\"']accrual[\"']"
    - from: "src/lib/post-class-feedback/auto-approval.ts"
      to: "src/lib/post-class-feedback/actions.ts"
      via: "applyPostClassReviewAction drives approve/reopen -- no direct postClassDeductions writes"
      pattern: "applyPostClassReviewAction"
    - from: "src/app/api/internal/post-class-feedback/payout-accrual/route.ts"
      to: "src/lib/data-health/cron-registry.ts"
      via: "jobKey post_class_feedback_payout_accrual, manualOnly true"
      pattern: "post_class_feedback_payout_accrual"
    - from: "src/lib/post-class-feedback/payout-run.ts"
      to: "src/lib/post-class-feedback/payout-master.ts"
      via: "planDedicatedAppends looks up written lines via buildAnchorFingerprintIndex instead of re-matching"
      pattern: "buildAnchorFingerprintIndex"
---

<objective>
Transcribe the already-approved plan at `source_plan` into an executable GSD plan. Ship continuous
payout accrual: deductions auto-approve and append to the master ledger as their feedback deadlines
pass (not in one burst after the 26th-25th window closes), the run finalizes itself once the window
ends, and the whole thing ships **parked** (manual-only, no `vercel.json` cron entry) behind the
existing `POST_CLASS_PAYOUT_WRITES_ENABLED` kill switch. The existing manual operator-publish path
(`/api/post-class-feedback/payout-runs`) and its UI are untouched.

This is a transcription-plus-sequencing job, not a design job -- every technical decision below was
already made and approved by the user in `source_plan`. Six pieces, one commit each, in build order:
Piece 0 (source-anchor fingerprint) unlocks Piece 2/3 (accrual/finalize); Piece 1 (auto-approval) is
called from inside Piece 2/3; Piece 4 (route/registry) wraps Piece 2/3; Tests and Docs close it out.

Purpose: remove the single-human-click load-bearing burst-write pattern on the payout money path,
while preserving every existing fail-closed rule (kill switch, finance lock, durable lease, source
fingerprint, append-only ledger, hard-blocking unproven-approved gate).

Output: migration + schema column, two new library modules (`auto-approval.ts`, `payout-accrual.ts`),
one modified library module (`payout-run.ts` gets a per-tutor quarantine + a `mode` param), one new
parked route, one new parked registry entry, 4 test files (2 new, 2 extended), 2 doc updates.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@/Users/kevinhsieh/.claude/plans/deployment-phase-is-complete-structured-mochi.md

Project conventions (already loaded as CLAUDE.md/AGENTS.md project instructions): named exports only,
kebab-case files, tests in sibling `__tests__/`, Zod `.safeParse` never `.parse`, `console.error` only,
all times Asia/Bangkok, design-decision-ID comments are load-bearing.
</context>

<interfaces>
<!-- Extracted from the current codebase. Executor should use these directly -- no exploration needed. -->

From `src/lib/post-class-feedback/payout-run.ts` (unchanged shapes reused by this plan):
```typescript
export interface PayoutRunDependencies {
  gateway?: MasterLedgerGateway;
  uploadCsv?: typeof uploadCsvToDrive;
  now?: () => number;
  resolveGoogleTarget?: (input: { forWrite: boolean }) => PayoutGoogleTarget;
}
export interface PayoutRunView {
  run: PayoutRun; runPersisted: boolean; window: PayoutRunWindow; previewToken: string;
  coverage: PayoutRunCoverage; lines: PayoutRunLineView[]; adjustments: PayoutAdjustment[];
  exceptions: PayoutException[]; policyVersion: number; csvError: string | null; stoppedEarly: boolean;
}
export async function previewPayoutRun(
  actor: PostClassUser, input: { anchorMonth: string; tutorFilter?: string | null }, db?: Database,
): Promise<PayoutRunView>;
export async function publishPayoutRun(
  actor: PostClassUser,
  input: {
    anchorMonth: string; previewToken: string; tutorFilter?: string | null;
    acknowledgements: PayoutPublishAcknowledgements; expectedVersion: number;
  },
  db?: Database, dependencies?: PayoutRunDependencies,
): Promise<PayoutRunView>;
```

From `src/lib/post-class-feedback/payout-plan.ts` (unchanged, reused as-is):
```typescript
export interface PayoutRunCoverage {
  eligibleSessions: number; readySessions: number; nonReadySessions: number;
  pendingReviewDeductions: number; unprovenApprovedDeductions: number; /* + more */
}
export interface PayoutPublishAcknowledgements {
  confirmed: true; pendingReviewDeductions: number; nonReadySessions: number; reason: string;
}
// HARD block, no override, on unprovenApprovedDeductions > 0 -- this is why the reopen sweep
// (Piece 1) must run before every accrual/finalize pass.
export function assertPayoutRunPublishable(coverage: PayoutRunCoverage, acknowledgements?: Partial<PayoutPublishAcknowledgements>): void;
```

From `src/lib/post-class-feedback/payout-window.ts` (unchanged, reused as-is):
```typescript
export function payoutRunWindowForBangkokDate(date: string): PayoutRunWindow; // 26->25 window containing `date`
export function payoutBangkokDate(value: Date): string; // instant -> Bangkok YYYY-MM-DD
```

From `src/lib/post-class-feedback/payout-repository.ts` (existing exports Piece 1/2/3 reuse verbatim):
```typescript
export async function hasWrittenPayoutDeduction(db: Database, deductionId: string): Promise<boolean>;
export async function assertPayoutWindowOpenForDeduction(db: Database, deductionId: string): Promise<void>;
// The exact (window-scoped) predicate the reopen sweep must mirror WITHOUT the inWindow filter --
// see computePayoutRunCoverage, payout-repository.ts:218-236 (status='approved', no offset row,
// eligible=false OR sourceStatus<>'ready').
```

From `src/lib/post-class-feedback/actions.ts` (Piece 1 drives this and nothing else):
```typescript
// Both interfaces are NOT exported -- pass a plain object literal, TS accepts it structurally.
interface Actor { email: string; name?: string; }
interface ReviewInput {
  deductionId: string; action: "approve" | "waive" | "reopen"; note: string;
  waiverCategory?: PostClassWaiverCategory; expectedVersion: number; idempotencyKey: string;
}
export async function applyPostClassReviewAction(actor: Actor, input: ReviewInput, db?: Database): Promise<PostClassDeduction>;
// approve requires current.status === "pending_review"; reopen requires "approved" AND
// !hasWrittenPayoutDeduction AND assertPayoutWindowOpenForDeduction AND a non-empty note.
```

From `src/lib/post-class-feedback/access.ts`:
```typescript
export interface PostClassUser { email: string; name: string; role: "admin"; capabilities: PostClassCapability[]; }
```

From `src/lib/internal/cron-auth.ts` and the backfill route (exact template for the new route):
```typescript
export function rejectInvalidCronSecret(request: NextRequest): NextResponse | null; // 401/500, constant-time
// src/app/api/internal/post-class-feedback-backfill/route.ts is the structural template:
// export const maxDuration = 800;
// GET: rejectInvalidCronSecret -> withCronInvocationAudit({ jobKey, triggerSource: "cron", requestMethod }, async () => {...})
```

From `src/lib/db/schema.ts` (enums already defined, reused as-is -- no enum changes in this plan):
```typescript
postClassSourceStatusEnum:     "ready" | "unavailable" | "form_drift" | "identity_review"
postClassDeductionStatusEnum:  "none" | "pending_review" | "approved" | "waived" | "processed" | "reversed"
postClassEnforcementModeEnum:  "shadow" | "live" | "paused"
// postClassSessions has: deadlineAt (timestamp, notNull), sourceStatus, enforcementMode, eligible (bool)
// postClassDeductions has: sessionId, status, version (int), financePeriodId, defaultFinanceMonth
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Piece 0 -- durable source-anchor fingerprint + per-tutor quarantine</name>
  <files>drizzle/0061_payout_line_source_anchor.sql, drizzle/meta/_journal.json, src/lib/db/schema.ts, src/lib/post-class-feedback/payout-master.ts, src/lib/post-class-feedback/payout-repository.ts, src/lib/post-class-feedback/payout-run.ts</files>
  <action>
Per D-EVT-01-style precedent in this codebase, preserve every nearby design-decision comment untouched.

1. **schema.ts** (`postClassPayoutRunLines`, ~line 3740-3788): add `sourceAnchorFingerprint: text("source_anchor_fingerprint"),` near `matchedRowNumber`/`insertedRowNumber` (nullable, no default, no new index).
2. **Generate the migration**: `npm run db:generate -- --name payout_line_source_anchor`. Confirm it lands as exactly `drizzle/0061_payout_line_source_anchor.sql` with only `ALTER TABLE "post_class_payout_run_lines" ADD COLUMN "source_anchor_fingerprint" text;` -- trim any unrelated catch-up statement (known Drizzle snapshot-drift issue in this repo; see `docs`/prior MEMORY notes) before treating it as done.
3. **payout-master.ts**:
   - Extend `MasterPayoutRow` with `rawDuration: unknown` and `rawCredits: unknown` (columns F/G); populate both in `parseMasterPayoutSheet` from `row[MASTER_COLUMNS.duration]` / `row[MASTER_COLUMNS.credits]` (today only rawDate/rawTime are retained -- the fingerprint needs the full A:H set).
   - Add `import { createHash } from "node:crypto";`.
   - Add exported `computeSourceAnchorFingerprint(row: MasterPayoutRow): string` -- hash `[teacherName, sessionName, studentName, rawDate, rawTime, rawDuration, rawCredits, payoutAmount]` via `createHash("sha256").update(JSON.stringify(cells), "utf8").digest("hex")`, prefixed `"payout-anchor:v1:"` (mirrors the `payout-preview:v1:` / `payout-source:v1:` prefix convention already in `payout-plan.ts`).
   - Add exported `buildAnchorFingerprintIndex(table: MasterPayoutTable): Map<string, MasterPayoutRow>` -- maps `computeSourceAnchorFingerprint(row) -> row` for every row where `!row.marker` (raw anchor rows only).
4. **payout-repository.ts**:
   - Add `sourceAnchorFingerprint?: string | null;` to `PayoutLineMatchPatch` (~line 1097).
   - Add new exported `recordPayoutAnchorMissingException(db: Database, input: { runId: string; deductionId: string; canonicalTutorKey: string | null; reason: string }): Promise<PayoutException>` that calls the existing internal `upsertPayoutExceptionRecord(db, { runId, deductionId, kind: "source_anchor_missing", reason })` -- same exported-wrapper-around-internal-helper pattern as `recordLateApprovalPayoutExceptionIfClosed` (~line 1443), which is the direct precedent (that function also wraps `upsertPayoutExceptionRecord` for a different `kind`).
5. **payout-run.ts**, inside `planDedicatedAppends` (~line 302-539):
   - Replace the `claimedRawRows`/`historicalAnchorError`/`needsNewRawAnchor` block (~345-378). Build `const fingerprintIndex = raw ? buildAnchorFingerprintIndex(raw) : null;` **unconditionally** (drop the `needsNewRawAnchor` gate entirely -- the point of this piece is an O(1) map lookup replacing an O(written-lines) search, so there is no longer a reason to skip it).
   - Iterate `input.sourceLines.filter(line => line.writeStatus === "written")` once, building `const claimedRawRows = new Set<number>()` and `const quarantinedTutors = new Map<string, string>()` (canonicalTutorKey -> reason):
     - Fingerprint set and found in `fingerprintIndex` -> `claimedRawRows.add(row.rowNumber)`.
     - Fingerprint set but not found -> if `sourceLine.canonicalTutorKey` is non-null and not already quarantined: set the reason (`` `Written payout line ${sourceLine.rowSignature} anchor is no longer present in the source tab.` ``) into `quarantinedTutors`, and call `recordPayoutAnchorMissingException(input.db, { runId: input.runId, deductionId: sourceLine.deductionId, canonicalTutorKey: sourceLine.canonicalTutorKey, reason })`.
     - Fingerprint is `null` (pre-migration row) -> fall back to today's individual `matchMasterRow` re-match (same call shape, using `claimedRawRows` accumulated so far) to reserve its row; on non-match, quarantine that line's tutor the same way as above instead of aborting the whole pass.
   - In the main `for (const line of input.lines)` loop, replace the old blanket `if (historicalAnchorError) { ...fail every pending line... }` (~427-439) with a per-line check: if `line.canonicalTutorKey` is in `quarantinedTutors`, call `failDeductionLine(..., matchStatus: "ambiguous", kind: "source_anchor_missing", reason: quarantinedTutors.get(line.canonicalTutorKey)!, spreadsheetId: input.target.masterSpreadsheetId, sheetName: input.target.sourceSheetName)` and `continue`. Every other tutor's lines fall through to the unchanged `matchMasterRow` matching logic.
   - In the success branch where a fresh anchor is matched and `markPayoutLine(...)` records `matchedRowNumber` (~467-479), add `sourceAnchorFingerprint: computeSourceAnchorFingerprint(match.row)` to that same patch so the *next* pass has a fingerprint once this line becomes `written`.
   - Import `buildAnchorFingerprintIndex`, `computeSourceAnchorFingerprint` from `./payout-master` and `recordPayoutAnchorMissingException` from `./payout-repository`.

**Net effect (must match `source_plan` exactly):** one drifted anchor now quarantines only its own tutor for this pass, not every pending line in the run; the close/publish gate is unchanged (an open exception still forces `partial` and still blocks the roll CLI's strict-close preflight).
  </action>
  <verify>
    <automated>npx tsc --noEmit && npx vitest run --project integration src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts</automated>
  </verify>
  <done>Migration, schema column, and payout-master.ts helpers exist; `planDedicatedAppends` claims already-written rows via O(1) fingerprint lookup (re-match only as a null-fingerprint fallback); a missing anchor opens exactly one `source_anchor_missing` exception per affected tutor and blocks only that tutor's pending lines; the existing `payout-run.integration.test.ts` suite still passes unmodified; one commit for this piece.</done>
</task>

<task type="auto">
  <name>Task 2: Piece 1 -- auto-approval and reopen sweep</name>
  <files>src/lib/post-class-feedback/auto-approval.ts</files>
  <action>
New file. Writes **no** approval logic of its own -- every state change is driven through the existing
`applyPostClassReviewAction` (`./actions.ts:558`), which already does the finance lock, version check,
`revalidateDeductionCandidate`, `assertApprovalPeriodOpen`, idempotency, and the audit-row insert.

1. Grace window: read inline `Number(process.env.POST_CLASS_AUTO_APPROVE_GRACE_HOURS ?? 24)` (matches this repo's established pattern of reading feature flags directly at point of use, e.g. `payout-config.ts`; no central `env.ts` entry needed).
2. System actor: a plain object literal, `{ email: "system:post-class-auto-approve", name: "Post-class Auto-Approval" }`, matching `actions.ts`'s unexported `Actor` shape structurally (no import needed) -- follows the established `"system:post-class-feedback"` naming convention (`repository.ts:1612` etc.).
3. `export async function runPostClassAutoApprovals(db: Database = getDb(), now: Date = new Date()): Promise<{ approved: number; failed: number }>` -- select `postClassDeductions` joined to `postClassSessions` where `status = 'pending_review'`, `enforcementMode = 'live'`, `sourceStatus = 'ready'`, `deadlineAt <= now - graceHours`. For each candidate call `applyPostClassReviewAction(SYSTEM_ACTOR, { deductionId, action: "approve", note: "Automated approval after the grace period.", expectedVersion: <the selected row's version>, idempotencyKey: \`auto-approve:${deductionId}\` }, db)` inside try/catch -- log with `console.error` and continue to the next candidate on any error (one bad row must never abort the sweep); tally counts.
4. `export async function runPostClassAutoReopens(db: Database = getDb()): Promise<{ reopened: number; failed: number }>` -- select `approved` deductions (no date/window filter -- this is a global safety sweep, not scoped to one payout run) where there is no `postClassDeductionOffsets` row and (`postClassSessions.eligible = false` OR `sourceStatus <> 'ready'`) -- mirror the exact predicate in `computePayoutRunCoverage`'s `unprovenApproved` query (`payout-repository.ts:218-236`) but **without** its `inWindow` filter. Skip any candidate where `hasWrittenPayoutDeduction(db, id)` is true (reopen only ever applies to not-yet-written rows -- `applyPostClassReviewAction`'s reopen branch already refuses a written one, this is just a pre-filter to avoid a guaranteed-failing call). For the rest, call `applyPostClassReviewAction(SYSTEM_ACTOR, { deductionId, action: "reopen", note: "Automated reopen: proof lost before the payout write.", expectedVersion, idempotencyKey: \`auto-reopen:${deductionId}\` }, db)` with the same tolerant try/catch.
5. `export async function runPostClassAutoApprovalSweep(db: Database = getDb(), now: Date = new Date()): Promise<{ approved: number; approveFailed: number; reopened: number; reopenFailed: number }>` -- runs the reopen sweep **first**, then auto-approve, and returns both tallies. This is the single entry point Piece 2/3 calls; reopen-before-approve matters because a deduction reopened this tick must not simultaneously be a stale "approved" row elsewhere.

Imports: `getDb`, `type Database` from `@/lib/db`; `* as schema` from `@/lib/db/schema`; `and, eq, isNull, lte, ne, or` from `drizzle-orm`; `applyPostClassReviewAction` from `./actions`; `hasWrittenPayoutDeduction` from `./payout-repository`.
  </action>
  <verify>
    <automated>npx tsc --noEmit && npx vitest run --project unit</automated>
  </verify>
  <done>`auto-approval.ts` exists, exports `runPostClassAutoApprovalSweep` (plus the two underlying sweeps), never writes to `postClassDeductions`/`postClassDeductionActions` directly -- only via `applyPostClassReviewAction`; typecheck and the full unit suite pass; one commit for this piece.</done>
</task>

<task type="auto">
  <name>Task 3: Pieces 2+3 -- accrual mode, skipCsv, and the accrual/finalize passes</name>
  <files>src/lib/post-class-feedback/payout-run.ts, src/lib/post-class-feedback/payout-repository.ts, src/lib/post-class-feedback/payout-accrual.ts</files>
  <action>
Depends on Task 1 (fingerprint-aware `planDedicatedAppends`) and Task 2 (`runPostClassAutoApprovalSweep`).

1. **payout-repository.ts** -- `finalizePayoutRunPass` (~line 1223): add `skipCsv?: boolean` to its input. When `true`, the `.set({...})` (~1279-1294) must **not** touch `csvStatus`/`csvFileId`/`csvUrl`/`csvError`/`csvAttemptedAt` at all -- conditionally spread them in exactly like the existing `status === "published"` block does for `publishedByEmail`/`publishedAt`: `...(input.skipCsv ? {} : { csvStatus: input.csvFileId ? "uploaded" : "failed", csvFileId: input.csvFileId, csvUrl: input.csvUrl, csvError: input.csvError?.slice(0,500) ?? null, csvAttemptedAt: now })`.
2. **payout-run.ts** -- `publishPayoutRun` (~line 640): add `mode?: "operator" | "accrual"` to its input, defaulting to `"operator"` everywhere it is read, so `src/app/api/post-class-feedback/payout-runs/route.ts` (which never passes `mode`) is byte-for-byte unchanged.
   - Window-ended guard (~line 667): skip entirely when `mode === "accrual"`.
   - `forcePartial` passed into `finalizePayoutRunPass` (~line 881): `mode === "accrual" && payoutBangkokDate(operationNow) <= window.windowEnd ? true : (!acquired.selectionComplete || stoppedEarly)`. This is what makes an in-window accrual pass mathematically unable to ever mint `published`.
   - CSV: when `mode === "accrual"`, skip the whole CSV leg -- do not call `uploadPayoutCsv`, do not run either `assertPayoutGoogleAccess({ drive: true, ... })` check (both the pending-work branch ~852-858 and the zero-obligation branch ~837-843 are Drive-gated today), and call `finalizePayoutRunPass` with `skipCsv: true, csvFileId: null, csvUrl: null, csvError: null`. Sheets access (`{ sheets: true }`) is unchanged -- accrual still reads/appends the ledger, only the Drive/CSV leg is skipped. This is deliberate: uploading and then discarding the CSV would still burn ~700 Drive writes/month, which is exactly what this piece exists to avoid.
   - When `mode` is omitted/`"operator"`, every one of the above is a no-op -- current behavior is identical.
3. New **src/lib/post-class-feedback/payout-accrual.ts**:
   - `const SYSTEM_ACTOR: PostClassUser = { email: "system:post-class-payout-accrual", name: "Post-class Payout Accrual", role: "admin", capabilities: ["viewer","reviewer","finance","access_manager"] };` (`import type { PostClassUser } from "./access";`).
   - `export async function runPayoutAccrualPass(db: Database = getDb(), dependencies: PayoutRunDependencies = {}, now: Date = new Date()): Promise<{ skipped: string } | PayoutRunView>`:
     a. `await runPostClassAutoApprovalSweep(db, now);` **first** -- `publishPayoutRun`/`previewPayoutRun` only ever select `status = 'approved'` deductions, so nothing is writable until this runs; it is also the concrete mechanism that keeps `assertPayoutRunPublishable`'s hard, non-overridable `unprovenApprovedDeductions` gate (`payout-plan.ts:95`) at 0 every tick.
     b. `const window = payoutRunWindowForBangkokDate(payoutBangkokDate(now));`
     c. `const view = await previewPayoutRun(SYSTEM_ACTOR, { anchorMonth: window.anchorMonth, tutorFilter: null }, db);`
     d. Tolerated no-op: if every line in `view.lines` is already `persisted` with `writeStatus === "written"` and there are no unwritten `view.adjustments`, return `{ skipped: "nothing-pending" }` without acquiring a lease.
     e. Acknowledgements echoing the exact preview coverage: `{ confirmed: true, pendingReviewDeductions: view.coverage.pendingReviewDeductions, nonReadySessions: view.coverage.nonReadySessions, reason: "Scheduled payout accrual pass." }`.
     f. `try { return await publishPayoutRun(SYSTEM_ACTOR, { anchorMonth: window.anchorMonth, previewToken: view.previewToken, acknowledgements, expectedVersion: view.run.version, mode: "accrual" }, db, dependencies); } catch (error) { if (error instanceof PostClassConflictError) { console.error("[payout-accrual]", error.message); return { skipped: error.message }; } throw error; }` -- a `PostClassConflictError` here is exactly "source sync holds its lane" / "lease held" / "stale token or version" (all thrown inside `acquirePayoutRunLease`); any other error type must propagate, not be swallowed.
   - `export async function runPayoutFinalizePass(db: Database = getDb(), dependencies: PayoutRunDependencies = {}, now: Date = new Date()): Promise<{ skipped: string } | PayoutRunView>`:
     a. `const window = payoutRunWindowForBangkokDate(payoutBangkokDate(now));` -- if `payoutBangkokDate(now) <= window.windowEnd`, return `{ skipped: "window-not-ended" }` immediately.
     b. `await runPostClassAutoApprovalSweep(db, now);` (same precondition as accrual).
     c. Preview + acknowledgements exactly as in `runPayoutAccrualPass`, reason `"Scheduled payout finalize pass."`.
     d. `publishPayoutRun(SYSTEM_ACTOR, { anchorMonth: window.anchorMonth, previewToken: view.previewToken, acknowledgements, expectedVersion: view.run.version }, db, dependencies)` -- **no `mode` argument**, so this reaches `published` (when coverage is clean) with CSV enabled exactly like today's manual publish. By the time this runs, `payoutBangkokDate(now) > windowEnd` is already true, so the unmodified operator-mode window-guard does not block it -- no new `mode` value is needed for finalize. Same `PostClassConflictError` tolerance as accrual. A source-fingerprint race against the hourly external refresh naturally yields `status: "partial"` from the existing `finalizePayoutRunPass` logic -- nothing new to write for that case.

Import `runPostClassAutoApprovalSweep` from `./auto-approval`; `previewPayoutRun`, `publishPayoutRun`, `type PayoutRunDependencies`, `type PayoutRunView` from `./payout-run`; `payoutRunWindowForBangkokDate`, `payoutBangkokDate` from `./payout-window`; `PostClassConflictError` from `./errors`; `getDb`, `type Database` from `@/lib/db`.
  </action>
  <verify>
    <automated>npx tsc --noEmit && npx vitest run --project integration src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts</automated>
  </verify>
  <done>`publishPayoutRun` takes an optional `mode`; default-mode behavior is provably unchanged (existing integration suite still green); an in-window accrual pass cannot set `published` and never touches CSV fields; `payout-accrual.ts` exists exporting both pass functions, each running the Piece 1 sweep first; one commit for this piece.</done>
</task>

<task type="auto">
  <name>Task 4: Piece 4 -- parked route and cron registry entry</name>
  <files>src/app/api/internal/post-class-feedback/payout-accrual/route.ts, src/lib/data-health/cron-registry.ts</files>
  <action>
1. New route, structured exactly like `src/app/api/internal/post-class-feedback-backfill/route.ts`:
   - `export const maxDuration = 800;`
   - `export async function GET(request: NextRequest)`: `const rejection = rejectInvalidCronSecret(request); if (rejection) return rejection;` then `return withCronInvocationAudit({ jobKey: "post_class_feedback_payout_accrual", triggerSource: "cron", requestMethod: request.method }, async () => { ... });`
   - Inside: `const accrual = await runPayoutAccrualPass();` then `const finalize = await runPayoutFinalizePass();` (safe to call unconditionally every invocation -- it internally no-ops with `{ skipped: "window-not-ended" }` before the window ends, which is exactly "runs accrual, then finalize if the window has ended"). Return `NextResponse.json({ ok: true, accrual, finalize })`; catch unexpected errors -> `NextResponse.json({ error: "Post-class payout accrual failed" }, { status: 500 })`, matching the backfill route's catch shape.
2. **cron-registry.ts**:
   - Add `"post_class_feedback_payout_accrual"` to the `CronJobKey` union (~line 3-23).
   - Add a new `CRON_JOBS` entry next to the other parked post-class-feedback jobs (~line 231, before `leave_requests`):
     ```typescript
     {
       key: "post_class_feedback_payout_accrual",
       label: "Payout Accrual (parked)",
       feature: "Class Feedback",
       path: "/api/internal/post-class-feedback/payout-accrual",
       schedule: null,
       cadenceLabel: "Parked — no cron",
       cadenceMinutes: null,
       lateAfterMinutes: 0,
       maxDurationSeconds: 800,
       manualOnly: true,
       dangerous: true,
       confirmationLabel: "Appends real payout deductions to the master ledger.",
       routeMethod: "GET",
     },
     ```
   - Do **not** touch `vercel.json` -- confirmed no entry exists today; none should be added. `SCHEDULED_CRON_JOBS` (`CRON_JOBS.filter(job => !job.manualOnly)`) automatically excludes this entry, so `src/lib/data-health/__tests__/cron-registry.test.ts`'s scheduled-vs-`vercel.json` cross-check is unaffected (same reason the 3 existing parked post-class-feedback jobs and `room_utilization`/`line_backlog_recovery` don't break it).
  </action>
  <verify>
    <automated>npx tsc --noEmit && npx vitest run --project unit src/lib/data-health/__tests__/cron-registry.test.ts</automated>
  </verify>
  <done>New route exists, auth-gated identically to sibling internal routes, runs accrual then (conditionally) finalize; registry entry present with `manualOnly: true, dangerous: true, schedule: null`; `vercel.json` untouched; existing `cron-registry.test.ts` still passes; one commit for this piece.</done>
</task>

<task type="auto">
  <name>Task 5: Tests -- auto-approval, accrual, anchor fingerprint, finalize</name>
  <files>src/lib/post-class-feedback/__tests__/auto-approval.integration.test.ts, src/lib/post-class-feedback/__tests__/payout-accrual.integration.test.ts, src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts, src/lib/post-class-feedback/__tests__/migration.test.ts</files>
  <action>
Both new files need real Postgres (they exercise `withPostClassTransaction`/`lockPostClassFinance`'s
`pg_advisory_xact_lock`, which the neon-http fake cannot satisfy) -- follow `payout-run.integration.test.ts`'s
exact harness: `vi.mock("server-only", () => ({}))` at the top, `startTestDb`/`stopTestDb`/`truncateAll`
from `@/tests/integration/db-helper`, matching `beforeAll`/`afterAll`/`beforeEach`, and its
`dateSerial`/`timeSerial`/`fakeGateway` helpers wherever a Sheets gateway is needed.

1. **auto-approval.integration.test.ts** (new) -- per `source_plan`'s Tests section:
   - approves a past-deadline proven violation (`deadlineAt` older than the grace window, `enforcementMode: "live"`, `sourceStatus: "ready"`, deduction `status: "pending_review"`);
   - skips a deduction still inside the grace window;
   - skips a non-`ready` source;
   - reopens an `approved` deduction that lost proof (session `eligible: false` or `sourceStatus` no longer `ready`) back to `pending_review`;
   - re-running the sweep is a no-op (the per-deduction idempotency key prevents a duplicate action row -- assert `postClassDeductionActions` count does not grow on a second identical run).
2. **payout-accrual.integration.test.ts** (new):
   - `runPayoutAccrualPass` appends in-window (mid-window `now`, one clean approved+ready deduction lands as a `written` line);
   - never sets `published` in-window even when every obligation completes this pass (assert `run.status === "partial"`);
   - never touches `csvStatus`/`csvFileId`/`csvAttemptedAt` across repeated in-window passes (assert they stay at their pre-pass values, including the initial `"pending"`/`null`/`null` draft state);
   - skips cleanly (returns `{ skipped: ... }`, never throws) when a `post_class_sync_runs` row is `status: "running"`, when a lease is already held by another actor, and when nothing is pending;
   - `runPayoutFinalizePass` reaches `published` once `now` is past `windowEnd` and coverage is clean, with the CSV path exercised via an injected fake `uploadCsv`/gateway (same DI shape as `payout-run.integration.test.ts`'s `fakeGateway`).
3. **payout-run.integration.test.ts** (extend) -- anchor-fingerprint behavior from Task 1:
   - a written line whose persisted `sourceAnchorFingerprint` is no longer present in the raw grid (simulate: finance deleted/edited that row before the next pass) opens exactly one `source_anchor_missing` exception and quarantines only that tutor's pending lines this pass;
   - a different tutor's pending line in the same pass still gets appended normally;
   - a written line with a `null` `sourceAnchorFingerprint` (simulating a pre-migration row) still falls back to today's `matchMasterRow` re-match path and succeeds when its anchor is findable.
4. **migration.test.ts** (extend) -- add a `readFileSync` for `drizzle/0061_payout_line_source_anchor.sql` (same pattern as the existing `durablePayoutMigration` constant for `0060`) and assert it contains `"source_anchor_fingerprint"`.
  </action>
  <verify>
    <automated>npm run test:integration && npm test</automated>
  </verify>
  <done>All four new/extended suites exist and pass; `npm test` (unit project) and `npm run test:integration` are both green; one commit for this piece.</done>
</task>

<task type="auto">
  <name>Task 6: Docs -- post-class-feedback.md and crons.md</name>
  <files>docs/features/post-class-feedback.md, docs/reference/crons.md</files>
  <action>
1. **docs/features/post-class-feedback.md**:
   - Rewrite the "routine run" paragraph at lines 215-219 (currently opens "A routine run selects approved, unprocessed deductions whose session ended inside the closed window...") to also describe the parked accrual path: deductions can now accrue continuously during an *open* window too, auto-approved at the deadline (grace period, `enforcementMode: "live"`, `sourceStatus: "ready"`) and appended under `mode: "accrual"`, which can never reach `published` until the window closes; the manual/operator publish path described in the rest of this section is unchanged.
   - Update the run-states table at lines 295-307: the `partial` row should also name "an in-window accrual pass" as a cause (alongside canary/time-bounded/mixed outcome); the `published` row should note it is reached either by the existing manual publish or by the automatic post-window finalize pass.
2. **docs/reference/crons.md**:
   - Add a new subsection immediately after "### Parked routes -- digest and tutor reminders" (~lines 158-160), following that exact section's structure and tone: name the new route (`/api/internal/post-class-feedback/payout-accrual`), state it is parked (`manualOnly: true`, `dangerous: true`, no `vercel.json` entry, runnable on demand from Data Health), and describe in one or two sentences what it does (runs the Piece 1 auto-approve/reopen sweep, then the in-window accrual pass or the post-window finalize pass).
   - Add a row to the `GET`/`POST` table (~lines 66-81): `| post-class-feedback/payout-accrual | yes | no | n/a -- parked, no cron entry |`.
   - Do **not** add a row to the numbered `vercel.json`-mirroring table at lines 15-31 -- parked jobs never appear there (matching the 3 existing parked entries).
  </action>
  <verify>
    <automated>grep -c "payout-accrual" docs/reference/crons.md docs/features/post-class-feedback.md</automated>
  </verify>
  <done>Both docs describe the shipped-but-parked accrual behavior accurately; neither claims it runs on a schedule; one commit for this piece.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|--------------|
| Cron/manual caller -> new route | `/api/internal/post-class-feedback/payout-accrual`, guarded only by `CRON_SECRET` bearer (no session layer, matching every other `/api/internal/**` route) |
| App -> Google Sheets/Drive | Accrual/finalize passes write real, money-moving rows to the app-owned `Feedback Deductions` tab |
| Auto-approval system actor -> deduction state machine | Bypasses human review for `approve`/`reopen` transitions |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-260730-01 | Spoofing | `payout-accrual/route.ts` | mitigate | `rejectInvalidCronSecret` constant-time bearer check, identical to every sibling internal route; no new auth surface introduced |
| T-260730-02 | Tampering | `publishPayoutRun` accrual mode | mitigate | Reuses unmodified `previewToken`/`expectedVersion` CAS checks inside `acquirePayoutRunLease` -- a stale/forged acknowledgement still fails closed exactly as it does today for the operator path |
| T-260730-03 | Repudiation | `auto-approval.ts` system actor | mitigate | Every auto-approve/reopen goes through `applyPostClassReviewAction`, which inserts an audited `postClassDeductionActions` row with `actorEmail: "system:post-class-auto-approve"` and a stable idempotency key -- same audit trail shape as every human reviewer action |
| T-260730-04 | Information Disclosure | new route response | accept | Response is a generic `{ ok, accrual, finalize }` status envelope; no new PII or financial detail surfaced beyond what `publishPayoutRun`'s existing return shape already contains |
| T-260730-05 | Denial of Service | accrual pass run hourly | mitigate | Reuses the unmodified 1.1s Sheets rate gate and deadline-bounded append loop (`payout-writer.ts`, untouched) plus `maxDuration = 800`, matching every sibling internal sync route |
| T-260730-06 | Elevation of Privilege | auto-approval bypasses human review | mitigate | 24h grace window (`POST_CLASS_AUTO_APPROVE_GRACE_HOURS`), `sourceStatus: "ready"` requirement, mandatory reopen-on-proof-loss sweep before every pass, `POST_CLASS_PAYOUT_WRITES_ENABLED` kill switch unchanged, and the whole feature ships parked (no schedule) until enforcement is observed live -- per `source_plan`'s own "Tradeoffs to accept" #4, this is explicitly the highest-risk surface in the design and is deliberately not fully eliminated, only bounded |
</threat_model>

<verification>
1. `npx tsc --noEmit` after every task -- zero new type errors.
2. `npm test` (unit project) -- must stay green (explicit constraint for this quick task).
3. `npm run test:integration` -- the 2 new + 2 extended suites, plus the untouched existing integration suites, must all pass.
4. `grep -c "payout-accrual"` on both touched doc files -- non-zero.

**Not automated by this plan (manual rollout gates from `source_plan`'s own Verification section --
these require a live scratch Google Sheets target and real `CRON_SECRET`/OAuth credentials this
executor does not have, and are properly a post-merge rollout step, not part of shipping the code
parked):**
- Apply `0061` to a scratch database and run the new suites against it there.
- Against `POST_CLASS_PAYOUT_TARGET=scratch`, `POST_CLASS_PAYOUT_WRITES_ENABLED=true` (local only),
  invoke the route with `CRON_SECRET` and inspect the scratch workbook (rows land in
  `Feedback Deductions`, dates are serials not strings, the composite `QUERY` picks them up).
- Invoke the same route a second time with no data change -- zero new rows, all lines already
  `written` (marker-idempotency proof).
- Confirm production stays unchanged while parked: no cron entry, reachable only from Data Health with
  the dangerous-job confirmation.
</verification>

<success_criteria>
- [ ] All 6 tasks complete, one commit each, in the order written
- [ ] `npm test` passes
- [ ] `npm run test:integration` passes
- [ ] `npx tsc --noEmit` clean
- [ ] Existing `/api/post-class-feedback/payout-runs` route and its integration tests are behaviorally unchanged (no `mode` passed, defaults preserve current behavior)
- [ ] No `vercel.json` changes
- [ ] `POST_CLASS_PAYOUT_WRITES_ENABLED` remains the only kill switch gating any real write
- [ ] Every design-decision-ID comment near edited code (payout-run.ts, payout-repository.ts, actions.ts) is preserved
</success_criteria>

<output>
After completion, create `.planning/quick/260730-fwu-continuous-payout-accrual-write-deductio/260730-fwu-SUMMARY.md`
</output>

## Planner Concerns

None of these are disagreements with the approved plan -- `source_plan` is prose describing an
approach, and these are the interpretations required to turn it into executable, internally-consistent
code without contradicting any of its explicit sentences. Flagging per the transcription instructions:

1. **Sweep placement.** `source_plan` says "the reopen sweep must run before every accrual pass" but
   describes Piece 4's route as only "runs accrual, then finalize." I concluded the sweep must live
   *inside* `runPayoutAccrualPass`/`runPayoutFinalizePass` themselves (not the route), because
   `publishPayoutRun` only ever selects `status = 'approved'` deductions -- without the sweep running
   first, accrual would have nothing to write. This is necessary, not optional, given the plan's own
   stated mechanics.
2. **Finalize's `mode`.** Piece 2's text ties "skip the CSV" to `mode: "accrual"`, but Piece 3 explicitly
   wants CSV enabled for finalize. I resolved this by having `runPayoutFinalizePass` call
   `publishPayoutRun` in **default** (`"operator"`) mode, not `"accrual"` mode -- since finalize only
   ever runs after `windowEnd`, the unmodified operator-mode window-guard never blocks it anyway, so no
   new mode value is needed there. Only the in-window accrual path needs the new branch.
3. **Fingerprint scope.** `source_plan` says the fingerprint hashes "the anchor's A:H cells from
   MasterPayoutRow," but `MasterPayoutRow` today only retains a subset of those 8 columns (missing
   duration/credits). Task 1 extends `MasterPayoutRow` to retain all 8 so the fingerprint is faithful
   to "A:H" as literally specified, rather than silently hashing a smaller subset.
4. **Test file layout.** `source_plan` calls the Tests section "new suites... matching existing layout."
   I read this as 2 genuinely new files (auto-approval, accrual/finalize -- brand-new modules with no
   existing home) plus extending 2 existing files (`payout-run.integration.test.ts` for the anchor-
   fingerprint behavior, since that's a change to a function already tested there; `migration.test.ts`
   for the new column, following its own established per-migration-file pattern) rather than 4 wholly
   new files.
5. **`npm test` alone will not exercise any of this new behavior.** `vitest.config.ts`'s `unit` project
   explicitly excludes `*.integration.test.ts`, and every new/extended suite here needs real Postgres
   (`pg_advisory_xact_lock` via `withPostClassTransaction`) so it cannot be a plain unit test. `npm test`
   is honored as the literal constraint for this task, but `npm run test:integration` is the one that
   actually proves any of Pieces 0-3 work -- both are listed as required verification above.
