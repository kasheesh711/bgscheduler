---
phase: quick-260929-lnu
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/unearned-revenue/sync.ts
  - src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts
  - src/lib/competitor-intelligence/sync.ts
  - src/lib/competitor-intelligence/__tests__/sync-guard.test.ts
  - src/app/api/competitor-intelligence/sync/__tests__/route.test.ts
  - src/lib/sales-dashboard/import-guard.ts
  - src/lib/sales-dashboard/data.ts
  - src/components/sales-dashboard/sales-dashboard-shell.tsx
  - src/lib/sales-dashboard/__tests__/import-guard.test.ts
autonomous: true
requirements:
  - SFG-UR-STALE-LEASE
  - SFG-UR-BLOCKING-RUN-ID
  - SFG-CI-RACE-ALREADY-RUNNING
  - SFG-SD-PROJECTION-SINGLE-FLIGHT
  - SFG-SD-SKIPPED-UI
quick_id: 260929-lnu
branch: fix/single-flight-guard-deviations
base: "origin/main 5725829 + quick 260929-jy4 (fix/drizzle-unique-violation-cause, tip 222e2e3 = code commits f901757+0a27171 + docs commit 222e2e3)"
worktree: /Users/kevinhsieh/Developer/Scheduling-single-flight-guards

must_haves:
  truths:
    - "A running row in unearned_revenue_sync_runs older than 20 minutes is marked failed at the start of the next unearned-revenue run, which then proceeds under a fresh run id (a timeout-killed run can no longer make every later daily run skip forever)"
    - "An unearned-revenue run skipped because another run holds the slot returns ok:true, skipped:true, alreadyRunning:true, syncRunId = the BLOCKING run id, runningStartedAt, message and staleRunningSyncsFailed (still HTTP 202 through both routes) instead of syncRunId null; a lost insert race names the winner it re-reads and rethrows the ORIGINAL error if the winner already finished"
    - "A competitor sync whose run insert loses the race (23505 raw, DrizzleQueryError-wrapped, or a real DrizzleQueryError) throws the same 'Competitor intelligence sync is already running' Error as the pre-check, so POST /api/competitor-intelligence/sync answers 409 (not 500) and cron audit records skipped; any other insert failure is rethrown unchanged and still answers 500"
    - "A second sales-dashboard projection import (pre-check hit or lost 23505 race) returns a skipped outcome naming the blocking run instead of throwing; a projection run stuck running for more than 20 minutes is failed and reclaimed so the 10,40 * * * * sales cron stops returning 500; a skipped request never touches the projection source row"
    - "The sales dashboard shows 'Sales dashboard projection import is already running.' instead of '0 monthly scenario rows imported' when the projection import is skipped"
    - "No live run is ever reclaimed: each 20-minute lease exceeds the maxDuration (800 s) of every route that starts the run, asserted by tests that read the route source text"
    - "Every existing suite still passes; every jy4 unearned-revenue case keeps its intent under the new skipped contract"
  artifacts:
    - path: "src/lib/unearned-revenue/sync.ts"
      provides: "20-minute stale sweep, running pre-check, race re-read, skipped result naming the blocking run"
      exports: ["STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS", "UnearnedRevenueSyncResult", "runUnearnedRevenueSync"]
      contains: "failStaleRunningSyncs"
    - path: "src/lib/competitor-intelligence/sync.ts"
      provides: "lost insert race mapped to the existing already-running error"
      contains: "COMPETITOR_SYNC_ALREADY_RUNNING_ERROR"
    - path: "src/lib/sales-dashboard/import-guard.ts"
      provides: "projection-import stale sweep + acquire guard and the projection outcome types"
      exports: ["acquireSalesProjectionImportRun", "failStaleSalesDashboardProjectionImports", "SalesDashboardProjectionImportOutcome"]
      contains: "acquireSalesProjectionImportRun"
    - path: "src/lib/sales-dashboard/data.ts"
      provides: "importSalesDashboardProjectionSource acquires through the guard and returns skipped before touching the source row"
      contains: "acquireSalesProjectionImportRun(db"
    - path: "src/components/sales-dashboard/sales-dashboard-shell.tsx"
      provides: "skip-aware projection import message"
      contains: "Projection import is already running."
    - path: "src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts"
      provides: "rewritten guard suite: race x3 error shapes, pre-check, stale reclaim, original-error rethrow, non-unique rethrow, lease invariant"
    - path: "src/lib/competitor-intelligence/__tests__/sync-guard.test.ts"
      provides: "lost-race, non-unique and pre-check cases for runCompetitorIntelligenceSync (existing stale-sweep cases untouched)"
    - path: "src/app/api/competitor-intelligence/sync/__tests__/route.test.ts"
      provides: "route-level 409 / 500 mapping through the real sync module"
    - path: "src/lib/sales-dashboard/__tests__/import-guard.test.ts"
      provides: "projection guard cases plus the shared lease invariant against the three entry routes"
  key_links:
    - from: "src/lib/sales-dashboard/data.ts importSalesDashboardProjectionSource"
      to: "src/lib/sales-dashboard/import-guard.ts acquireSalesProjectionImportRun"
      via: "guard.skipped early return BEFORE the lastImportError source update"
      pattern: 'acquireSalesProjectionImportRun\(db'
    - from: "src/lib/competitor-intelligence/sync.ts runCompetitorIntelligenceSync"
      to: "src/app/api/competitor-intelligence/sync/route.ts, src/app/api/internal/sync-competitor-intelligence/route.ts, src/lib/data-health/run-job.ts"
      via: 'Error message containing "already running" maps to 409 / cron-audit skipped (routes unchanged)'
      pattern: 'includes\("already running"\)'
    - from: "src/lib/unearned-revenue/sync.ts"
      to: "src/app/api/internal/sync-unearned-revenue/route.ts, src/app/api/unearned-revenue/sync/route.ts"
      via: "skipped result maps to HTTP 202 (routes unchanged); lease STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS exceeds their 800 s maxDuration"
      pattern: 'result\.skipped \? 202'
---

<objective>
Bring three deviant `*_sync_runs` single-flight guards up to the standard shape used by `src/lib/credit-control/run-sync-request.ts` and `src/lib/sync/run-wise-sync.ts`: 20-minute stale sweep, then a running pre-check, then the insert, then a unique-violation catch that re-reads the winner (or rethrows the original error).

Purpose:
1. Unearned revenue: a timeout-killed run never reaches the failure handler, leaves its `unearned_revenue_sync_runs` row `running` forever, and every later daily run silently skips with `syncRunId: null` (no stale cleanup exists anywhere for this table).
2. Competitor intelligence: the stale sweep and pre-check already throw "already running" (routes map it to 409, cron audit to skipped) but the insert itself is uncaught, so a lost race surfaces as a DrizzleQueryError, HTTP 500 and a `failed` cron audit.
3. Sales projection import: plain insert with no pre-check, catch or stale cleanup, so a race returns 500 and a timeout-killed run leaves a `running` row that makes EVERY later projection import hit `sdpir_source_single_running_idx`, and the `10,40 * * * *` sales cron returns 500 forever.

Output: 9 files (4 source modules, 1 component, 4 test files) in three atomic commits on `fix/single-flight-guard-deviations`. No migration, no schema change, no env change, no route change.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
## Worktree rules (non-negotiable)

- Repo root: `/Users/kevinhsieh/Developer/Scheduling-single-flight-guards` (git worktree, branch `fix/single-flight-guard-deviations`). Use ABSOLUTE paths under it for every Read, Write and Edit, and prefix every Bash command with `cd /Users/kevinhsieh/Developer/Scheduling-single-flight-guards &&`. Your shell cwd resets to `/Users/kevinhsieh/Developer/Scheduling`, which is a DIFFERENT checkout holding someone else's uncommitted work: NEVER read planning state from it, edit it, or run git in it.
- Pre-flight: `cd /Users/kevinhsieh/Developer/Scheduling-single-flight-guards && git status --short --branch && git log --oneline -3` must show `## fix/single-flight-guard-deviations`, HEAD `222e2e3` (jy4 docs commit, on top of jy4 code commit `0a27171`), and no changes outside `.planning/quick/260929-lnu-*`. If not, stop and report.
- Node >= 22 for every npm/npx command: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- Every new test is a pure mock: no database, Docker or network. Never set `DATABASE_URL` / `TEST_DATABASE_URL`; never copy `.env*` files into the worktree.
- Do not touch migrations, `src/lib/db/**`, env vars, `vercel.json`, `scripts/`, `.github/`, package files, `*.config.*`, `CLAUDE.md`/`AGENTS.md`, or any `docs/` file (the handbook is regenerated from code; a hand edit would be overwritten). Do not modify any `route.ts`.
- Stage explicit paths only (never `git add -A`); never stage or commit `.planning/**`. Do not push, open a PR, or deploy.
- Read every file once before editing or overwriting it (tool requirement); use Grep with a pattern rather than re-reading.

## Coordination

This branch is stacked on quick task 260929-jy4 (`fix/drizzle-unique-violation-cause`, tip `222e2e3`: code commits `f901757` + `0a27171`, then docs commit `222e2e3`) deliberately. jy4 made every private `isUniqueViolation` cause-aware (drizzle-orm 0.45.2 wraps driver errors in `DrizzleQueryError` with the pg error on `.cause`) and added `src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts`, which pins the OLD skipped contract (`syncRunId: null`, a db mock with only `insert`) that Task 1 changes, so Task 1 updates that file in place. jy4 must merge first. If jy4 is rewritten before merge, re-stack from this branch with `git rebase --onto <new jy4 tip> 222e2e3`. Do not re-implement or cherry-pick jy4 hunks: the cause-aware `isUniqueViolation` bodies already in `src/lib/unearned-revenue/sync.ts` and `src/lib/sales-dashboard/import-guard.ts` stay byte-identical.

## Prototype validation

Every source and test snippet below was applied to a scratch copy of this worktree at `0a27171` before this plan was written: `tsc --noEmit` clean, `eslint` clean on all 9 files, each new/changed suite GREEN with the change and RED against the untouched source (counts stated per task). Apply the snippets verbatim. If `npm run typecheck` or `eslint` in the real worktree disagrees, fix minimally and keep the behavior each `<behavior>` block asserts.

Pitfalls the prototype surfaced (already handled in the snippets, do not undo them): (1) `tsconfig` includes test files, so `mock.calls[i][j]` on a zero-parameter `vi.fn(() => ...)` is a tuple-index type error; the tests cast `mock.calls as unknown as Array<[Record<string, unknown>]>`. (2) ESLint (`next/typescript`) flags unused trailing parameters; unused leading `_label` parameters before a used one are fine. (3) `vi.clearAllMocks()` keeps implementations, so the sheets rejection uses `mockRejectedValueOnce`. (4) The unearned-revenue failure path awaits `db.update().set().where()` directly while the stale sweep awaits `.where().returning()`, so the mock's `where()` must be an awaitable that also exposes `.returning`. (5) A bracketed path passed to vitest must be quoted: `"src/app/api/data-health/jobs/[jobKey]/run/__tests__/route.test.ts"`.

## Conventions (CLAUDE.md / AGENTS.md)

kebab-case files; tests only in sibling `__tests__/`; double quotes; semicolons in `src/lib/**` and `src/app/**`; named exports only; `db: Database = getDb()` defaulted DI seam; JSDoc/why-comments on exported guards; `console.error` only; no TODO/FIXME; design-decision IDs in nearby comments (REL-*, MOD-01, D-*, CM-*) are load-bearing, preserve them. Fail-closed rules are non-negotiable: an unrecognised database error is rethrown, never reported as "already running".

## Locked decisions (implementation spec, do not revisit)

- **G-01** Per-module private helpers. No shared helper module, no barrel, no new cross-module exports beyond those a task names.
- **G-02** Lease = 20 minutes everywhere; it must exceed the 800 s `maxDuration` of every route that starts the run, so a live run is never reclaimed.
- **G-03** `startedAt: now` is set explicitly on inserted `running` rows (same clock as the stale cutoff, as in credit-control and wise-sync).
- **G-04** Tests live in sibling `__tests__/` dirs. Wrapped-error fixture `Object.assign(new Error("Failed query"), { cause: { code: "23505" } })`, plus raw `{ code: "23505" }`, plus a real `new DrizzleQueryError(query, params, cause)` from "drizzle-orm" where a suite already does so. Match file style. Change only what each step names; do not reformat untouched code; preserve existing error texts.
- **G-05** One commit per task, code + tests only, message `fix(260929-lnu): <imperative summary>` + short body, every message ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (use this exact line, it matches the jy4 commits on this branch, whatever default your harness suggests).
- **G-06** Verification per task: `npx vitest run --project unit <affected files>` (plus typecheck and eslint on the changed files); after all tasks: `npm run typecheck`, `npm run lint`, and the affected suites.
- **UR-01..UR-07** (Task 1): exported `STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS`, private error text; private `failStaleRunningSyncs` / `findRunningSyncRun` / `skippedSyncResult`; extended `UnearnedRevenueSyncResult`; skipped result names the blocking run; flow = now, sweep, pre-check, insert, catch (jy4 `isUniqueViolation` body verbatim), re-read, skipped / rethrow ORIGINAL error / rethrow; success and failure results carry `staleRunningSyncsFailed`; `and`, `lt` imports; test cases a-f.
- **CI-01..CI-04** (Task 2): module const for the already-running text shared by pre-check and race path; private cause-aware `isUniqueViolation`; wrap ONLY the `competitor_sync_runs` insert, no re-read, no route change; lib + route tests.
- **SD-01..SD-05** (Task 3): import-guard.ts types, error text, per-source stale sweep, private find/skipped helpers; `acquireSalesProjectionImportRun`; data.ts wiring with skipped return before the source update and `Promise<...Outcome>` annotations; shell message; tests incl. lease invariant.

## Read only these ranges (large files)

- `src/lib/unearned-revenue/sync.ts` 1-66 (imports, result type), 199-205 (`isUniqueViolation`, leave untouched), 533-591 (`runUnearnedRevenueSync`)
- `src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts` (whole, 82 lines; it is overwritten)
- `src/lib/competitor-intelligence/sync.ts` 38-45, 76-82, 494-516; `src/lib/competitor-intelligence/__tests__/sync-guard.test.ts` (whole, 57 lines)
- `src/app/api/competitor-intelligence/sync/route.ts` (whole, unchanged, for reference)
- `src/lib/sales-dashboard/import-guard.ts` (whole, 214 lines); `src/lib/sales-dashboard/__tests__/import-guard.test.ts` (whole, 149 lines)
- `src/lib/sales-dashboard/data.ts` 38-46 (import block), 633-735; `src/components/sales-dashboard/sales-dashboard-shell.tsx` 241-246

<interfaces>
<!-- Extracted from the worktree at 0a27171. Use directly; no exploration needed. -->

src/lib/db/index.ts: `export type Database = ReturnType<typeof getDb>;` (neon-http drizzle; `getDb()` is the default DI argument).

Single-flight tables (src/lib/db/schema.ts, UNCHANGED, no migration in this plan):
- `unearnedRevenueSyncRuns` ("unearned_revenue_sync_runs"): id uuid PK, status `syncStatusEnum` ("running" | "success" | "failed"), triggerType text, actorEmail text|null, spreadsheetId text, startedAt timestamptz notNull defaultNow, finishedAt, errorSummary; partial unique `ur_sync_single_running_idx` ON (status) WHERE status = 'running'.
- `competitorSyncRuns` ("competitor_sync_runs"): same status enum, startedAt defaultNow; partial unique `competitor_sync_runs_single_running_idx` ON (status) WHERE status = 'running'; the only other unique constraint is the random-uuid PK.
- `salesDashboardProjectionImportRuns` ("sales_dashboard_projection_import_runs"): id, sourceId uuid|null, status, triggerType text, startedAt, finishedAt, monthRowCount, targetMonthlyRevenue, errorSummary, actorEmail, metadata; partial unique `sdpir_source_single_running_idx` ON (source_id) WHERE status = 'running' AND source_id IS NOT NULL.

src/lib/sales-dashboard/import-guard.ts (module-private, reuse WITHOUT exporting): `interface RunningSalesImportRun { id: string; startedAt: Date }`, `interface AcquiredSalesImportRun { runId: string; staleRunningImportsFailed: number; skipped?: false }`, `function isUniqueViolation(err: unknown): boolean` (jy4 cause-aware body). Already exported and reused: `export const STALE_RUNNING_SALES_IMPORT_MS = 20 * 60 * 1000;`. Already imported there: `and, desc, eq, inArray, lt` from drizzle-orm and `SalesImportTrigger` from types (`"manual" | "backfill" | "cron"`), so import-guard.ts needs NO import edits.

Standard pattern to mirror (already summarised, re-read only if needed): `src/lib/credit-control/run-sync-request.ts` L43-142 and `src/lib/sync/run-wise-sync.ts` L44-141 = `isUniqueViolation` -> `failStaleRunningSyncs(db, now)` (UPDATE ... SET failed WHERE running AND startedAt < now-20min RETURNING id, returns count) -> `findRunningSyncRun(db)` (SELECT id, startedAt WHERE running ORDER BY startedAt DESC LIMIT 1) -> `skippedSyncResult(running, staleRunningSyncsFailed)` -> `acquireSyncRun`: sweep, pre-check, insert, catch (unique -> re-read -> skipped, none -> rethrow original; non-unique -> rethrow).

Entry routes that start these runs (all `export const maxDuration = 800;`, read as TEXT by the lease tests, never imported): `src/app/api/internal/sync-unearned-revenue/route.ts`, `src/app/api/unearned-revenue/sync/route.ts` (both map `result.skipped` to HTTP 202); `src/app/api/sales-dashboard/projection-import/route.ts`, `src/app/api/internal/sync-sales-dashboard/route.ts`, `src/app/api/data-health/jobs/[jobKey]/run/route.ts`; competitor: `src/app/api/competitor-intelligence/sync/route.ts`, `src/app/api/internal/sync-competitor-intelligence/route.ts`, `src/lib/data-health/run-job.ts` (all map a message containing "already running" to 409; `src/lib/data-health/cron-audit.ts` maps it to outcome `skipped`).
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Unearned-revenue sync - 20-minute stale lease, running pre-check, blocking run id on skip (UR-01..UR-07)</name>
  <files>
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/lib/unearned-revenue/sync.ts,
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts
  </files>
  <behavior>
    - Lost insert race (raw 23505, wrapped `cause.code` 23505, real DrizzleQueryError): result is `{ ok: true, skipped: true, idempotent: false, syncRunId: <re-read winner id>, snapshotId: null, cutoff: null, counts: null, alreadyRunning: true, runningStartedAt: <winner startedAt ISO>, message: "Unearned revenue sync is already running. Data will refresh when that run finishes.", staleRunningSyncsFailed: 0 }`; the workbook is never read.
    - Pre-check finds a fresh `running` row: the same skipped shape naming that row; `insert` is never called.
    - Stale row: the sweep's `.set` receives `status: "failed"` and an `errorSummary` matching /still running after 20 minutes/; the insert then proceeds and the returned result (driven through the failure path by rejecting the first sheets call) carries the NEW run id and `staleRunningSyncsFailed: 1`; the inserted `startedAt` is the same Date instance as the sweep's `finishedAt` (one `now`).
    - 23505 but the re-read finds nothing: rejects with the ORIGINAL error (`toBe`).
    - Non-unique failures (wrapped 23503, raw 23503, wrapper with no cause) and `null` / string rejections are rethrown verbatim, with NO re-read (`select` called once, the pre-check only).
    - Lease invariant: `STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS` is greater than `maxDuration * 1000` for both unearned-revenue routes.
  </behavior>
  <action>
A. Tests first, RED (UR-07). Read the existing jy4 suite, then OVERWRITE `src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts` in place with the file below. Every jy4 case keeps its intent under the new contract (three wrapped/raw/real race shapes, the non-unique rethrows, the null/string rejections); the old `SKIPPED_RESULT` constant (`syncRunId: null`) and the insert-only mock are replaced. Run it against the UNTOUCHED source first: expect 11 of 13 to fail (only the two null/string rejection cases pass on both sides).

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sales-dashboard/sheets", () => ({
  fetchGoogleSheetRange: vi.fn(),
  listGoogleSheetProperties: vi.fn(),
  quoteGoogleSheetName: vi.fn((name: string) => name),
}));

import type { Database } from "@/lib/db";
import { fetchGoogleSheetRange, listGoogleSheetProperties } from "@/lib/sales-dashboard/sheets";
import {
  runUnearnedRevenueSync,
  STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS,
} from "@/lib/unearned-revenue/sync";

// drizzle-orm 0.45 wraps every driver error in DrizzleQueryError: the SQLSTATE
// lives on `.cause`, `.code` is undefined and `.message` is "Failed query: ...".
// Raw `.code` errors (a driver error that reaches the guard unwrapped) stay
// supported as a defensive fallback, so both shapes must work.
const rawUnique = () =>
  Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
const wrappedUnique = () =>
  Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
const realWrappedUnique = () =>
  new DrizzleQueryError(
    'insert into "unearned_revenue_sync_runs" ("status") values ($1)',
    ["running"],
    rawUnique(),
  );

interface RunningRow {
  id: string;
  startedAt: Date;
}

const WINNER: RunningRow = { id: "winner-run", startedAt: new Date("2026-09-29T08:00:00.000Z") };

function makeDb(options: {
  /** One response per select().from().where().orderBy().limit(): the pre-check first, then the post-race re-read. */
  selects?: RunningRow[][];
  /** Rows the stale sweep's `.returning()` reports as reclaimed. */
  staleRows?: Array<{ id: string }>;
  /** When present, the run insert rejects with it (null and strings included). */
  insertError?: unknown;
} = {}) {
  const selects = [...(options.selects ?? [[]])];
  const returning = vi.fn().mockResolvedValue(options.staleRows ?? []);
  // The stale sweep awaits `.where().returning()`; the failure path awaits `.where()` itself.
  const where = vi.fn(() => Object.assign(Promise.resolve([]), { returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const limit = vi.fn(() => Promise.resolve(selects.shift() ?? []));
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
  }));
  const insertReturning = "insertError" in options
    ? vi.fn().mockRejectedValue(options.insertError)
    : vi.fn().mockResolvedValue([{ id: "new-run" }]);
  const values = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: { update, select, insert } as unknown as Database,
    insert,
    select,
    set,
    values,
  };
}

function skippedResult(running: RunningRow, staleRunningSyncsFailed = 0) {
  return {
    ok: true,
    skipped: true,
    idempotent: false,
    syncRunId: running.id,
    snapshotId: null,
    cutoff: null,
    counts: null,
    alreadyRunning: true,
    runningStartedAt: running.startedAt.toISOString(),
    message: "Unearned revenue sync is already running. Data will refresh when that run finishes.",
    staleRunningSyncsFailed,
  };
}

describe("runUnearnedRevenueSync single-flight guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["raw driver error", rawUnique],
    ["DrizzleQueryError-wrapped driver error", wrappedUnique],
    ["real DrizzleQueryError", realWrappedUnique],
  ])("skips naming the winning run when the insert loses the unique race (%s)", async (_label, makeError) => {
    const { db } = makeDb({ selects: [[], [WINNER]], insertError: makeError() });

    const result = await runUnearnedRevenueSync({ triggerType: "cron", db });

    expect(result).toEqual(skippedResult(WINNER));
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
    expect(fetchGoogleSheetRange).not.toHaveBeenCalled();
  });

  it("skips without inserting when the pre-check finds a fresh running run", async () => {
    const { db, insert } = makeDb({ selects: [[WINNER]] });

    const result = await runUnearnedRevenueSync({ triggerType: "cron", db });

    expect(result).toEqual(skippedResult(WINNER));
    expect(insert).not.toHaveBeenCalled();
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
  });

  it("fails a stale running row, then proceeds under a fresh run id", async () => {
    vi.mocked(listGoogleSheetProperties).mockRejectedValueOnce(new Error("sheets unavailable"));
    const { db, set, values } = makeDb({ selects: [[]], staleRows: [{ id: "stale-run" }] });

    const result = await runUnearnedRevenueSync({ triggerType: "cron", db });

    expect(set).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringMatching(/still running after 20 minutes/),
    }));
    expect(values).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      skipped: false,
      syncRunId: "new-run",
      staleRunningSyncsFailed: 1,
      errorSummary: "sheets unavailable",
    });

    // One clock: the stale cutoff, the sweep's finishedAt and the new row's startedAt share one `now`.
    const setCalls = set.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const valuesCalls = values.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(valuesCalls[0][0]).toMatchObject({ status: "running", triggerType: "cron" });
    expect(valuesCalls[0][0].startedAt).toBeInstanceOf(Date);
    expect(valuesCalls[0][0].startedAt).toBe(setCalls[0][0].finishedAt);
  });

  it("rethrows the original unique violation when the winning run has already finished", async () => {
    const error = wrappedUnique();
    const { db } = makeDb({ selects: [[], []], insertError: error });

    await expect(runUnearnedRevenueSync({ triggerType: "cron", db })).rejects.toBe(error);
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
  });

  it.each([
    ["wrapped non-unique error (cause.code 23503)", () => Object.assign(new Error("Failed query"), { cause: { code: "23503" } })],
    ["raw non-unique error (code 23503)", () => Object.assign(new Error("fk violation"), { code: "23503" })],
    ["wrapper with no cause", () => new Error("Failed query")],
  ])("rethrows a non-unique failure instead of skipping (%s)", async (_label, makeError) => {
    const error = makeError();
    const { db, select } = makeDb({ insertError: error });

    await expect(runUnearnedRevenueSync({ triggerType: "cron", db })).rejects.toBe(error);
    expect(select).toHaveBeenCalledTimes(1); // the pre-check only: a non-unique failure is never re-read
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a string", "boom"],
  ])("rethrows %s rejection verbatim (the guard tolerates non-object rejections)", async (_label, rejection) => {
    const { db } = makeDb({ insertError: rejection });

    await expect(runUnearnedRevenueSync({ triggerType: "cron", db })).rejects.toBe(rejection);
  });

  // The lease may only reclaim a run whose function is certainly dead: it must
  // outlast the `maxDuration` of every route that starts a sync. Read as text
  // because importing a route pulls in the Next/auth graph.
  it.each([
    ["internal cron route", ["src", "app", "api", "internal", "sync-unearned-revenue", "route.ts"]],
    ["admin manual route", ["src", "app", "api", "unearned-revenue", "sync", "route.ts"]],
  ])("keeps the stale lease longer than the %s maxDuration", (_label, segments) => {
    const source = readFileSync(path.join(process.cwd(), ...segments), "utf8");
    const declared = /export const maxDuration = (\d+)/.exec(source);

    expect(declared).not.toBeNull();
    expect(STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS).toBeGreaterThan(Number(declared?.[1]) * 1000);
  });
});
```

B. Source, GREEN (UR-01..UR-06). Edit `src/lib/unearned-revenue/sync.ts`. Leave the private `isUniqueViolation` at L199-205 (jy4's cause-aware body) UNTOUCHED so that hunk stays identical to jy4.

1. Import (UR-06): replace `import { count, desc, eq, notInArray, sql } from "drizzle-orm";` with `import { and, count, desc, eq, lt, notInArray, sql } from "drizzle-orm";`.

2. Lease constant and error text (UR-01): insert directly after `const OPTIONAL_CONTRACT_TABS = [...] as const;` and before `export interface UnearnedRevenueSyncResult`:

```ts
/** Lease on a `running` row; longer than the 800 s `maxDuration` of every route that starts a sync. */
export const STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS = 20 * 60 * 1000;

const STALE_RUNNING_UNEARNED_REVENUE_SYNC_ERROR =
  "Unearned revenue sync marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";
```

3. Result type (UR-03): in `UnearnedRevenueSyncResult`, after `errorSummary?: string;` add the four optional fields, and add the private `RunningSyncRun` interface between the result interface and `interface SyncOptions`:

```ts
  errorSummary?: string;
  /** Skipped results only: another run holds the single-flight slot and `syncRunId` names it. */
  alreadyRunning?: true;
  runningStartedAt?: string;
  message?: string;
  staleRunningSyncsFailed?: number;
}

interface RunningSyncRun {
  id: string;
  startedAt: Date;
}
```

4. Helpers and flow (UR-02, UR-04, UR-05, G-03): replace this exact block (the head of `runUnearnedRevenueSync` up to and including its first try/catch):

```ts
export async function runUnearnedRevenueSync(options: SyncOptions): Promise<UnearnedRevenueSyncResult> {
  const db = options.db ?? getDb();
  const spreadsheetId = getUnearnedRevenueSpreadsheetId();
  let syncRunId: string | null = null;
  try {
    const [run] = await db.insert(schema.unearnedRevenueSyncRuns).values({
      status: "running",
      triggerType: options.triggerType,
      actorEmail: options.actorEmail ?? null,
      spreadsheetId,
    }).returning({ id: schema.unearnedRevenueSyncRuns.id });
    syncRunId = run.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: true, skipped: true, idempotent: false, syncRunId: null, snapshotId: null, cutoff: null, counts: null };
    }
    throw error;
  }
```

with:

```ts
async function failStaleRunningSyncs(db: Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS);
  const rows = await db
    .update(schema.unearnedRevenueSyncRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: STALE_RUNNING_UNEARNED_REVENUE_SYNC_ERROR,
    })
    .where(
      and(
        eq(schema.unearnedRevenueSyncRuns.status, "running"),
        lt(schema.unearnedRevenueSyncRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: schema.unearnedRevenueSyncRuns.id });

  return rows.length;
}

async function findRunningSyncRun(db: Database): Promise<RunningSyncRun | null> {
  const [running] = await db
    .select({
      id: schema.unearnedRevenueSyncRuns.id,
      startedAt: schema.unearnedRevenueSyncRuns.startedAt,
    })
    .from(schema.unearnedRevenueSyncRuns)
    .where(eq(schema.unearnedRevenueSyncRuns.status, "running"))
    .orderBy(desc(schema.unearnedRevenueSyncRuns.startedAt))
    .limit(1);

  return running ?? null;
}

function skippedSyncResult(
  running: RunningSyncRun,
  staleRunningSyncsFailed: number,
): UnearnedRevenueSyncResult {
  return {
    ok: true,
    skipped: true,
    idempotent: false,
    syncRunId: running.id,
    snapshotId: null,
    cutoff: null,
    counts: null,
    alreadyRunning: true,
    runningStartedAt: running.startedAt.toISOString(),
    message: "Unearned revenue sync is already running. Data will refresh when that run finishes.",
    staleRunningSyncsFailed,
  };
}

export async function runUnearnedRevenueSync(options: SyncOptions): Promise<UnearnedRevenueSyncResult> {
  const db = options.db ?? getDb();
  const spreadsheetId = getUnearnedRevenueSpreadsheetId();
  const now = new Date();
  const staleRunningSyncsFailed = await failStaleRunningSyncs(db, now);
  const currentRunning = await findRunningSyncRun(db);
  if (currentRunning) return skippedSyncResult(currentRunning, staleRunningSyncsFailed);

  let syncRunId: string | null = null;
  try {
    const [run] = await db.insert(schema.unearnedRevenueSyncRuns).values({
      status: "running",
      triggerType: options.triggerType,
      actorEmail: options.actorEmail ?? null,
      spreadsheetId,
      startedAt: now,
    }).returning({ id: schema.unearnedRevenueSyncRuns.id });
    syncRunId = run.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the insert race: name the winner, or surface the original error if it already finished.
    const running = await findRunningSyncRun(db);
    if (!running) throw error;
    return skippedSyncResult(running, staleRunningSyncsFailed);
  }
```

5. Success and failure results (UR-05): the second try/catch is otherwise unchanged; add one line to each returned object. Replace

```ts
        exactPackages: contract.exactPackages.length,
      },
    };
  } catch (error) {
```

with

```ts
        exactPackages: contract.exactPackages.length,
      },
      staleRunningSyncsFailed,
    };
  } catch (error) {
```

and replace

```ts
      counts: null,
      errorSummary,
    };
  }
}
```

with

```ts
      counts: null,
      errorSummary,
      staleRunningSyncsFailed,
    };
  }
}
```

C. Run the suite (GREEN, 13 passing), then the verify command, then commit exactly these two files:

```
fix(260929-lnu): reclaim stale unearned-revenue sync runs and name the blocking run

runUnearnedRevenueSync inserted its running row with no stale cleanup, so a
timeout-killed run (which never reaches the failure handler) left the row
running forever and every later daily run silently skipped. Give it the
credit-control / wise-sync guard shape: a 20-minute lease sweep (longer than the
800 s route maxDuration), a running pre-check, and a unique-violation catch
that re-reads the winner. A skipped result now carries the blocking run id, its
startedAt and a message instead of syncRunId null; success and failure results
report staleRunningSyncsFailed. Rewrites the jy4 guard suite in place for the
new skipped contract.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/Scheduling-single-flight-guards && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run --project unit src/lib/unearned-revenue && npm run typecheck && npx eslint src/lib/unearned-revenue/sync.ts src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts && git diff --check && test "$(grep -cE '^ +staleRunningSyncsFailed,$' src/lib/unearned-revenue/sync.ts)" = "3" && ! git diff -- src/lib/unearned-revenue/sync.ts | grep -E '^[-+].*(candidate\.code|cause\?\.code)'</automated>
  </verify>
  <done>All 13 cases in sync-run-guard.test.ts pass (11 of them fail against the untouched source); every other unearned-revenue unit suite, typecheck, eslint and `git diff --check` pass; `staleRunningSyncsFailed,` appears on exactly three lines (skipped, success, failure results); jy4's `isUniqueViolation` body is unchanged; the change is committed as `fix(260929-lnu): reclaim stale unearned-revenue sync runs and name the blocking run` touching only the two listed files.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Competitor-intelligence sync - map a lost run-insert race to the existing already-running error (CI-01..CI-04)</name>
  <files>
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/lib/competitor-intelligence/sync.ts,
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/lib/competitor-intelligence/__tests__/sync-guard.test.ts,
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/app/api/competitor-intelligence/sync/__tests__/route.test.ts
  </files>
  <behavior>
    - Lost insert race (raw 23505, wrapped `cause.code` 23505, real DrizzleQueryError): `runCompetitorIntelligenceSync` rejects with an Error whose message is exactly "Competitor intelligence sync is already running".
    - Non-unique insert failure (wrapped 23503, raw 23503, wrapper with no cause): rejects with the SAME object (`toBe`), never converted.
    - Pre-check finds a running row: same message, `insert` never called (pre-check text unchanged).
    - Route: `POST /api/competitor-intelligence/sync` answers 409 `{ error: "Competitor intelligence sync is already running" }` when the insert rejects with a wrapped 23505, and 500 `{ error: "Failed query" }` (not 409) when it rejects with a wrapped 23503.
    - Existing `failStaleRunningCompetitorSyncs` cases are untouched.
  </behavior>
  <action>
A. Tests first, RED (CI-04).

1. `src/lib/competitor-intelligence/__tests__/sync-guard.test.ts` (read it first; the two existing tests stay byte-identical). Replace the import block

```ts
import { describe, expect, it, vi } from "vitest";
import { failStaleRunningCompetitorSyncs } from "@/lib/competitor-intelligence/sync";
```

with

```ts
import { describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import {
  failStaleRunningCompetitorSyncs,
  runCompetitorIntelligenceSync,
} from "@/lib/competitor-intelligence/sync";
```

and append this after the last line of the file (after the closing `});` of the existing `describe`):

```ts

// Callers (both sync routes, the data-health runner) map any message containing
// "already running" to HTTP 409, and cron-audit records it as `skipped`.
const ALREADY_RUNNING = "Competitor intelligence sync is already running";

// drizzle-orm 0.45 wraps every driver error in DrizzleQueryError: the SQLSTATE
// lives on `.cause`, `.code` is undefined. Raw `.code` errors stay supported.
const rawUnique = () =>
  Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
const wrappedUnique = () =>
  Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
const realWrappedUnique = () =>
  new DrizzleQueryError(
    'insert into "competitor_sync_runs" ("trigger_type") values ($1)',
    ["manual"],
    rawUnique(),
  );

function makeRunDb(options: { runningRows?: Array<{ id: string }>; insertError: unknown }) {
  // Stale sweep: update().set().where().returning() -> [] so no child-run updates fire.
  const sweepReturning = vi.fn().mockResolvedValue([]);
  const update = vi.fn(() => ({ set: () => ({ where: () => ({ returning: sweepReturning }) }) }));
  const limit = vi.fn().mockResolvedValue(options.runningRows ?? []);
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  const insertReturning = vi.fn().mockRejectedValue(options.insertError);
  const insert = vi.fn(() => ({ values: () => ({ returning: insertReturning }) }));

  return { db: { update, select, insert }, insert };
}

describe("competitor sync single-flight insert guard", () => {
  it.each([
    ["raw driver error", rawUnique],
    ["DrizzleQueryError-wrapped driver error", wrappedUnique],
    ["real DrizzleQueryError", realWrappedUnique],
  ])("maps a lost insert race to the already-running error (%s)", async (_label, makeError) => {
    const { db } = makeRunDb({ insertError: makeError() });

    const failure = await runCompetitorIntelligenceSync({
      triggerType: "manual",
      actorEmail: "admin@example.com",
      db: db as never,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(ALREADY_RUNNING);
  });

  it.each([
    ["wrapped non-unique error (cause.code 23503)", () => Object.assign(new Error("Failed query"), { cause: { code: "23503" } })],
    ["raw non-unique error (code 23503)", () => Object.assign(new Error("fk violation"), { code: "23503" })],
    ["wrapper with no cause", () => new Error("Failed query")],
  ])("rethrows a non-unique insert failure verbatim (%s)", async (_label, makeError) => {
    const error = makeError();
    const { db } = makeRunDb({ insertError: error });

    await expect(runCompetitorIntelligenceSync({
      triggerType: "manual",
      actorEmail: "admin@example.com",
      db: db as never,
    })).rejects.toBe(error);
  });

  it("keeps the pre-check error text and never inserts while a run is already running", async () => {
    const { db, insert } = makeRunDb({
      runningRows: [{ id: "running-1" }],
      insertError: new Error("insert must not be reached"),
    });

    const failure = await runCompetitorIntelligenceSync({
      triggerType: "cron",
      db: db as never,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(ALREADY_RUNNING);
    expect(insert).not.toHaveBeenCalled();
  });
});
```

2. Create `src/app/api/competitor-intelligence/sync/__tests__/route.test.ts` (new directory `__tests__` under `sync/`). It imports the REAL `runCompetitorIntelligenceSync` through the route and mocks only `@/lib/auth` (session shape copied from `src/app/api/competitor-intelligence/__tests__/route.test.ts`) and `@/lib/db`. No `server-only` mock is needed: nothing in `src/lib/competitor-intelligence` imports it.

```ts
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { POST } from "../route";

const authMock = auth as unknown as Mock;

/**
 * Just enough Drizzle surface for the real runCompetitorIntelligenceSync to reach
 * (and fail) the run insert: an empty stale sweep, an empty running pre-check,
 * then an insert that rejects with `insertError`.
 */
function makeDb(insertError: unknown) {
  return {
    update: vi.fn(() => ({
      set: () => ({ where: () => ({ returning: vi.fn().mockResolvedValue([]) }) }),
    })),
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
    })),
    insert: vi.fn(() => ({
      values: () => ({ returning: vi.fn().mockRejectedValue(insertError) }),
    })),
  };
}

describe("POST /api/competitor-intelligence/sync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: {
        email: "marketing@example.com",
        name: "Marketing",
        role: "admin",
        allowedPages: null,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 409 when the run insert loses the single-flight race", async () => {
    // DrizzleQueryError shape: the SQLSTATE is on `.cause`.
    const lostRace = Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
    vi.mocked(getDb).mockReturnValue(makeDb(lostRace) as never);

    const res = await POST();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Competitor intelligence sync is already running" });
  });

  it("keeps a non-unique insert failure as HTTP 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const foreignKey = Object.assign(new Error("Failed query"), { cause: { code: "23503" } });
    vi.mocked(getDb).mockReturnValue(makeDb(foreignKey) as never);

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed query" });
  });
});
```

Run both against the UNTOUCHED source first: expect exactly 4 failures (the three lib lost-race cases and the route 409 case); the non-unique, pre-check and 500 cases pass on both sides because they pin behavior that must not change.

B. Source, GREEN (CI-01..CI-03). Edit `src/lib/competitor-intelligence/sync.ts`; change ONLY the following. Do not edit any route file: they already map "already running" to 409 (`src/app/api/competitor-intelligence/sync/route.ts` L21, `src/app/api/internal/sync-competitor-intelligence/route.ts`, `src/lib/data-health/run-job.ts`) and `src/lib/data-health/cron-audit.ts` maps it to outcome `skipped`.

1. Shared text (CI-01): directly after the `STALE_RUNNING_COMPETITOR_SYNC_ERROR` constant (ends at L42) add:

```ts
// Callers map any message containing "already running" to HTTP 409 / a skipped cron audit outcome.
const COMPETITOR_SYNC_ALREADY_RUNNING_ERROR = "Competitor intelligence sync is already running";
```

2. Cause-aware check (CI-02): directly after the `compactError` function add (exact jy4 body and comment):

```ts
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // drizzle-orm wraps driver errors in DrizzleQueryError; the SQLSTATE is on `.cause`.
  const candidate = err as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}
```

3. Pre-check text and insert (CI-01, CI-03): in `runCompetitorIntelligenceSync` replace

```ts
  if (running) {
    throw new Error("Competitor intelligence sync is already running");
  }
  const [run] = await db.insert(schema.competitorSyncRuns)
    .values({
      triggerType: input.triggerType,
      actorEmail,
    })
    .returning();
```

with

```ts
  if (running) {
    throw new Error(COMPETITOR_SYNC_ALREADY_RUNNING_ERROR);
  }
  let run: typeof schema.competitorSyncRuns.$inferSelect;
  try {
    [run] = await db.insert(schema.competitorSyncRuns)
      .values({
        triggerType: input.triggerType,
        actorEmail,
      })
      .returning();
  } catch (error) {
    // Lost the insert race to a concurrent run (competitor_sync_runs_single_running_idx):
    // same outcome as the pre-check above, so every caller keeps mapping it to 409 / skipped.
    if (isUniqueViolation(error)) throw new Error(COMPETITOR_SYNC_ALREADY_RUNNING_ERROR);
    throw error;
  }
```

No re-read is needed: the outcome is identical to the pre-check. The only unique constraints on the table are the random-uuid PK and the single-running partial index, and every non-unique error is rethrown unchanged.

C. Run both suites (GREEN), then the verify command, then commit exactly these three files:

```
fix(260929-lnu): map a lost competitor sync insert race to already running

The stale sweep and running pre-check throw "already running" (routes map it to
409, cron audit to skipped), but the run insert itself was uncaught, so a lost
race against competitor_sync_runs_single_running_idx surfaced as a
DrizzleQueryError -> HTTP 500 and a failed cron audit. Catch the cause-aware
23505 around that insert only and throw the same already-running error; any
other failure is rethrown unchanged. No route changes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/Scheduling-single-flight-guards && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run --project unit src/lib/competitor-intelligence src/app/api/competitor-intelligence && npm run typecheck && npx eslint src/lib/competitor-intelligence/sync.ts src/lib/competitor-intelligence/__tests__/sync-guard.test.ts src/app/api/competitor-intelligence/sync/__tests__/route.test.ts && git diff --check && test "$(grep -c 'COMPETITOR_SYNC_ALREADY_RUNNING_ERROR' src/lib/competitor-intelligence/sync.ts)" = "3"</automated>
  </verify>
  <done>The three lost-race cases and the route 409 case pass (they fail against the untouched source); the non-unique, pre-check and 500 cases pass; the two pre-existing stale-sweep tests and the dashboard route test still pass; `COMPETITOR_SYNC_ALREADY_RUNNING_ERROR` appears exactly three times (declaration, pre-check, race path); no `route.ts` changed; committed as `fix(260929-lnu): map a lost competitor sync insert race to already running` touching only the three listed files.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Sales projection import - single-flight guard, skipped outcome, skip-aware dashboard message (SD-01..SD-05)</name>
  <files>
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/lib/sales-dashboard/import-guard.ts,
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/lib/sales-dashboard/data.ts,
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/components/sales-dashboard/sales-dashboard-shell.tsx,
/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/src/lib/sales-dashboard/__tests__/import-guard.test.ts
  </files>
  <behavior>
    - No running import: `acquireSalesProjectionImportRun` inserts exactly `{ sourceId, status: "running", triggerType, actorEmail, startedAt: now }` and returns `{ runId, staleRunningImportsFailed: 0 }`.
    - Fresh running row: returns `{ sourceId, runId: <its id>, projectionMonths: 0, targetMonthlyRevenue: null, skipped: true, alreadyRunning: true, runningStartedAt: <ISO>, staleRunningImportsFailed: 0, message: "Sales dashboard projection import is already running." }` and never inserts.
    - Lost race (raw 23505, wrapped `cause.code` 23505): skipped result naming the re-read winner.
    - 23505 with an empty re-read: rejects with the ORIGINAL error. Non-unique wrapped 23503: rethrown, no re-read (`select` called once).
    - Stale reclaim: exactly one `update().set()` with `status: "failed"`, `finishedAt: now` and the projection stale text (no source-status restore), result `staleRunningImportsFailed: 1`, insert called once. `failStaleSalesDashboardProjectionImports` returns the failed count.
    - Lease invariant: `STALE_RUNNING_SALES_IMPORT_MS` exceeds `maxDuration * 1000` of the `projection-import`, `internal/sync-sales-dashboard` and `data-health/jobs/[jobKey]/run` routes.
    - `importSalesDashboardProjectionSource` returns the skipped outcome BEFORE the `lastImportError: null` source update, so a skipped request never touches the source row; the dashboard shows the skip message instead of "0 monthly scenario rows imported".
  </behavior>
  <action>
A. Tests first, RED (SD-05). Edit `src/lib/sales-dashboard/__tests__/import-guard.test.ts` (read it first; the six existing cases stay byte-identical).

1. Imports: replace

```ts
import { describe, expect, it, vi } from "vitest";
import {
  acquireSalesImportRun,
  failStaleSalesDashboardImports,
} from "@/lib/sales-dashboard/import-guard";
```

with

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireSalesImportRun,
  acquireSalesProjectionImportRun,
  failStaleSalesDashboardImports,
  failStaleSalesDashboardProjectionImports,
  STALE_RUNNING_SALES_IMPORT_MS,
} from "@/lib/sales-dashboard/import-guard";
```

2. `makeDbMock` must expose the insert `values` mock so the tests can assert the inserted row. Hoist it: after `const updateSet = vi.fn(() => ({ where: updateWhere }));` add

```ts
  const insertValues = vi.fn(() => ({
    returning: options.insertError
      ? vi.fn().mockRejectedValue(options.insertError)
      : vi.fn().mockResolvedValue([{ id: "import-run-1" }]),
  }));
```

change `return {\n    updateSet,` to `return {\n    insertValues,\n    updateSet,`, and replace the inline

```ts
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: options.insertError
            ? vi.fn().mockRejectedValue(options.insertError)
            : vi.fn().mockResolvedValue([{ id: "import-run-1" }]),
        })),
      })),
```

with

```ts
      insert: vi.fn(() => ({ values: insertValues })),
```

3. Append after the existing `describe("sales dashboard import guard", ...)` block (after its closing `});`):

```ts

const projectionInput = {
  sourceId: "projection-1",
  triggerType: "cron" as const,
  actorEmail: "cron@begifted.local",
  now: new Date("2026-05-26T05:00:00.000Z"),
};

const projectionWinner = { id: "running-after-race", startedAt: new Date("2026-05-26T04:59:00.000Z") };

describe("sales dashboard projection import guard", () => {
  it("acquires a run stamped with the request clock when none is running", async () => {
    const { db, insertValues } = makeDbMock();

    const result = await acquireSalesProjectionImportRun(db as never, projectionInput);

    expect(result).toEqual({ runId: "import-run-1", staleRunningImportsFailed: 0 });
    expect(insertValues).toHaveBeenCalledWith({
      sourceId: "projection-1",
      status: "running",
      triggerType: "cron",
      actorEmail: "cron@begifted.local",
      startedAt: projectionInput.now,
    });
  });

  it("skips without inserting when a fresh projection import is already running", async () => {
    const { db } = makeDbMock({
      runningRows: [{ id: "running-1", startedAt: new Date("2026-05-26T04:55:00.000Z") }],
    });

    const result = await acquireSalesProjectionImportRun(db as never, projectionInput);

    expect(result).toEqual({
      sourceId: "projection-1",
      runId: "running-1",
      projectionMonths: 0,
      targetMonthlyRevenue: null,
      skipped: true,
      alreadyRunning: true,
      runningStartedAt: "2026-05-26T04:55:00.000Z",
      staleRunningImportsFailed: 0,
      message: "Sales dashboard projection import is already running.",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([
    ["raw driver error", () => Object.assign(new Error("duplicate"), { code: "23505" })],
    ["DrizzleQueryError-wrapped driver error", () => Object.assign(new Error("Failed query"), { cause: { code: "23505" } })],
  ])("skips naming the winning run when the insert loses the unique race (%s)", async (_label, makeError) => {
    const { db } = makeDbMock({ insertError: makeError(), duplicateRaceRows: [projectionWinner] });

    const result = await acquireSalesProjectionImportRun(db as never, projectionInput);

    expect(result).toMatchObject({
      sourceId: "projection-1",
      runId: "running-after-race",
      projectionMonths: 0,
      targetMonthlyRevenue: null,
      skipped: true,
      alreadyRunning: true,
      runningStartedAt: "2026-05-26T04:59:00.000Z",
    });
  });

  it("rethrows the original unique violation when the winning import has already finished", async () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
    const { db } = makeDbMock({ insertError: wrapped, duplicateRaceRows: [] });

    await expect(acquireSalesProjectionImportRun(db as never, projectionInput)).rejects.toBe(wrapped);
  });

  it("rethrows a non-unique insert failure (cause.code 23503) without re-reading", async () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: { code: "23503" } });
    const { db } = makeDbMock({ insertError: wrapped, duplicateRaceRows: [projectionWinner] });

    await expect(acquireSalesProjectionImportRun(db as never, projectionInput)).rejects.toBe(wrapped);
    expect(db.select).toHaveBeenCalledTimes(1); // the pre-check only
  });

  it("fails a stale running projection import, then acquires a fresh run", async () => {
    const { db, updateSet } = makeDbMock({
      staleRows: [{ id: "stale-1", sourceId: "projection-1", metadata: {} }],
    });

    const result = await acquireSalesProjectionImportRun(db as never, projectionInput);

    expect(result).toEqual({ runId: "import-run-1", staleRunningImportsFailed: 1 });
    expect(updateSet).toHaveBeenCalledTimes(1); // projection imports never flip a source status
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      finishedAt: projectionInput.now,
      errorSummary: expect.stringContaining("Sales dashboard projection import marked failed because it was still running after 20 minutes"),
    }));
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("counts failed stale projection imports for the source", async () => {
    const { db } = makeDbMock({
      staleRows: [
        { id: "stale-1", sourceId: "projection-1", metadata: {} },
        { id: "stale-2", sourceId: "projection-1", metadata: {} },
      ],
    });

    await expect(
      failStaleSalesDashboardProjectionImports(db as never, "projection-1", new Date("2026-05-26T05:30:00.000Z")),
    ).resolves.toBe(2);
  });
});

describe("sales dashboard import lease", () => {
  // Monthly and projection imports share this lease and the same 800 s entry
  // routes; it may only reclaim a run whose function is certainly dead. Read as
  // text because importing a route pulls in the Next/auth graph.
  it.each([
    ["projection-import", ["src", "app", "api", "sales-dashboard", "projection-import", "route.ts"]],
    ["sync-sales-dashboard", ["src", "app", "api", "internal", "sync-sales-dashboard", "route.ts"]],
    ["data-health job runner", ["src", "app", "api", "data-health", "jobs", "[jobKey]", "run", "route.ts"]],
  ])("stays longer than the %s route maxDuration", (_label, segments) => {
    const source = readFileSync(path.join(process.cwd(), ...segments), "utf8");
    const declared = /export const maxDuration = (\d+)/.exec(source);

    expect(declared).not.toBeNull();
    expect(STALE_RUNNING_SALES_IMPORT_MS).toBeGreaterThan(Number(declared?.[1]) * 1000);
  });
});
```

Run the file against the UNTOUCHED source first: expect 8 failures (every new projection guard case, "is not a function"); the six existing cases and the three lease cases pass on both sides (`STALE_RUNNING_SALES_IMPORT_MS` already exists).

B. Source, GREEN.

1. `src/lib/sales-dashboard/import-guard.ts` (SD-01, SD-02). No import edits. Reuse the module-private `RunningSalesImportRun`, `AcquiredSalesImportRun`, `isUniqueViolation` and the exported `STALE_RUNNING_SALES_IMPORT_MS` (lease per G-02, shared with the monthly imports and the same 800 s entry points). Make four insertions:

 a. Directly after the `STALE_RUNNING_SALES_IMPORT_ERROR` constant:

```ts

const STALE_RUNNING_SALES_PROJECTION_IMPORT_ERROR =
  "Sales dashboard projection import marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";
```

 b. Directly after `export type SalesDashboardImportOutcome = ...;`:

```ts

export interface SalesDashboardProjectionImportResult {
  sourceId: string;
  runId: string;
  projectionMonths: number;
  targetMonthlyRevenue: number | null;
  skipped?: false;
  alreadyRunning?: false;
  staleRunningImportsFailed?: number;
}

export interface SkippedSalesDashboardProjectionImportResult {
  sourceId: string;
  runId: string;
  projectionMonths: 0;
  targetMonthlyRevenue: null;
  skipped: true;
  alreadyRunning: true;
  runningStartedAt: string;
  message: string;
  staleRunningImportsFailed: number;
}

export type SalesDashboardProjectionImportOutcome =
  | SalesDashboardProjectionImportResult
  | SkippedSalesDashboardProjectionImportResult;
```

 c. Directly after `interface AcquiredSalesImportRun { ... }`:

```ts

interface AcquireSalesProjectionImportRunInput {
  sourceId: string;
  triggerType: SalesImportTrigger;
  actorEmail: string;
  now: Date;
}
```

 d. Append at the END of the file (after `acquireSalesImportRun`):

```ts

/**
 * Projection imports share the monthly imports' 20-minute lease and entry routes
 * (all `maxDuration = 800`), but never flip a source status, so there is no
 * status to restore when a stale run is failed.
 */
export async function failStaleSalesDashboardProjectionImports(
  db: Database,
  sourceId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_SALES_IMPORT_MS);
  const rows = await db
    .update(schema.salesDashboardProjectionImportRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: STALE_RUNNING_SALES_PROJECTION_IMPORT_ERROR,
    })
    .where(
      and(
        eq(schema.salesDashboardProjectionImportRuns.sourceId, sourceId),
        eq(schema.salesDashboardProjectionImportRuns.status, "running"),
        lt(schema.salesDashboardProjectionImportRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: schema.salesDashboardProjectionImportRuns.id });

  return rows.length;
}

async function findRunningSalesProjectionImportRun(
  db: Database,
  sourceId: string,
): Promise<RunningSalesImportRun | null> {
  const [running] = await db
    .select({
      id: schema.salesDashboardProjectionImportRuns.id,
      startedAt: schema.salesDashboardProjectionImportRuns.startedAt,
    })
    .from(schema.salesDashboardProjectionImportRuns)
    .where(
      and(
        eq(schema.salesDashboardProjectionImportRuns.sourceId, sourceId),
        eq(schema.salesDashboardProjectionImportRuns.status, "running"),
      ),
    )
    .orderBy(desc(schema.salesDashboardProjectionImportRuns.startedAt))
    .limit(1);

  return running ?? null;
}

function skippedProjectionImportResult(
  sourceId: string,
  running: RunningSalesImportRun,
  staleRunningImportsFailed: number,
): SkippedSalesDashboardProjectionImportResult {
  return {
    sourceId,
    runId: running.id,
    projectionMonths: 0,
    targetMonthlyRevenue: null,
    skipped: true,
    alreadyRunning: true,
    runningStartedAt: running.startedAt.toISOString(),
    staleRunningImportsFailed,
    message: "Sales dashboard projection import is already running.",
  };
}

export async function acquireSalesProjectionImportRun(
  db: Database,
  input: AcquireSalesProjectionImportRunInput,
): Promise<AcquiredSalesImportRun | SkippedSalesDashboardProjectionImportResult> {
  const staleRunningImportsFailed = await failStaleSalesDashboardProjectionImports(
    db,
    input.sourceId,
    input.now,
  );
  const currentRunning = await findRunningSalesProjectionImportRun(db, input.sourceId);

  if (currentRunning) {
    return skippedProjectionImportResult(input.sourceId, currentRunning, staleRunningImportsFailed);
  }

  try {
    const [run] = await db
      .insert(schema.salesDashboardProjectionImportRuns)
      .values({
        sourceId: input.sourceId,
        status: "running",
        triggerType: input.triggerType,
        actorEmail: input.actorEmail,
        startedAt: input.now,
      })
      .returning({ id: schema.salesDashboardProjectionImportRuns.id });

    return { runId: run.id, staleRunningImportsFailed };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }

    const running = await findRunningSalesProjectionImportRun(db, input.sourceId);
    if (!running) {
      throw err;
    }

    return skippedProjectionImportResult(input.sourceId, running, staleRunningImportsFailed);
  }
}
```

2. `src/lib/sales-dashboard/data.ts` (SD-03). Four edits:

 a. Import block (L38-46): replace

```ts
import {
  acquireSalesImportRun,
  failStaleSalesDashboardImports,
  type SalesDashboardImportOutcome,
} from "./import-guard";
```

with

```ts
import {
  acquireSalesImportRun,
  acquireSalesProjectionImportRun,
  failStaleSalesDashboardImports,
  type SalesDashboardImportOutcome,
  type SalesDashboardProjectionImportOutcome,
} from "./import-guard";
```

 b. In `importSalesDashboardProjectionSource`, add the return annotation and replace the raw insert with the guard. Replace

```ts
  db: Database = getDb(),
) {
  const source = await getActiveSalesDashboardProjectionSource(db);
  if (!source || source.id !== sourceId) throw new Error("Sales dashboard projection source not found");
  const now = options.now ?? new Date();
  const [run] = await db
    .insert(schema.salesDashboardProjectionImportRuns)
    .values({
      sourceId: source.id,
      status: "running",
      triggerType: options.triggerType,
      actorEmail: options.actorEmail,
      startedAt: now,
    })
    .returning();

  await db
```

(this exact text occurs once, inside `importSalesDashboardProjectionSource`) with

```ts
  db: Database = getDb(),
): Promise<SalesDashboardProjectionImportOutcome> {
  const source = await getActiveSalesDashboardProjectionSource(db);
  if (!source || source.id !== sourceId) throw new Error("Sales dashboard projection source not found");
  const now = options.now ?? new Date();
  const guard = await acquireSalesProjectionImportRun(db, {
    sourceId: source.id,
    triggerType: options.triggerType,
    actorEmail: options.actorEmail,
    now,
  });

  // A skipped request must not touch the source row (the running import owns lastImportError).
  if (guard.skipped) {
    return guard;
  }

  const run = { id: guard.runId };

  await db
```

 c. Success result: replace (the only place `projectionMonths: parsed.months.length,` appears, directly before the `} catch (error) {` of that function)

```ts
      projectionMonths: parsed.months.length,
      targetMonthlyRevenue: parsed.targetMonthlyRevenue,
    };
  } catch (error) {
```

with

```ts
      projectionMonths: parsed.months.length,
      targetMonthlyRevenue: parsed.targetMonthlyRevenue,
      staleRunningImportsFailed: guard.staleRunningImportsFailed,
    };
  } catch (error) {
```

 d. Active-source wrapper: replace

```ts
export async function importActiveSalesDashboardProjectionSource(
  options: ImportOptions,
  db: Database = getDb(),
) {
```

with

```ts
export async function importActiveSalesDashboardProjectionSource(
  options: ImportOptions,
  db: Database = getDb(),
): Promise<SalesDashboardProjectionImportOutcome | null> {
```

 Everything else in the `try` and `catch` blocks stays unchanged. The three entry routes (`projection-import/route.ts`, `internal/sync-sales-dashboard/route.ts`, the data-health run-job) need NO change: they pass the outcome through (`{ ok: true, result }` / nested `projectionResult`), and `cron-audit.ts` links `projectionResult.runId`.

3. `src/components/sales-dashboard/sales-dashboard-shell.tsx` (SD-04). In `importProjectionSource` (L241-246) replace the two lines inside `runAction`

```ts
      const payload = await postJson("/api/sales-dashboard/projection-import") as { result?: { projectionMonths?: number; targetMonthlyRevenue?: number } };
      setMessage(`Projection refreshed: ${payload.result?.projectionMonths ?? 0} monthly scenario rows imported.`);
```

with

```ts
      const payload = await postJson("/api/sales-dashboard/projection-import") as { result?: { projectionMonths?: number; targetMonthlyRevenue?: number; skipped?: boolean; message?: string } };
      setMessage(
        payload.result?.skipped
          ? payload.result.message ?? "Projection import is already running."
          : `Projection refreshed: ${payload.result?.projectionMonths ?? 0} monthly scenario rows imported.`,
      );
```

Nothing else in the component changes. There is no component test for this shell handler (a one-line message switch); typecheck and eslint cover it.

C. Run the suite (GREEN, 17 passing), then the verify command. Read the edited `importSalesDashboardProjectionSource` once to confirm `if (guard.skipped) { return guard; }` precedes the `.set({ lastImportError: null, ... })` source update. Commit exactly these four files:

```
fix(260929-lnu): single-flight guard for sales dashboard projection imports

importSalesDashboardProjectionSource inserted its running row with no
pre-check, catch or stale cleanup. A race returned 500, and a timeout-killed run
left a running row that made every later projection import hit
sdpir_source_single_running_idx, so the 10,40 sales cron returned 500 forever.
Add acquireSalesProjectionImportRun and failStaleSalesDashboardProjectionImports
to import-guard.ts (shared 20-minute lease, cause-aware unique-violation
handling) and use them in data.ts, returning a skipped outcome before the
source row is touched. The dashboard shows the skip message instead of
"0 monthly scenario rows imported".

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/Scheduling-single-flight-guards && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run --project unit src/lib/sales-dashboard src/app/api/sales-dashboard src/app/api/internal/sync-sales-dashboard "src/app/api/data-health/jobs/[jobKey]/run/__tests__/route.test.ts" && npm run typecheck && npx eslint src/lib/sales-dashboard/import-guard.ts src/lib/sales-dashboard/data.ts src/components/sales-dashboard/sales-dashboard-shell.tsx src/lib/sales-dashboard/__tests__/import-guard.test.ts && git diff --check && grep -n 'acquireSalesProjectionImportRun(db' src/lib/sales-dashboard/data.ts && ! git diff -- src/lib/sales-dashboard/import-guard.ts | grep -E '^[-+].*(candidate\.code|cause\?\.code)'</automated>
  </verify>
  <done>All 8 new projection-guard cases pass (they fail against the untouched source) alongside the six existing monthly cases and the three lease cases; the sales route suites, the internal sync-sales-dashboard route suite and the data-health job-runner suite still pass; typecheck and eslint are clean; `data.ts` returns the skipped outcome before the source-row update and its return types are annotated; the shell shows the skip message; jy4's `isUniqueViolation` body in import-guard.ts is unchanged; committed as `fix(260929-lnu): single-flight guard for sales dashboard projection imports` touching only the four listed files.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Cron / admin request to the sync entry routes | Entry is gated by the constant-time `CRON_SECRET` or a signed-in admin session; unchanged by this plan |
| Application to Postgres single-flight partial unique indexes | The database index is the arbiter of "one run at a time"; the sweep, pre-check and catch only improve the outcome and never replace it |
| Skipped / already-running signal to cron audit and data-health | The `skipped: true` flag and the substring "already running" drive outcome classification (skipped vs failed) and HTTP 409/202 mapping |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-lnu-01 | Denial of service | unearned_revenue_sync_runs / sales_dashboard_projection_import_runs `running` row left by a timeout-killed run | mitigate | 20-minute lease sweep at the start of every run marks the stale row `failed` (finishedAt + explicit errorSummary) and the run proceeds; unearned revenue stops skipping forever and the sales cron stops returning 500 forever (Tasks 1, 3 tests) |
| T-lnu-02 | Denial of service | Reclaiming a LIVE run because the lease is too short | mitigate | Lease (20 min) exceeds the 800 s `maxDuration` of every entry route; asserted by tests that read each route's `maxDuration` from source text (Tasks 1, 3), so a route raising its ceiling past the lease fails the suite |
| T-lnu-03 | Tampering (data integrity) | Two concurrent imports writing the same tables | mitigate | Pre-check plus insert; the partial unique indexes (unchanged) remain the arbiter, and a race loser returns skipped / throws already-running without ever proceeding to write |
| T-lnu-04 | Spoofing (outcome misclassification) | A genuine database failure reported as "already running" or skipped | mitigate | Only SQLSTATE 23505 (own `.code` or `.cause.code`) is treated as the race; unearned revenue and sales re-read to confirm a running row exists, otherwise rethrow the ORIGINAL error; competitor has only the uuid PK and the single-running index as unique constraints; every non-unique failure is rethrown verbatim and asserted (wrapped 23503, raw 23503, no-cause, null, string) so it still surfaces as HTTP 500 / failed audit |
| T-lnu-05 | Repudiation | Reclaimed runs disappearing from history | mitigate | Stale runs are updated to `failed` with `finishedAt` and the "still running after 20 minutes" errorSummary, never deleted, so Data Health and the run tables keep the audit trail |
| T-lnu-06 | Tampering | A skipped projection request overwriting the source row's `lastImportError` / `updatedAt` while the winning import is mid-run | mitigate | `guard.skipped` early return precedes the source update in `importSalesDashboardProjectionSource` (verified by reading the edited function; the orchestration function has no unit seam) |
| T-lnu-07 | Information disclosure | Skipped bodies expose the blocking run id and start time | accept | Visible only to `CRON_SECRET` holders and signed-in admins; the same shape credit-control and wise-sync already return; no student data, tokens or secrets |
</threat_model>

<verification>
Run from `/Users/kevinhsieh/Developer/Scheduling-single-flight-guards` with `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`:
1. `npm run typecheck`
2. `npm run lint`
3. Affected suites: `npx vitest run --project unit src/lib/unearned-revenue src/lib/competitor-intelligence src/lib/sales-dashboard src/app/api/sales-dashboard src/app/api/internal/sync-sales-dashboard src/app/api/competitor-intelligence src/lib/data-health/__tests__/cron-registry.test.ts "src/app/api/data-health/jobs/[jobKey]/run/__tests__/route.test.ts"`
4. `npm test` (full unit project; the project rule is that all existing Vitest files keep passing)
5. `git diff --check`
6. Grep checks: `grep -nE '^ +staleRunningSyncsFailed,$' src/lib/unearned-revenue/sync.ts` (3 lines); `grep -n 'COMPETITOR_SYNC_ALREADY_RUNNING_ERROR' src/lib/competitor-intelligence/sync.ts` (3 lines); `grep -n 'acquireSalesProjectionImportRun(db' src/lib/sales-dashboard/data.ts` (1 line); `git diff 222e2e3..HEAD -- src/lib/unearned-revenue/sync.ts src/lib/sales-dashboard/import-guard.ts | grep -E '^[-+].*(candidate\.code|cause\?\.code)'` prints nothing (jy4's `isUniqueViolation` bodies untouched).
7. Blockers (must find nothing): `git diff 222e2e3..HEAD --name-only -- src | xargs grep -nE '\.(only|skip)\(|TODO|FIXME'`; also confirm by reading that no changed test is a stub or an unconditional assertion.
8. `git log --oneline 222e2e3..HEAD` shows exactly three commits (`fix(260929-lnu): reclaim stale unearned-revenue sync runs and name the blocking run`, `fix(260929-lnu): map a lost competitor sync insert race to already running`, `fix(260929-lnu): single-flight guard for sales dashboard projection imports`), each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `git diff 222e2e3..HEAD --stat` lists exactly the nine files in `files_modified` and nothing under `.planning/`; `git status --short` shows only `.planning/quick/260929-lnu-*`.
</verification>

<success_criteria>
- Unearned revenue: a `running` row older than 20 minutes is failed by the next run, which proceeds under a new run id; a skipped run names the blocking run (id, startedAt, message) and reports `staleRunningSyncsFailed`; a lost race re-reads the winner or rethrows the original error; the HTTP 202 mapping in both routes is untouched.
- Competitor intelligence: a lost run-insert race (raw, wrapped, real DrizzleQueryError) throws the exact pre-check "already running" error so the routes answer 409 and cron audit records skipped; non-unique failures still answer 500; no route file changed.
- Sales projection: a second projection import (pre-check or race) returns a skipped outcome naming the blocking run; stale runs are reclaimed after 20 minutes so the sales cron stops 500ing; the source row is untouched by a skipped request; the dashboard prints the skip message.
- Each lease is asserted to exceed the 800 s `maxDuration` of every entry route.
- typecheck, lint, the affected suites, the full unit project and `git diff --check` pass; three commits, nine files, no `.planning` files committed.
</success_criteria>

<source_audit>
| Source | ID | Item | Task | Status |
|--------|----|------|------|--------|
| GOAL | - | Fix three deviant `*_sync_runs` single-flight guards: unearned-revenue stale lease + blocking-run id on skip; competitor lost-insert-race 23505 to already-running; sales-dashboard projection import single-flight guard | 1-3 | COVERED |
| REQ | SFG-UR-STALE-LEASE | Stale `running` unearned-revenue row reclaimed after 20 minutes | 1 | COVERED |
| REQ | SFG-UR-BLOCKING-RUN-ID | Skipped result names the blocking run (id, startedAt, message) | 1 | COVERED |
| REQ | SFG-CI-RACE-ALREADY-RUNNING | Competitor lost insert race maps to the existing already-running error | 2 | COVERED |
| REQ | SFG-SD-PROJECTION-SINGLE-FLIGHT | Projection import gets stale sweep, pre-check, cause-aware catch, skipped outcome | 3 | COVERED |
| REQ | SFG-SD-SKIPPED-UI | Dashboard shows the skip message rather than "0 ... imported" | 3 | COVERED |
| RESEARCH | - | None (quick task, no research phase); orchestrator-verified findings 1-3 in the task brief are the source | - | n/a |
| CONTEXT | G-01..G-06 | Private per-module helpers, 20-minute lease, `startedAt: now`, test conventions, commit format, verification | 1-3 | COVERED |
| CONTEXT | UR-01..UR-07 | Constant + error text, three private helpers, extended result type, blocking-run skipped shape, flow with verbatim jy4 `isUniqueViolation`, `and`/`lt` imports, test cases a-f | 1 | COVERED |
| CONTEXT | CI-01..CI-04 | Shared already-running text, private cause-aware check, wrap only the insert (no re-read, no route change), lib + route tests | 2 | COVERED |
| CONTEXT | SD-01..SD-05 | Types, error text, per-source stale sweep, private helpers, `acquireSalesProjectionImportRun`, data.ts wiring + annotations, shell message, tests incl. lease invariant | 3 | COVERED |
| CONTEXT | Coordination | Branch stacked on jy4 tip 222e2e3; re-stack with `git rebase --onto <new jy4 tip> 222e2e3` if jy4 is rewritten | context | COVERED |
| Exclusion | - | Route edits, unearned-revenue UI change, competitor re-read, schema/migration, hand-edited docs | - | OUT OF SCOPE (locked: routes already map skipped/409; the unearned-revenue dashboard reads only `ok` / `errorSummary`, so the added optional fields are safe; docs are regenerated) |
</source_audit>

<output>
After completion, create `/Users/kevinhsieh/Developer/Scheduling-single-flight-guards/.planning/quick/260929-lnu-fix-three-deviant-sync-run-single-flight/260929-lnu-SUMMARY.md` (do not stage or commit it). Include:
- Per-task commits (hashes), files changed, and new/changed test counts (unearned-revenue suite 13 cases; competitor 7 new lib cases + 2 route cases; sales 8 new projection cases + 3 lease cases) and whether each new suite failed RED against the untouched source as expected (11 of 13, 4 of 11, 8 of 17).
- Any deviation from the plan's snippets and why (for example a typecheck or eslint adjustment in the real worktree).
- Deploy notes for the owner: (1) no migration, env or `vercel.json` change; the existing partial unique indexes are untouched. (2) Behavior change: unearned-revenue skipped responses (HTTP 202) now carry the blocking run's id and message, so cron audit `linkedRunIds.syncRunId` is populated for skips; the sales cron's projection step now returns HTTP 200 with a nested skipped `projectionResult` on a race instead of 500. (3) After deploy, any `running` row older than 20 minutes in `unearned_revenue_sync_runs` or `sales_dashboard_projection_import_runs` is failed by the next invocation with the "still running after 20 minutes" errorSummary; expect one such `failed` row per table if a stuck row exists today (read-only check beforehand: `select id, started_at from unearned_revenue_sync_runs where status = 'running'`, and the same for `sales_dashboard_projection_import_runs`).
- Coordination: this branch contains jy4's two code commits and its docs commit; jy4 must merge first, and if it is rewritten, re-stack with `git rebase --onto <new jy4 tip> 222e2e3`.
</output>
