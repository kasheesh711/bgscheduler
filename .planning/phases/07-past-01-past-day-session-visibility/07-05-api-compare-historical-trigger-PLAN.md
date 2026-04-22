---
phase: 07-past-01-past-day-session-visibility
plan: 05
type: execute
wave: 3
depends_on:
  - 01
  - 03
  - 04
files_modified:
  - src/app/api/compare/route.ts
autonomous: true
requirements:
  - PAST-01
  - PAST-04

must_haves:
  truths:
    - "`/api/compare` computes `isHistoricalRange = dateRange.start < startOfTodayBkk()` once per request — server-side (D-07, client stays dumb)"
    - "When `isHistoricalRange` is true, the route calls `fetchPastSessionBlocks(sortedCanonicalKeys, dateRange.start, dateRange.end)` once and passes per-group slices into `buildCompareTutor` via the new `pastBlocks` parameter"
    - "`findSharedFreeSlots` sees past blocks: the route pre-merges past blocks into a cloned group object before calling `findSharedFreeSlots` (closes Pitfall 16)"
    - "When NOT historical (range entirely today or future), behavior is IDENTICAL to pre-Phase-7 (no fetcher call, no merge, no cost)"
    - "Request shape (Zod schema, fetchOnly semantics, response shape) is UNCHANGED — client code needs no edits"
  artifacts:
    - path: "src/app/api/compare/route.ts"
      provides: "Server-side historical-range trigger integration"
      contains: "fetchPastSessionBlocks"
  key_links:
    - from: "src/app/api/compare/route.ts line ~108"
      to: "src/lib/data/past-sessions.ts fetchPastSessionBlocks"
      via: "conditional await on isHistoricalRange"
      pattern: "await fetchPastSessionBlocks\\("
    - from: "src/app/api/compare/route.ts"
      to: "src/lib/search/compare.ts buildCompareTutor"
      via: "pastBlocksByCanonicalKey.get(g.canonicalKey) as 4th argument"
      pattern: "buildCompareTutor\\(g, weekdays, dateRange, pastBlocksByCanonicalKey"
---

<objective>
Wire the per-request historical-range trigger into `/api/compare` (D-07). The route derives historical-ness from `dateRange.start` vs `startOfTodayBkk()`, batch-fetches past session blocks by canonical-key array when applicable, and passes per-group slices into both `buildCompareTutor` (via the new `pastBlocks` param from Plan 04) and a cloned-group-object version of `findSharedFreeSlots` (closing Pitfall 16).

Client surface is unchanged — no new request parameter, no changes to `useCompare.ts`. This is the "server derives truth, client stays dumb" wiring (D-07).

Purpose: PAST-01 (past-day compare view shows real data) + PAST-04 (weekday-fallback replaced by honest empty for historical days) — the final integration step that turns Plans 01-04 into a user-visible behavior change.

Output: Modified `src/app/api/compare/route.ts` with ~15 new lines (sorted canonical-keys, conditional fetch, per-group past-blocks arg, cloned groups for findSharedFreeSlots).
</objective>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Client request → /api/compare | Already auth-gated via `src/middleware.ts` + Auth.js session check (line 47) |
| Zod-validated request → internal types | Unchanged in this plan — same `compareRequestSchema` |
| Route → past-sessions fetcher | Server-to-server call, typed via Plan 03 exports |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-05-01 | Spoofing | Unauthenticated client requests historical data | mitigate | `auth()` at line 47 returns 401 if no session; `past_session_blocks` read is gated by the same auth boundary as the rest of /api/compare. No bypass path. |
| T-07-05-02 | Tampering | SQL injection via canonicalKeys passed to fetchPastSessionBlocks | mitigate | canonicalKeys come from `IndexedTutorGroup.canonicalKey` (Plan 04) which is populated from Drizzle-typed DB reads; no user-controllable string path. The fetcher itself uses `inArray` parameterization (Plan 03 T-07-03-01). |
| T-07-05-03 | Information Disclosure | Unauthorized access to past student PII (name, location) for historical weeks | mitigate | Same auth boundary as existing /api/compare response for future sessions. No new exposure surface — past sessions are identical in structure and auth-gating. |
| T-07-05-04 | Denial of Service | Attacker triggers many historical-range requests to thrash cache | mitigate | Route has no user-specifiable rate limit beyond Vercel's platform defaults; `'use cache'` wrapper at Plan 03 + `cacheLife('days')` provides amortization. Zod schema caps `tutorGroupIds.max(3)` limits per-request fan-out. |
| T-07-05-05 | Information Disclosure | Response shape change accidentally leaks canonicalKey to client | mitigate | Route returns `CompareResponse` (existing shape). `CompareTutor` type at `src/lib/search/types.ts` has no `canonicalKey` field; buildCompareTutor does not propagate it. Verified via acceptance criterion. |

All LOW or MEDIUM. No HIGH severity threats.
</threat_model>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md
@.planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md
@src/app/api/compare/route.ts
@src/lib/search/compare.ts
@src/lib/search/index.ts
@src/lib/data/past-sessions.ts

<interfaces>
<!-- Current route (pre-edit) — the target lines are in the try { ... } block -->

From src/app/api/compare/route.ts (lines 97-114) — the integration point:
```typescript
// Compute week range
const mondayDate = weekStartParam ? parseMondayDate(weekStartParam) : getCurrentMonday();
const sundayEnd = addDays(mondayDate, 7);
const dateRange: DateRange = { start: mondayDate, end: sundayEnd };

const weekdays: number[] | undefined =
  dayOfWeek !== undefined ? [dayOfWeek] : date ? [new Date(date).getDay()] : undefined;

const allCompareTutors = indexedGroups.map((g) => buildCompareTutor(g, weekdays, dateRange));
const conflicts = detectConflicts(allCompareTutors, indexedGroups);
const sharedFreeSlots = findSharedFreeSlots(
  indexedGroups,
  weekdays ?? [0, 1, 2, 3, 4, 5, 6],
  dateRange,
);
```

Exports available to the route:
- `fetchPastSessionBlocks(keys, start, end) => Promise<Map<string, IndexedSessionBlock[]>>` — Plan 03
- `buildCompareTutor(g, weekdays, dateRange, pastBlocks?) => CompareTutor` — Plan 04
- `getStartOfTodayBkk() => Date` — Plan 04 (exported helper)
- `IndexedTutorGroup.canonicalKey: string` — Plan 04 (additive field)
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add historical-range trigger + past-blocks plumbing to /api/compare</name>
  <files>src/app/api/compare/route.ts</files>
  <read_first>
    - src/app/api/compare/route.ts (full file — target insertion lines 97-114)
    - src/lib/data/past-sessions.ts (confirm export name/signature)
    - src/lib/search/compare.ts (confirm buildCompareTutor fourth-argument signature + getStartOfTodayBkk export)
    - src/lib/search/index.ts (confirm IndexedTutorGroup.canonicalKey is present)
    - .planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md §"Pattern 5: `/api/compare` server-side historical-range trigger" (code blueprint)
  </read_first>
  <action>
Make three modifications to `src/app/api/compare/route.ts`:

**Modification A — Add imports at the top of the file (after line 7):**

Replace the existing imports starting at line 6:
```typescript
import { buildCompareTutor, detectConflicts, findSharedFreeSlots } from "@/lib/search/compare";
import type { DateRange } from "@/lib/search/compare";
```

With the extended import block:
```typescript
import {
  buildCompareTutor,
  detectConflicts,
  findSharedFreeSlots,
  getStartOfTodayBkk,
} from "@/lib/search/compare";
import type { DateRange } from "@/lib/search/compare";
import { fetchPastSessionBlocks } from "@/lib/data/past-sessions";
import type { IndexedSessionBlock } from "@/lib/search/index";
```

**Modification B — Replace the block at lines 108-114 (the `allCompareTutors` / `detectConflicts` / `findSharedFreeSlots` invocations) with the historical-aware version:**

The current block:
```typescript
const allCompareTutors = indexedGroups.map((g) => buildCompareTutor(g, weekdays, dateRange));
const conflicts = detectConflicts(allCompareTutors, indexedGroups);
const sharedFreeSlots = findSharedFreeSlots(
  indexedGroups,
  weekdays ?? [0, 1, 2, 3, 4, 5, 6],
  dateRange,
);
```

Replace with:
```typescript
// D-07 / PAST-01: historical-range trigger. If ANY day in the requested
// dateRange is before startOfToday (BKK), fetch captured past_session_blocks
// for the selected tutors' canonical keys and merge them into both
// buildCompareTutor (via pastBlocks param) and findSharedFreeSlots (via a
// cloned group with sessionBlocks extended — closes research Pitfall 16).
const startOfTodayBkk = getStartOfTodayBkk();
const isHistoricalRange = dateRange.start < startOfTodayBkk;

let pastBlocksByCanonicalKey = new Map<string, IndexedSessionBlock[]>();
if (isHistoricalRange) {
  // Sort canonical keys for stable cache-key ordering (Plan 03 fetcher
  // relies on argument-hash determinism for efficient cache reuse).
  const canonicalKeys = [...new Set(indexedGroups.map((g) => g.canonicalKey))].sort();
  pastBlocksByCanonicalKey = await fetchPastSessionBlocks(
    canonicalKeys,
    dateRange.start,
    dateRange.end,
  );
}

const allCompareTutors = indexedGroups.map((g) =>
  buildCompareTutor(
    g,
    weekdays,
    dateRange,
    pastBlocksByCanonicalKey.get(g.canonicalKey),
  ),
);
const conflicts = detectConflicts(allCompareTutors, indexedGroups);

// For findSharedFreeSlots: pre-merge past blocks into each group's
// sessionBlocks so the function's existing `group.sessionBlocks` read (line
// 315 of compare.ts) sees the full set. Closes Pitfall 16: without this
// merge, historical-range compare would mark a tutor as "free" during a past
// captured session. Non-historical ranges skip this extra allocation.
const groupsForFreeSlots = isHistoricalRange
  ? indexedGroups.map((g) => {
      const past = pastBlocksByCanonicalKey.get(g.canonicalKey);
      if (!past || past.length === 0) return g;
      return { ...g, sessionBlocks: [...g.sessionBlocks, ...past] };
    })
  : indexedGroups;

const sharedFreeSlots = findSharedFreeSlots(
  groupsForFreeSlots,
  weekdays ?? [0, 1, 2, 3, 4, 5, 6],
  dateRange,
);
```

**Modification C — Do NOT change the Zod schema, response shape, fetchOnly semantics, auth check, error handling, or anything else.** The request body is identical to pre-Phase-7. The `CompareResponse` serialized shape is identical — `canonicalKey` is internal and NOT leaked to the client (Plan 04 added it to `IndexedTutorGroup` only; `CompareTutor` in `src/lib/search/types.ts` is unchanged).

Do NOT wrap the `fetchPastSessionBlocks` call in try/catch — the existing outer `try { ... } catch (err)` at lines 70-138 handles all failures (typed 500 response).
Do NOT issue `revalidateTag` anywhere — this is a read path.
Do NOT add logging beyond existing conventions — if debugging is needed later, add via the `warnings` array mechanism already in place (line 73).
  </action>
  <verify>
    <automated>npm test --run 2>&1 | tail -10 && grep -c "fetchPastSessionBlocks" src/app/api/compare/route.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "import { fetchPastSessionBlocks } from \"@/lib/data/past-sessions\"" src/app/api/compare/route.ts` returns `1`
    - `grep -c "getStartOfTodayBkk" src/app/api/compare/route.ts` returns at least `2` (import + usage)
    - `grep -c "const isHistoricalRange = dateRange.start < startOfTodayBkk" src/app/api/compare/route.ts` returns `1`
    - `grep -c "await fetchPastSessionBlocks(" src/app/api/compare/route.ts` returns `1`
    - `grep -c "pastBlocksByCanonicalKey.get(g.canonicalKey)" src/app/api/compare/route.ts` returns at least `1` (in buildCompareTutor 4th arg)
    - `grep -c "groupsForFreeSlots" src/app/api/compare/route.ts` returns at least `2` (declaration + findSharedFreeSlots arg)
    - `grep -c "compareRequestSchema" src/app/api/compare/route.ts` returns the same count as before the edit (schema UNCHANGED)
    - `grep -c "tutorGroupIds: z.array" src/app/api/compare/route.ts` returns `1` (confirms Zod schema still present, intact)
    - `grep -c "canonicalKey" src/lib/search/types.ts` returns `0` (CompareTutor / CompareSessionBlock DO NOT leak canonicalKey to client)
    - `grep -c "revalidateTag" src/app/api/compare/route.ts` returns `0`
    - `npx tsc --noEmit 2>&1 | grep -c "error TS" | head -1` returns `0`
    - `npm test --run` exits `0` with no decrease in test count vs Plan 04's baseline
  </acceptance_criteria>
  <done>/api/compare computes historical-ness server-side, fetches + merges past blocks into buildCompareTutor and findSharedFreeSlots; Zod schema and response shape unchanged; all tests pass.</done>
</task>

</tasks>

<verification>
- `npm test --run` passes with no regression
- `grep -c "fetchPastSessionBlocks" src/app/api/compare/route.ts` returns `1`
- `grep -c "canonicalKey" src/lib/search/types.ts` returns `0` (not leaked to client response type)
- Manual trace: client-visible request body (Zod parse at line 59) and response body (lines 123-132) have no new fields
</verification>

<success_criteria>
- /api/compare conditionally fetches past_session_blocks when dateRange overlaps the past
- buildCompareTutor called with per-group past blocks via 4th argument
- findSharedFreeSlots called with past-blocks-merged cloned group objects (closes Pitfall 16)
- Non-historical ranges skip the fetch entirely (zero cost regression)
- Client-facing request/response shapes unchanged
- All existing tests continue to pass
</success_criteria>

<output>
After completion, create `.planning/phases/07-past-01-past-day-session-visibility/07-05-SUMMARY.md` documenting:
- Diff summary (approx ~20 lines added to route.ts)
- Exact `isHistoricalRange` trigger line number in the final file
- Confirmation that Zod schema + response shape are byte-identical pre/post
- Any notes on cache hit rate expected (admin-scale)
</output>
