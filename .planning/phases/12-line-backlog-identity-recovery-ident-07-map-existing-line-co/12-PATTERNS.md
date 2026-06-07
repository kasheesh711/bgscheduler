# Phase 12: LINE Backlog Identity Recovery (IDENT-07) — Pattern Map

**Mapped:** 2026-06-07
**Files analyzed:** 8 (4 new, 4 modified)
**Analogs found:** 8 / 8

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/line/backlog-matcher.ts` (NEW) | pure-logic utility | transform | `src/lib/line/name-matcher.ts` | exact |
| `src/lib/line/__tests__/backlog-matcher.test.ts` (NEW) | test | — | `src/lib/line/__tests__/name-matcher.test.ts` + `name-matcher.eval.test.ts` | exact |
| `src/lib/db/schema.ts` (MODIFIED — C2) | schema/migration | CRUD | `wiseActivitySyncRuns` table at `src/lib/db/schema.ts:280-298` | exact |
| `src/app/api/internal/line-backlog-recovery/route.ts` (NEW — C2) | route | request-response | `src/app/api/internal/sync-wise-activity/route.ts` | exact |
| `src/lib/line/student-links.ts` (MODIFIED) | service/data-access | CRUD | self — insert pattern at lines 467-522 | self-analog |
| `src/lib/line/client.ts` (MODIFIED) | service | request-response | `fetchLineFollowerIds` at `src/lib/line/client.ts:68-88` | self-analog |
| `src/lib/line/name-matcher.ts` (MODIFIED) | pure-logic utility | transform | self — drop lines 227-250 (Step 3) | self-analog |
| `src/app/api/line/contacts/followers-reanchor/route.ts` (MODIFIED) | route | request-response | self — current 26-line route | self-analog |

---

## Pattern Assignments

### `src/lib/line/backlog-matcher.ts` (NEW — pure-logic, transform)

**Analog:** `src/lib/line/name-matcher.ts` (full file, 270 lines — read in one pass above)

**File-header JSDoc pattern** (lines 1-14):
```typescript
/**
 * Pure-TypeScript deterministic name matcher for LINE student identity resolution.
 *
 * Converts AI-extracted `studentName`/`parentName` strings into scored
 * `NameMatchCandidate[]` against a student directory using a three-tier pipeline:
 *   1. Exact NFKC match (highest confidence)
 *   2. Token subset match (medium confidence)
 *   3. Levenshtein ≤ 2 fuzzy match (low confidence)
 *
 * Fail-closed invariant: this module performs NO DB writes and never auto-confirms a link.
 * It returns scored suggestions only; callers must route them through admin review.
 *
 * No DB imports — all functions are pure transformations.
 */
```
Copy this style verbatim — replace the numbered tier list with the distinctive-token algorithm description. Keep the two-line invariant comment block at the bottom of the JSDoc.

**Section-separator style** (name-matcher.ts lines 18, 32, 40, 95, 106):
```typescript
// ─── Types ────────────────────────────────────────────────────────────────────
// ─── Threshold constants ──────────────────────────────────────────────────────
// ─── Helpers ──────────────────────────────────────────────────────────────────
// ─── Score table ──────────────────────────────────────────────────────────────
// ─── Core matcher ─────────────────────────────────────────────────────────────
```
Use identical em-dash bar style for sections in `backlog-matcher.ts`.

**Imports pattern** — name-matcher.ts has exactly ONE import (line 16):
```typescript
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";
```
`backlog-matcher.ts` needs to import from `student-links.ts` as well — at minimum `normalizeLineStudentCode` and `nicknameCodes` (once exported). Also import `normalizeForNameMatch` from `name-matcher.ts` for display-name tokenization. No DB imports anywhere in this file.

**Types pattern** (lines 20-30 of name-matcher.ts):
```typescript
export interface NameMatchCandidate {
  student: LineStudentDirectoryRow;
  score: number;
  matchBasis:
    | "student_name_exact"
    | "parent_name_exact"
    | "student_name_token"
    | "parent_name_token"
    | "student_name_fuzzy"
    | "parent_name_fuzzy";
}
```
Mirror this for `backlog-matcher.ts` — define a `BacklogMatchResult` interface with: `lineUserId: string`, `displayName: string`, `matchedStudentKey: string`, `studentName: string`, `lineChatUrl: string | null`, `confidence: "high" | "ambiguous"`, `tokens: string[]`. Export it.

**Exported pure-function shape** (name-matcher.ts lines 146-150):
```typescript
export function matchNamesToDirectory(
  names: { studentName?: string | null; parentName?: string | null },
  students: LineStudentDirectoryRow[],
): NameMatchCandidate[] {
  if (students.length === 0) return [];
```
Mirror this: `backlog-matcher.ts` exports three functions:
1. `export function distinctiveTokens(name: string): string[]` — extracts ≥4-char tokens
2. `export function buildTargetTokenIndex(targets: VerifiedResolverTarget[]): Map<string, Set<string>>` — returns `Map<normalizedToken, Set<studentKey>>`
3. `export function matchFollowersToTargets(followers: LineProfile[], index: Map<string, Set<string>>, targetsByStudentKey: Map<string, VerifiedResolverTarget>): BacklogMatchResult[]`

**Internal `consider()` accumulator pattern** (name-matcher.ts lines 171-189):
```typescript
function consider(
  student: LineStudentDirectoryRow,
  score: number,
  matchBasis: NameMatchCandidate["matchBasis"],
  viaStudentName: boolean,
): void {
  if (score < SUGGEST_SHORTLIST_MIN_SCORE) return;
  // ...
  const existing = candidateMap.get(student.studentKey);
  if (!existing || score > existing.score) {
    candidateMap.set(student.studentKey, { student, score, matchBasis });
  }
}
```
In `matchFollowersToTargets`, use a similar accumulator `Map<studentKey, BacklogMatchResult>` to deduplicate matches per follower.

**Normalization reuse** (name-matcher.ts lines 53-61):
```typescript
export function normalizeForNameMatch(value: string): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9ก-๙]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
```
Use `normalizeForNameMatch` (from `name-matcher.ts`) for tokenizing follower display names (preserves spaces). Use `normalizeLineStudentCode` (from `student-links.ts`) for normalizing individual tokens from target rows.

**`nicknameCodes` logic** (student-links.ts lines 310-315 — currently unexported):
```typescript
function nicknameCodes(value: string): string[] {
  const matches = [...value.matchAll(/\(([^)]+)\)/g)];
  return matches
    .map((match) => normalizeLineStudentCode(match[1] ?? ""))
    .filter(Boolean);
}
```
This function must be exported from `student-links.ts` as part of the student-links.ts modifications. `backlog-matcher.ts` then imports it directly.

---

### `src/lib/line/__tests__/backlog-matcher.test.ts` (NEW — test)

**Analog A:** `src/lib/line/__tests__/name-matcher.test.ts` (unit fixture style)
**Analog B:** `src/lib/line/__tests__/name-matcher.eval.test.ts` (eval/precision fixture style)

**Imports pattern** (name-matcher.test.ts lines 1-10):
```typescript
import { describe, expect, it } from "vitest";
import {
  levenshtein,
  matchNamesToDirectory,
  normalizeForNameMatch,
  SUGGEST_SHORTLIST_MIN_SCORE,
  SUGGEST_SINGLE_MIN_SCORE,
  type NameMatchCandidate,
} from "@/lib/line/name-matcher";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";
```
Mirror: import all exported functions from `@/lib/line/backlog-matcher` and any needed types.

**Fixture helper pattern** (name-matcher.test.ts lines 14-25):
```typescript
function student(overrides: Partial<LineStudentDirectoryRow>): LineStudentDirectoryRow {
  return {
    wiseStudentId: "wise-default",
    studentKey: "default::parent",
    studentName: "Default Student",
    parentName: "Default Parent",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
    ...overrides,
  };
}
```
Create analogous helpers: a `target(overrides)` factory for `VerifiedResolverTarget` and a `follower(overrides)` factory for `LineProfile`.

**Section-header style** (name-matcher.test.ts lines 12, 27, 39, 73):
```typescript
// ─── Helpers ───────────────────────────────────────────────────────────────────
// ─── Constants ─────────────────────────────────────────────────────────────────
// ─── normalizeForNameMatch ──────────────────────────────────────────────────────
// ─── levenshtein ───────────────────────────────────────────────────────────────
```
Use identical em-dash section headers, one `describe` block per exported function.

**`describe`/`it` block structure** (name-matcher.test.ts lines 41-71 for one function):
```typescript
describe("normalizeForNameMatch", () => {
  it("lowercases and trims romanized names", () => {
    expect(normalizeForNameMatch("Nicha Suwanprasert")).toBe("nicha suwanprasert");
  });
  // ... more it() blocks per edge case
});
```
Use the same `describe`/`it` structure per function: `distinctiveTokens`, `buildTargetTokenIndex`, `matchFollowersToTargets`.

**Eval fixture style** (name-matcher.eval.test.ts lines 46-100+):
```typescript
const MOCK_DIRECTORY: LineStudentDirectoryRow[] = [
  {
    wiseStudentId: "wise-nicha",
    studentKey: "nicha.sw::parent",
    studentName: "Nicha Suwanprasert",
    parentName: "คุณแม่นิชา",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
  },
  // ... 20+ mock rows
```
For `backlog-matcher.test.ts`, create an analogous `MOCK_TARGETS` array of `VerifiedResolverTarget` rows with hand-crafted distractors.

**Required test cases for `matchFollowersToTargets`:**
- Unambiguous match: exactly one student key from token index → `confidence: "high"`
- Ambiguous match: two student keys from the same token → `confidence: "ambiguous"`, never collapsed
- No match: display name with no ≥4-char token hit → empty result or zero high-confidence
- Empty display name: `""` or whitespace-only → no crash, zero results
- `lineChatUrl: null` target: match still recorded, `lineChatUrl` passes through as `null`

---

### `src/lib/db/schema.ts` (MODIFIED — C2, `lineBacklogRecoverySyncRuns` table)

**Analog:** `wiseActivitySyncRuns` at `src/lib/db/schema.ts:280-298`

**Table definition pattern** (schema.ts lines 280-298):
```typescript
export const wiseActivitySyncRuns = pgTable("wise_activity_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: syncStatusEnum("status").notNull().default("running"),
  triggerType: text("trigger_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  // ... domain-specific counters ...
  errorSummary: text("error_summary"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  uniqueIndex("wise_activity_sync_runs_single_running_idx")
    .on(table.status)
    .where(sql`${table.status} = 'running'`),
  index("wise_activity_sync_runs_status_started_idx").on(table.status, table.startedAt),
]);
```

**New table to add** — mirror exactly, substituting domain-specific counters:
```typescript
export const lineBacklogRecoverySyncRuns = pgTable("line_backlog_recovery_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: syncStatusEnum("status").notNull().default("running"),
  triggerType: text("trigger_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  followerCount: integer("follower_count").notNull().default(0),
  targetsCount: integer("targets_count").notNull().default(0),
  matchedCount: integer("matched_count").notNull().default(0),
  insertedCount: integer("inserted_count").notNull().default(0),
  dryRun: boolean("dry_run").notNull().default(false),
  errorSummary: text("error_summary"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  uniqueIndex("line_backlog_recovery_sync_runs_single_running_idx")
    .on(table.status)
    .where(sql`${table.status} = 'running'`),
  index("line_backlog_recovery_sync_runs_status_started_idx").on(table.status, table.startedAt),
]);
```

**Insertion point in schema.ts:** Place after the LINE-domain tables block, near `lineOaResolverRows` (around line 1893). The `syncStatusEnum` is already declared near the top of schema.ts — reuse it.

**Migration workflow (from RESEARCH.md §Schema + Migration):**
```bash
npm run db:generate
# Then: inspect generated drizzle/0041_*.sql
# Verify: grep -E 'CREATE (TABLE|INDEX)|ADD CONSTRAINT' drizzle/0041_*.sql | grep -v line_backlog
# Should produce zero lines — no catch-up noise
DATABASE_URL=... npm run db:migrate
```

---

### `src/app/api/internal/line-backlog-recovery/route.ts` (NEW — C2, cron route)

**Analog:** `src/app/api/internal/sync-wise-activity/route.ts` (37 lines, read in full)

**Full route pattern** (sync-wise-activity/route.ts lines 1-36):
```typescript
import { NextRequest, NextResponse } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { getDb } from "@/lib/db";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { createWiseClient } from "@/lib/wise/client";
import { syncWiseActivityEvents, WiseActivitySyncAlreadyRunningError } from "@/lib/wise-activity/sync";

export const maxDuration = 800;

const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;

  return withCronInvocationAudit(
    { jobKey: "wise_activity", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await syncWiseActivityEvents(
          getDb(),
          createWiseClient(),
          process.env.WISE_INSTITUTE_ID ?? DEFAULT_INSTITUTE_ID,
          { triggerType: "cron" },
        );
        return NextResponse.json({ ok: true, result });
      } catch (error) {
        if (error instanceof WiseActivitySyncAlreadyRunningError) {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        const message = error instanceof Error ? error.message : "Wise activity sync failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}
```

**Substitutions for `line-backlog-recovery/route.ts`:**
- `maxDuration = 300` (1,962 profile fetches + matching; lower than 800s sync routes)
- `jobKey: "line_backlog_recovery"` (must match the `CronJobKey` added to `cron-registry.ts`)
- Replace `syncWiseActivityEvents` with `runLineBacklogRecovery({ db: getDb(), dryRun: false })`
- Replace `WiseActivitySyncAlreadyRunningError` with a `LineBacklogRecoveryAlreadyRunningError` (or check `error.message.includes("already running")` if no typed error class is created)
- Import `runLineBacklogRecovery` from `@/lib/line/backlog-recovery`  <!-- was student-links; Plan 03 moved runLineBacklogRecovery to backlog-recovery.ts -->

**`rejectInvalidCronSecret` signature** (cron-auth.ts:19):
```typescript
export function rejectInvalidCronSecret(request: NextRequest): NextResponse | null
// Returns null if CRON_SECRET matches; error NextResponse if invalid or misconfigured
```

**`withCronInvocationAudit` signature** (cron-audit.ts:144):
```typescript
export async function withCronInvocationAudit(
  input: AuditInput,
  handler: () => Promise<Response>,
): Promise<Response>
// AuditInput: { jobKey: CronJobKey; triggerSource: CronTriggerSource; actorEmail?: string | null; requestMethod?: string }
```

**`cron-registry.ts` addition** — add `"line_backlog_recovery"` to the `CronJobKey` union (line 14) and a `CRON_JOBS` entry mirroring the `room_utilization` manual-only entry (lines 191-205):
```typescript
{
  key: "room_utilization",
  label: "Room Utilization",
  feature: "Room Capacity",
  path: "/api/internal/sync-room-utilization",
  schedule: null,
  cadenceLabel: "Manual only",
  cadenceMinutes: null,
  lateAfterMinutes: 0,
  maxDurationSeconds: 800,
  manualOnly: true,
  dangerous: false,
  confirmationLabel: null,
  routeMethod: "POST",
},
```
The new entry: `key: "line_backlog_recovery"`, `path: "/api/internal/line-backlog-recovery"`, `manualOnly: true`, `dangerous: false`, `maxDurationSeconds: 300`, `routeMethod: "GET"`. No `vercel.json` entry needed — manual-only for Phase 12.

---

### `src/lib/line/student-links.ts` (MODIFIED)

**Self-analog: four targeted changes.**

**Change 1 — extend `studentLinkEvidence` source union (lines 420-426):**
```typescript
// CURRENT (lines 420-426):
function studentLinkEvidence(input: {
  source:
    | "line_display_name"
    | "admin_helper_text"
    | "admin_search"
    | "message_content"
    | "line_followers";
```
Add `| "follower_profile"` as a new member AFTER `"line_followers"`. These are distinct signals — `"line_followers"` = dotted enrollment code from Phase 11; `"follower_profile"` = distinctive-token name match from Phase 12.

**Change 2 — export `nicknameCodes` (line 310):**
```typescript
// CURRENT:
function nicknameCodes(value: string): string[] {
// CHANGE TO:
export function nicknameCodes(value: string): string[] {
```
Single-keyword change. `backlog-matcher.ts` imports it directly.

**Change 3 — add `listVerifiedResolverTargets(db)` (new function after line 831):**

Pattern: mirrors the `db.select(...).from(...).where(...)` query style already used throughout `student-links.ts`. The query from RESEARCH.md §4:
```typescript
export async function listVerifiedResolverTargets(db: Database): Promise<VerifiedResolverTarget[]> {
  return db
    .select({
      studentName: schema.lineOaResolverRows.studentName,
      parentName: schema.lineOaResolverRows.parentName,
      searchCode: schema.lineOaResolverRows.searchCode,
      lineChatUrl: schema.lineOaResolverRows.lineChatUrl,
      wiseStudentId: schema.lineOaResolverRows.wiseStudentId,
      studentKey: schema.lineOaResolverRows.studentKey,
    })
    .from(schema.lineOaResolverRows)
    .where(isNotNull(schema.lineOaResolverRows.committedLinkId));
}
// Export the inferred type alias for callers:
export type VerifiedResolverTarget = Awaited<ReturnType<typeof listVerifiedResolverTargets>>[number];
```

**Change 4 — add `runLineBacklogRecovery({ db, dryRun })` (new function):**

Reuse the INLINE insert pattern from `ensureLineContactStudentLinkSuggestions` (lines 467-522), NOT by calling that function. The relevant insert block to copy (lines 467-492):
```typescript
await db
  .insert(schema.lineContactStudentLinks)
  .values({
    contactId,
    wiseStudentId: match.student.wiseStudentId,
    studentKey: match.student.studentKey,
    studentName: match.student.studentName,
    parentName: match.student.parentName,
    status: "suggested",
    confidence: 0.95,
    evidence: studentLinkEvidence({
      source: evidenceSource,
      parsedCodes,
      matchedCode: match.parsed.code,
      matchedField: match.matchType,
      label,
      student: match.student,
    }),
  })
  .onConflictDoNothing({
    target: [
      schema.lineContactStudentLinks.contactId,
      schema.lineContactStudentLinks.studentKey,
    ],
  });
```
Adapt for backlog recovery: `source: "follower_profile"`, `status: "suggested"` (hardcoded, NEVER `"verified"` — mirror the comment at line 508: `// ALWAYS suggested — NEVER verified from content (IDENT-02)`), `confidence: 0.95` for high-confidence / `0.60` for ambiguous, `evidence.originalUrl: target.lineChatUrl`.

The `runLineFollowersReanchor` loop (lines 753-801) shows the outer loop + per-contact error handling pattern to mirror for `runLineBacklogRecovery`.

---

### `src/lib/line/client.ts` (MODIFIED — add `fetchLineProfilesBatched`)

**Self-analog: `fetchLineFollowerIds` at lines 68-88 for bounded pagination; `fetchLineProfile` at lines 41-61 for per-ID fetch + 404 handling.**

**`fetchLineProfile` 404 pattern** (lines 41-61):
```typescript
export async function fetchLineProfile(userId: string): Promise<LineProfile | null> {
  const response = await fetch(`${LINE_API_BASE}/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${lineAccessToken()}`,
    },
  });

  if (response.status === 404) return null;
  const payload = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(typeof payload.message === "string" ? payload.message : `LINE profile returned HTTP ${response.status}`);
  }

  return {
    userId,
    displayName: typeof payload.displayName === "string" ? payload.displayName : undefined,
    // ...
  };
}
```

**New `fetchLineProfilesBatched` to add** — mirror the bounded-concurrency pattern. No existing helper for concurrency limiting in `client.ts`, so implement inline with a semaphore (same pattern the Wise client uses):
```typescript
export async function fetchLineProfilesBatched(
  userIds: string[],
  concurrencyLimit = 5,
): Promise<Map<string, LineProfile>> {
  const result = new Map<string, LineProfile>();
  // bounded-concurrency fan-out: process userIds in chunks of concurrencyLimit
  for (let i = 0; i < userIds.length; i += concurrencyLimit) {
    const chunk = userIds.slice(i, i + concurrencyLimit);
    const profiles = await Promise.all(chunk.map((id) => fetchLineProfile(id)));
    for (let j = 0; j < chunk.length; j += 1) {
      const profile = profiles[j];
      if (profile !== null) result.set(chunk[j], profile);
      // 404 → fetchLineProfile returns null → skip (no entry in Map)
    }
  }
  return result;
}
```
Placement: add after `fetchLineFollowerIds` (after line 88), before `pushLineTextMessage`.

---

### `src/lib/line/name-matcher.ts` (MODIFIED — drop fuzzy tier)

**Self-analog: the file is 270 lines, read in full.**

**Lines to DROP (227-250 — Step 3 Levenshtein):**
```typescript
    // ── Step 3: Levenshtein fuzzy match ───────────────────────────────────────
    if (inputStudentTokens.length > 0 && studentNameTokens.length > 0) {
      const hasFuzzy = inputStudentTokens.every((it) =>
        studentNameTokens.some((st) => levenshtein(it, st) <= 2),
      );
      if (hasFuzzy) {
        consider(student, 50, "student_name_fuzzy", true);
      }
    }

    if (inputParentTokens.length > 0 && parentNameTokens.length > 0) {
      const hasFuzzy = inputParentTokens.every((it) =>
        parentNameTokens.some((st) => levenshtein(it, st) <= 2),
      );
      if (hasFuzzy) {
        consider(student, 35, "parent_name_fuzzy", false);
      }
    }
```
Delete this block entirely. Step 4 (sibling dominance, lines 253-265) moves up.

**Types to remove from `NameMatchCandidate.matchBasis` (lines 28-29):**
```typescript
    | "student_name_fuzzy"    // ← REMOVE
    | "parent_name_fuzzy";   // ← REMOVE
```

**Score table comment to trim (lines 96-104):** Remove the two Levenshtein rows after dropping Step 3.

**JSDoc update (lines 5-9):** Change the three-tier list to a two-tier list (Exact + Token). Remove the "Levenshtein ≤ 2 fuzzy match (low confidence)" line.

**`levenshtein` export (line 76) — KEEP AS-IS:**
```typescript
export function levenshtein(a: string, b: string): number { ... }
```
`name-matcher.test.ts:4` imports `levenshtein` directly; removing it would break the test. The function stays exported and tested; it is just no longer called inside `matchNamesToDirectory`.

**`name-matcher.test.ts` / `name-matcher.eval.test.ts` — test updates needed:**
- Remove any `it` blocks that assert `matchBasis: "student_name_fuzzy"` or `"parent_name_fuzzy"` — these no longer fire
- The two eval fixtures that previously relied on fuzzy ("Pimchaok Wannakorn" → `wannakorn` token; "Nicho Suwanprasert" → `suwanprasert` token) already pass via token tier — no fixture change needed, but verify the `matchBasis` assertion if present

---

### `src/app/api/line/contacts/followers-reanchor/route.ts` (MODIFIED — C1 wiring)

**Self-analog: current 26-line route (read in full).**

**Current implementation** (lines 1-25):
```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runLineFollowersReanchor } from "@/lib/line/student-links";

export const maxDuration = 60;

export async function POST() {
  // Step 1: auth() → 401
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Steps 2 & 3: No body needed for this route — skip json + Zod parse
  // Step 4: business logic in try/catch → 500
  try {
    const result = await runLineFollowersReanchor({ db: getDb() });
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run followers re-anchor";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Changes for C1:**
1. Add `NextRequest` import: `import { NextRequest, NextResponse } from "next/server";`
2. Add `runLineBacklogRecovery` to the import from `student-links`
3. Change `export async function POST()` → `export async function POST(request: NextRequest)`
4. Read `?dryRun=true` from URL: `const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";`
5. After `runLineFollowersReanchor`, call `runLineBacklogRecovery({ db: getDb(), dryRun })`
6. Consider `maxDuration`: if backlog recovery uses stored `displayName` (no fresh fetch), 60s is sufficient; if fresh fetch is chosen, increase to 300
7. Return combined result: `NextResponse.json({ reanchor: result, backlog: backlogResult })`

The 4-step auth pattern (auth → 401, json → 400, Zod → 400, business logic → 500) from CLAUDE.md conventions: this route skips steps 2-3 (no body), so the pattern is: auth → try/catch → 500, exactly as the current route shows.

---

## Shared Patterns

### Auth pattern — admin session routes (C1)
**Source:** `src/app/api/line/contacts/followers-reanchor/route.ts` (current lines 8-13)
**Apply to:** The C1 route modification (followers-reanchor)
```typescript
const session = await auth();
if (!session) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

### Auth pattern — cron routes (C2)
**Source:** `src/app/api/internal/sync-wise-activity/route.ts` lines 12-14
**Apply to:** `src/app/api/internal/line-backlog-recovery/route.ts`
```typescript
const rejection = rejectInvalidCronSecret(request);
if (rejection) return rejection;
```

### Error handling — route catch block
**Source:** `src/app/api/internal/sync-wise-activity/route.ts` lines 28-33
**Apply to:** All new/modified route files
```typescript
} catch (error) {
  if (error instanceof WiseActivitySyncAlreadyRunningError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  const message = error instanceof Error ? error.message : "Wise activity sync failed";
  return NextResponse.json({ error: message }, { status: 500 });
}
```

### DB insert — `onConflictDoNothing` pattern
**Source:** `src/lib/line/student-links.ts` lines 486-492 and 516-521
**Apply to:** `runLineBacklogRecovery` insert in `student-links.ts`
```typescript
.onConflictDoNothing({
  target: [
    schema.lineContactStudentLinks.contactId,
    schema.lineContactStudentLinks.studentKey,
  ],
});
```

### Fail-closed insert comment
**Source:** `src/lib/line/student-links.ts` line 508
**Apply to:** Every insert of `"follower_profile"` source rows in `runLineBacklogRecovery`
```typescript
status: "suggested",          // ALWAYS suggested — NEVER verified from content (IDENT-02)
```

### Pure-module invariant comment
**Source:** `src/lib/line/name-matcher.ts` lines 10-12
**Apply to:** `backlog-matcher.ts` JSDoc header
```typescript
 * Fail-closed invariant: this module performs NO DB writes and never auto-confirms a link.
 * It returns scored suggestions only; callers must route them through admin review.
 *
 * No DB imports — all functions are pure transformations.
```

---

## No Analog Found

None. All files have strong analogs in the codebase.

---

## Metadata

**Analog search scope:** `src/lib/line/`, `src/app/api/line/`, `src/app/api/internal/`, `src/lib/db/schema.ts`, `src/lib/data-health/cron-registry.ts`
**Files scanned:** 10 (name-matcher.ts, client.ts, student-links.ts, followers-reanchor/route.ts, sync-wise-activity/route.ts, name-matcher.test.ts, name-matcher.eval.test.ts, schema.ts, cron-registry.ts, cron-auth.ts)
**RESEARCH.md anchors consumed:** All verified anchors from §1-8 of 12-RESEARCH.md
**Pattern extraction date:** 2026-06-07

---

## PATTERN MAPPING COMPLETE

**Phase:** 12 — LINE Backlog Identity Recovery (IDENT-07)
**Files classified:** 8 (4 new, 4 modified)
**Analogs found:** 8 / 8

### Coverage
- Files with exact analog: 5 (`backlog-matcher.ts`, `backlog-matcher.test.ts`, `lineBacklogRecoverySyncRuns` schema, `line-backlog-recovery/route.ts`, `cron-registry.ts` addition)
- Files with self-analog (modification of existing file): 3 (`student-links.ts`, `client.ts`, `name-matcher.ts` + its tests, `followers-reanchor/route.ts`)
- Files with no analog: 0

### Key Patterns Identified
- All pure-logic modules (`backlog-matcher.ts`) mirror `name-matcher.ts` exactly: em-dash section headers, single `import type` from `student-links`, no DB imports, exported typed interfaces, JSDoc invariant comment block, `describe`/`it` test structure
- All internal cron routes mirror `sync-wise-activity/route.ts` exactly: `rejectInvalidCronSecret` → `withCronInvocationAudit` → typed business-error 409 → generic 500
- All suggestion inserts use `.insert(...).values({...}).onConflictDoNothing({ target: [contactId, studentKey] })` with `status: "suggested"` hardcoded (IDENT-02 comment required)
- New cron job entries in `cron-registry.ts` follow the `room_utilization` `manualOnly: true` pattern; no `vercel.json` entry until auto-scheduled

### File Created
`.planning/phases/12-line-backlog-identity-recovery-ident-07-map-existing-line-co/12-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. Planner can now reference analog patterns in PLAN.md files following the design doc build order: backlog-matcher → fetchLineProfilesBatched → student-links additions + dry-run gate → C1 wiring → name-matcher fuzzy drop → C2 cron route + schema.
