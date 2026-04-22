---
phase: 07-past-01-past-day-session-visibility
plan: 03
type: execute
wave: 2
depends_on:
  - 01
files_modified:
  - src/lib/data/past-sessions.ts
  - src/lib/data/__tests__/past-sessions.test.ts
autonomous: true
requirements:
  - PAST-03

must_haves:
  truths:
    - "A cached server function `fetchPastSessionBlocks` returns past_session_blocks rows bucketed by canonical key, tagged `cacheTag('past-sessions')` with `cacheLife('days')` (D-08)"
    - "`cacheTag('past-sessions')` is SEPARATE from `cacheTag('snapshot')` — daily sync's revalidateTag('snapshot') MUST NOT invalidate past data (PAST-03 / Pitfall 7)"
    - "An inner `fetchPastSessionBlocksUncached` function is exported alongside the cached wrapper, so Vitest can exercise the DB-query behavior without tripping the `'use cache'` directive (research Pitfall 19)"
    - "No source file except `src/lib/data/past-sessions.ts` imports the cached wrapper yet — Plan 05 wires it into /api/compare"
  artifacts:
    - path: "src/lib/data/past-sessions.ts"
      provides: "Cached + uncached fetchers for past_session_blocks"
      exports: ["fetchPastSessionBlocks", "fetchPastSessionBlocksUncached"]
    - path: "src/lib/data/__tests__/past-sessions.test.ts"
      provides: "Tests for the uncached inner function + grep-based tag-hygiene assertion"
      contains: "describe(\"fetchPastSessionBlocksUncached\""
  key_links:
    - from: "src/lib/data/past-sessions.ts (cached wrapper)"
      to: "Next.js cache layer"
      via: "'use cache'; cacheTag('past-sessions'); cacheLife('days')"
      pattern: "cacheTag\\(\"past-sessions\"\\)"
    - from: "src/lib/data/past-sessions.ts (inner)"
      to: "schema.pastSessionBlocks (Postgres)"
      via: "db.select().from(...).where(and(inArray(groupCanonicalKey, keys), gte(startTime, rangeStart), lt(startTime, rangeEnd)))"
      pattern: "inArray\\(schema\\.pastSessionBlocks\\.groupCanonicalKey"
---

<objective>
Create the cached server fetcher that reads from `past_session_blocks` by `(groupCanonicalKeys, dateRange)` and returns rows bucketed by canonical key. Tagged `cacheTag('past-sessions')` per D-08 — SEPARATE from the `'snapshot'` tag so the daily sync's `revalidateTag('snapshot')` does not invalidate immutable past data (PAST-03 closes research Pitfall 7). `cacheLife('days')` matches the daily-sync cadence.

Export both the `'use cache'`-wrapped function AND an inner `*Uncached` function so Vitest can test the DB-query behavior directly (research Pitfall 19 — Vitest cannot spy through the Next.js cache boundary).

Purpose: PAST-03 — the read-path data source for historical compare views. Plan 05 wires this fetcher into `/api/compare`.

Output: New `src/lib/data/past-sessions.ts` with two exports + Vitest tests for the uncached function + grep-based tag-hygiene assertion.
</objective>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Caller (Plan 05) → fetcher arguments | canonicalKeys array + date range; all come from authenticated /api/compare route |
| Fetcher → past_session_blocks reads | Drizzle parameterized SELECT via `inArray`/`gte`/`lt` |
| Next.js cache layer → response | Cache keyed by function arguments (`'use cache'` semantics) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-03-01 | Tampering | SQL injection via groupCanonicalKey strings | mitigate | Drizzle's `inArray(schema.pastSessionBlocks.groupCanonicalKey, keys)` parameterizes the list; no string interpolation. Equivalent to the existing `src/lib/data/filters.ts` pattern. |
| T-07-03-02 | Information Disclosure | Cache served to unauthenticated user | mitigate | /api/compare route (Plan 05 caller) sits behind `src/middleware.ts` auth allowlist; single-tenant app so `'use cache'` has no cross-tenant leak risk (PITFALLS.md §Security). Document single-tenant assumption in file-level comment. |
| T-07-03-03 | Denial of Service | Unbounded canonicalKeys array → huge IN clause | mitigate | /api/compare caps `tutorGroupIds` at 3 via Zod (route.ts:11). Cache hit rate minimizes DB pressure. No additional limit needed here. |
| T-07-03-04 | Information Disclosure | PII (student_name/location) cached in Next.js cache layer | accept | Already accepted for `future_session_blocks` data in compare response. Same data, same auth boundary, same retention semantics. Cache layer is in-memory per-deployment (not CDN); lifespan bounded by `cacheLife('days')`. |
| T-07-03-05 | Tampering | cacheTag drift (developer accidentally types `"snapshot"` instead of `"past-sessions"`) | mitigate | Phase 7 verification step greps for `cacheTag("snapshot")` inside `src/lib/data/past-sessions.ts` and fails if present (see acceptance criteria). |

All LOW/MEDIUM. No HIGH severity threats.
</threat_model>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md
@.planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md
@src/lib/data/filters.ts
@src/lib/data/tutors.ts
@src/lib/db/schema.ts
@src/lib/search/index.ts

<interfaces>
<!-- Reference cache pattern — direct template for new fetcher -->

From src/lib/data/filters.ts (the pattern to clone, tag/life adjusted):
```typescript
import { cacheTag, cacheLife } from "next/cache";
import { getDb } from "@/lib/db";

export async function getFilterOptions(): Promise<FilterOptions> {
  "use cache";
  cacheTag("snapshot");   // ← DIFFERENT in past-sessions.ts: "past-sessions"
  cacheLife("hours");     // ← DIFFERENT in past-sessions.ts: "days"
  // ... query ...
}
```

From src/lib/search/index.ts (line 33-48) — the return-element shape:
```typescript
export interface IndexedSessionBlock {
  startTime: Date;
  endTime: Date;
  weekday: number;
  startMinute: number;
  endMinute: number;
  isBlocking: boolean;
  wiseTeacherId: string;
  title?: string;
  studentName?: string;
  subject?: string;
  classType?: string;
  sessionType?: string;
  recurrenceId?: string;
  location?: string;
}
```

From src/lib/db/schema.ts (Plan 01) — row shape to map from:
```typescript
export const pastSessionBlocks = pgTable("past_session_blocks", {
  groupCanonicalKey: text("group_canonical_key").notNull(),
  wiseTeacherId: text("wise_teacher_id").notNull(),
  wiseSessionId: text("wise_session_id").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  isBlocking: boolean("is_blocking").notNull().default(true),
  title: text("title"),
  sessionType: text("session_type"),
  location: text("location"),
  studentName: text("student_name"),
  subject: text("subject"),
  classType: text("class_type"),
  recurrenceId: text("recurrence_id"),
  // ... other columns
});
```

Verified in 07-RESEARCH.md A2 + node_modules/next/dist/docs/.../cacheLife.md:133-141: `cacheLife('days')` profile = `stale: 5 min, revalidate: 1 day, expire: 1 week`.
Verified in A3 + revalidateTag.md:32: tag strings case-sensitive, different strings don't cross-invalidate.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create src/lib/data/past-sessions.ts with cached + uncached fetchers</name>
  <files>src/lib/data/past-sessions.ts</files>
  <read_first>
    - src/lib/data/filters.ts (full file — direct reference pattern)
    - src/lib/data/tutors.ts (full file — second reference pattern)
    - src/lib/db/schema.ts (lines for pastSessionBlocks added in Plan 01)
    - src/lib/search/index.ts (lines 33-48 IndexedSessionBlock type)
    - .planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md §"Pattern 3: Cached past-sessions fetcher" (verbatim code blueprint)
    - .planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md §"D-08" (cache tag contract)
  </read_first>
  <action>
Create `src/lib/data/past-sessions.ts` with the following exact structure. Two exports: the `'use cache'`-wrapped `fetchPastSessionBlocks` and the inner `fetchPastSessionBlocksUncached` function (per research Pitfall 19 — Vitest cannot introspect the cache boundary).

```typescript
import { cacheTag, cacheLife } from "next/cache";
import { and, inArray, gte, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { IndexedSessionBlock } from "@/lib/search/index";

/**
 * PAST-01 cached fetcher for captured past-session blocks (D-06 / D-08).
 *
 * Cache discipline:
 * - `cacheTag('past-sessions')` — EXPLICITLY SEPARATE from `'snapshot'`. The
 *   daily sync's `revalidateTag('snapshot', { expire: 0 })` MUST NOT invalidate
 *   this cache. Past data is immutable once captured (D-03 first-observation
 *   wins). Manual `revalidateTag('past-sessions')` is reserved for schema
 *   migrations or admin action (no admin utility route in v1.1 per Claude
 *   Discretion).
 * - `cacheLife('days')` — stale 5 min / revalidate 1 day / expire 1 week.
 *   Matches daily-sync cadence; aggressive enough to benefit same-day repeat
 *   queries, conservative enough that a schema migration is noticed within a
 *   week. Verified in-tree at node_modules/next/dist/docs/01-app/.../cacheLife.md:139.
 *
 * Security: this is a single-tenant app; all callers (/api/compare) pass
 * through `src/middleware.ts` auth. No cross-tenant leak risk. PII
 * (student_name/location) stays on the same auth boundary as
 * future_session_blocks.
 *
 * Testability: the inner `fetchPastSessionBlocksUncached` is exported
 * separately so Vitest can spy DB calls without the `'use cache'` boundary
 * obscuring them (research §Common Pitfalls §Pitfall 19). The cached wrapper
 * is intentionally trivial — testing that `cacheTag("past-sessions")` and
 * `cacheLife("days")` appear verbatim is done via grep assertions in the
 * test file and in Phase 7 VERIFICATION.md.
 */
export async function fetchPastSessionBlocksUncached(
  groupCanonicalKeys: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Map<string, IndexedSessionBlock[]>> {
  if (groupCanonicalKeys.length === 0) return new Map();

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pastSessionBlocks)
    .where(and(
      inArray(schema.pastSessionBlocks.groupCanonicalKey, groupCanonicalKeys),
      gte(schema.pastSessionBlocks.startTime, rangeStart),
      lt(schema.pastSessionBlocks.startTime, rangeEnd),
    ));

  // Bucket rows by canonical key so buildCompareTutor can merge per-group.
  const byCanonicalKey = new Map<string, IndexedSessionBlock[]>();
  for (const r of rows) {
    const block: IndexedSessionBlock = {
      startTime: new Date(r.startTime),
      endTime: new Date(r.endTime),
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      isBlocking: r.isBlocking,
      wiseTeacherId: r.wiseTeacherId,
      title: r.title ?? undefined,
      studentName: r.studentName ?? undefined,
      subject: r.subject ?? undefined,
      classType: r.classType ?? undefined,
      sessionType: r.sessionType ?? undefined,
      recurrenceId: r.recurrenceId ?? undefined,
      location: r.location ?? undefined,
    };
    const arr = byCanonicalKey.get(r.groupCanonicalKey) ?? [];
    arr.push(block);
    byCanonicalKey.set(r.groupCanonicalKey, arr);
  }
  return byCanonicalKey;
}

/**
 * Cached wrapper — callers in /api/compare (Plan 05) use THIS function.
 *
 * Cache key determinism: callers should pass a sorted `groupCanonicalKeys`
 * array so reordering of the tutor selection doesn't create unnecessary cache
 * entries. /api/compare route sorts before calling (Plan 05, Pattern 5).
 */
export async function fetchPastSessionBlocks(
  groupCanonicalKeys: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Map<string, IndexedSessionBlock[]>> {
  "use cache";
  cacheTag("past-sessions");
  cacheLife("days");
  return fetchPastSessionBlocksUncached(groupCanonicalKeys, rangeStart, rangeEnd);
}
```

Do NOT add `cacheTag("snapshot")` anywhere in this file — that would defeat the whole purpose of the separate tag (Pitfall 7 violation).
Do NOT add `revalidateTag` calls inside this file.
Do NOT add extra function arguments — signature matches what Plan 05 will call.
Do NOT import from `src/lib/search/compare.ts` or circular-dependency territory — this is a pure DB→type mapper.
  </action>
  <verify>
    <automated>grep -c "cacheTag(\"past-sessions\")" src/lib/data/past-sessions.ts</automated>
  </verify>
  <acceptance_criteria>
    - File `src/lib/data/past-sessions.ts` exists
    - `grep -c "export async function fetchPastSessionBlocksUncached" src/lib/data/past-sessions.ts` returns `1`
    - `grep -c "export async function fetchPastSessionBlocks" src/lib/data/past-sessions.ts` returns `1` (NOTE: grep will match both exports; adjust by searching for the full signature — see next criterion)
    - `grep -c "^export async function fetchPastSessionBlocks(" src/lib/data/past-sessions.ts` returns `1` (only the cached wrapper matches this exact prefix)
    - `grep -c "cacheTag(\"past-sessions\")" src/lib/data/past-sessions.ts` returns `1`
    - `grep -c "cacheLife(\"days\")" src/lib/data/past-sessions.ts` returns `1`
    - `grep -c "\"use cache\"" src/lib/data/past-sessions.ts` returns `1`
    - `grep -c "cacheTag(\"snapshot\")" src/lib/data/past-sessions.ts` returns `0` (REGRESSION GUARD: snapshot tag MUST NOT appear in this file)
    - `grep -c "inArray(schema.pastSessionBlocks.groupCanonicalKey" src/lib/data/past-sessions.ts` returns `1`
    - `grep -c "gte(schema.pastSessionBlocks.startTime" src/lib/data/past-sessions.ts` returns `1`
    - `grep -c "lt(schema.pastSessionBlocks.startTime" src/lib/data/past-sessions.ts` returns `1`
    - `grep -c "revalidateTag" src/lib/data/past-sessions.ts` returns `0`
    - `npx tsc --noEmit 2>&1 | grep -c "error TS" | head -1` returns `0`
  </acceptance_criteria>
  <done>past-sessions.ts exports cached and uncached fetchers with correct tag/life discipline; no snapshot-tag leakage.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Create Vitest tests for fetchPastSessionBlocksUncached + tag-hygiene grep assertion</name>
  <files>src/lib/data/__tests__/past-sessions.test.ts</files>
  <read_first>
    - src/app/api/data-health/__tests__/modality-counter.test.ts (test-pattern reference — avoids next/server import issues)
    - src/lib/data/past-sessions.ts (just-created from Task 1)
    - src/lib/search/__tests__/compare.test.ts (reference test factory style — data-shape construction)
  </read_first>
  <behavior>
    - Test 1: Empty canonical-keys array → returns empty Map immediately (no DB query). Assert via mock-db call count = 0.
    - Test 2: Single canonical key with 3 past sessions in range → returns Map with 1 entry, key = canonical-key, value = array of 3 IndexedSessionBlock objects sorted by startTime.
    - Test 3: Multiple canonical keys with interleaved rows → returns Map with entries bucketed correctly (keyA: 2 blocks, keyB: 1 block, keyC: 0 blocks → keyC not in Map).
    - Test 4: Row `startTime < rangeStart` excluded; row `startTime >= rangeEnd` excluded (range is [start, end)).
    - Test 5: Null nullable columns (e.g., `title=null`, `sessionType=null`) mapped to `undefined` (not `null`) in the output IndexedSessionBlock.
    - Test 6 (tag-hygiene grep assertion): reads the past-sessions.ts source file synchronously via `fs.readFileSync` and asserts:
      - `cacheTag("past-sessions")` appears exactly once
      - `cacheLife("days")` appears exactly once
      - `cacheTag("snapshot")` appears ZERO times (regression guard for Pitfall 7)
  </behavior>
  <action>
Create `src/lib/data/__tests__/past-sessions.test.ts` with the following exact structure. Mock the `@/lib/db` module so `getDb()` returns a test double whose `.select().from().where()` chain returns fixture rows.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fetchPastSessionBlocksUncached } from "../past-sessions";

// Mock db — the fetcher calls `db.select().from(X).where(Y)` and awaits.
// We only need the chain to resolve to the fixture rows we want to test with.
const mockRows: Array<Record<string, unknown>> = [];
const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(mockRows.slice())),
    })),
  })),
};

vi.mock("@/lib/db", () => ({
  getDb: () => mockDb,
}));

// Small helper to construct a past_session_blocks row with defaults.
function makeRow(overrides: Partial<typeof mockRows[number]>): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    groupCanonicalKey: "kevin",
    capturedInSnapshotId: "00000000-0000-0000-0000-0000000000aa",
    wiseTeacherId: "wt1",
    wiseSessionId: "ws1",
    startTime: new Date("2026-04-10T10:00:00+07:00"),
    endTime: new Date("2026-04-10T11:30:00+07:00"),
    weekday: 5,
    startMinute: 600,
    endMinute: 690,
    wiseStatus: "SCHEDULED",
    isBlocking: true,
    title: null,
    sessionType: null,
    location: null,
    studentName: "Alex",
    subject: null,
    classType: null,
    recurrenceId: null,
    capturedAt: new Date("2026-04-11T00:00:00+07:00"),
    ...overrides,
  };
}

describe("fetchPastSessionBlocksUncached", () => {
  beforeEach(() => {
    mockRows.length = 0;
    mockDb.select.mockClear();
  });

  it("returns empty Map and does not call db when canonicalKeys is empty", async () => {
    const result = await fetchPastSessionBlocksUncached(
      [],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    expect(result.size).toBe(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("buckets rows by groupCanonicalKey", async () => {
    mockRows.push(
      makeRow({ groupCanonicalKey: "kevin", wiseSessionId: "s1" }),
      makeRow({ groupCanonicalKey: "kevin", wiseSessionId: "s2" }),
      makeRow({ groupCanonicalKey: "sam", wiseSessionId: "s3" }),
    );
    const result = await fetchPastSessionBlocksUncached(
      ["kevin", "sam"],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    expect(result.size).toBe(2);
    expect(result.get("kevin")).toHaveLength(2);
    expect(result.get("sam")).toHaveLength(1);
  });

  it("omits keys with no rows (bucket not pre-populated)", async () => {
    mockRows.push(makeRow({ groupCanonicalKey: "kevin", wiseSessionId: "s1" }));
    const result = await fetchPastSessionBlocksUncached(
      ["kevin", "sam", "paojuu"],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    expect(result.size).toBe(1);
    expect(result.has("sam")).toBe(false);
    expect(result.has("paojuu")).toBe(false);
  });

  it("maps null nullable columns to undefined on IndexedSessionBlock", async () => {
    mockRows.push(makeRow({
      groupCanonicalKey: "kevin", wiseSessionId: "s1",
      title: null, sessionType: null, location: null, subject: null,
      classType: null, recurrenceId: null,
    }));
    const result = await fetchPastSessionBlocksUncached(
      ["kevin"],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    const block = result.get("kevin")![0];
    expect(block.title).toBeUndefined();
    expect(block.sessionType).toBeUndefined();
    expect(block.location).toBeUndefined();
    expect(block.subject).toBeUndefined();
    expect(block.classType).toBeUndefined();
    expect(block.recurrenceId).toBeUndefined();
  });

  it("preserves non-null nullable columns as typed values", async () => {
    mockRows.push(makeRow({
      groupCanonicalKey: "kevin", wiseSessionId: "s1",
      title: "Math session", studentName: "Alex",
    }));
    const result = await fetchPastSessionBlocksUncached(
      ["kevin"],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    const block = result.get("kevin")![0];
    expect(block.title).toBe("Math session");
    expect(block.studentName).toBe("Alex");
  });
});

describe("past-sessions.ts cache discipline (grep assertion per D-08 / Pitfall 7)", () => {
  const sourcePath = path.resolve(__dirname, "../past-sessions.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  it("tags with 'past-sessions' exactly once", () => {
    const matches = source.match(/cacheTag\("past-sessions"\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("uses cacheLife('days') exactly once", () => {
    const matches = source.match(/cacheLife\("days"\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("does NOT reference cacheTag('snapshot') — regression guard for Pitfall 7", () => {
    const matches = source.match(/cacheTag\("snapshot"\)/g) ?? [];
    expect(matches).toHaveLength(0);
  });

  it("does NOT call revalidateTag (that's the caller's responsibility)", () => {
    const matches = source.match(/revalidateTag\(/g) ?? [];
    expect(matches).toHaveLength(0);
  });
});
```

Do NOT import from `next/server` or `next/cache` directly in the test (Vitest cannot run these without a Next.js runtime shim).
Do NOT mock `next/cache` — the uncached function is the testing target; the cached wrapper is exercised via grep only.
Do NOT add integration-test cases that stand up a real database — the mock-db chain is sufficient for the behavioral tests.
  </action>
  <verify>
    <automated>npm test -- src/lib/data/__tests__/past-sessions.test.ts --run</automated>
  </verify>
  <acceptance_criteria>
    - File `src/lib/data/__tests__/past-sessions.test.ts` exists
    - `grep -c "describe(\"fetchPastSessionBlocksUncached" src/lib/data/__tests__/past-sessions.test.ts` returns `1`
    - `grep -c "describe(\"past-sessions.ts cache discipline" src/lib/data/__tests__/past-sessions.test.ts` returns `1`
    - `grep -c "it(\"" src/lib/data/__tests__/past-sessions.test.ts` returns at least `9` (5 behavioral + 4 grep assertions)
    - `npm test -- src/lib/data/__tests__/past-sessions.test.ts --run` exits `0` with all tests passing
    - `grep -c "vi.mock(\"@/lib/db\"" src/lib/data/__tests__/past-sessions.test.ts` returns `1`
    - `grep -c "fs.readFileSync" src/lib/data/__tests__/past-sessions.test.ts` returns `1`
    - `grep -c "next/server" src/lib/data/__tests__/past-sessions.test.ts` returns `0` (regression guard)
  </acceptance_criteria>
  <done>Test file covers 5 behavioral + 4 tag-hygiene grep-assertion cases; all pass; no next/server import leaks.</done>
</task>

</tasks>

<verification>
- `npm test --run` exits 0 with at least 255 tests passing (246 baseline + Plan 02's 6 + Plan 03's 9)
- `grep -c "cacheTag(\"past-sessions\")" src/lib/data/past-sessions.ts` returns `1`
- `grep -c "cacheTag(\"snapshot\")" src/lib/data/past-sessions.ts` returns `0`
- No file outside `src/lib/data/past-sessions.ts`, `src/lib/data/__tests__/past-sessions.test.ts` modified by this plan
</verification>

<success_criteria>
- `src/lib/data/past-sessions.ts` exports both `fetchPastSessionBlocks` (cached) and `fetchPastSessionBlocksUncached` (inner)
- Cache tag is `'past-sessions'` (NOT `'snapshot'`); cacheLife is `'days'`
- Test file validates bucketing, null-handling, empty-key short-circuit, and tag-hygiene via grep
- No circular imports; no next/server import in test file
</success_criteria>

<output>
After completion, create `.planning/phases/07-past-01-past-day-session-visibility/07-03-SUMMARY.md` documenting:
- New file `past-sessions.ts` (LOC count)
- Test count delta (e.g., 252 → 261 if Plan 02 landed first, or equivalent)
- Grep-hygiene assertion results (confirm `cacheTag("snapshot")` count = 0 in the fetcher source)
- Any discoveries re: Drizzle `inArray` typing or Neon HTTP driver quirks observed
</output>
