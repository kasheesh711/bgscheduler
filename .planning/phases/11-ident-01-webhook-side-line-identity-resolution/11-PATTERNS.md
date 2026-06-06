# Phase 11: IDENT-01 Webhook-Side LINE Identity Resolution — Pattern Map

**Mapped:** 2026-06-06
**Files analyzed:** 11 (4 new, 7 modified)
**Analogs found:** 11 / 11

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/line/name-matcher.ts` | utility | transform | `src/lib/line/student-links.ts` | role-match (pure normalizer/matcher logic) |
| `src/lib/line/__tests__/name-matcher.test.ts` | test | — | `src/lib/line/__tests__/student-links.test.ts` | exact |
| `src/lib/line/__tests__/name-matcher.eval.test.ts` | test | — | `src/lib/line/__tests__/client.test.ts` | role-match (fixture-driven unit test) |
| `src/app/api/line/contacts/followers-reanchor/route.ts` | controller | request-response | `src/app/api/line/contacts/link-validation/[linkId]/route.ts` | exact (4-step mutating-route pattern) |
| `src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts` | test | — | `src/app/api/line/contacts/refresh-profiles/__tests__/route.test.ts` | exact |
| `src/lib/line/student-links.ts` (extend) | service | CRUD | self (existing functions are the analog) | exact |
| `src/lib/line/client.ts` (extend) | utility | request-response | `src/lib/line/client.ts:fetchLineProfile` (lines 41–61) | exact |
| `src/lib/line/link-validation.ts` (extend) | service | CRUD | `src/lib/line/link-validation.ts:patchLineLinkValidationTaskStatus` (lines 700–738) | exact |
| `src/lib/line/review-service.ts` (extend) | service | event-driven | `src/lib/line/review-service.ts:processLineMessageForScheduler` (lines 126–176) | exact |
| `src/lib/db/schema.ts` (extend) | model | — | `src/lib/db/schema.ts` line 200 (`boolean("active").notNull().default(false)`) | exact |
| `src/components/line-review/mapping-validation-workspace.tsx` (extend) | component | request-response | `src/components/class-assignments/class-assignments-workspace.tsx` (publish + poll, lines 418–477) | role-match (async job trigger) |
| `src/components/line-review/utils.ts` (extend) | utility | transform | self (`studentLinkVisibilityForReview` lines 115–135) | exact |

---

## Pattern Assignments

### `src/lib/line/name-matcher.ts` (utility, transform)

**Analog:** `src/lib/line/student-links.ts`

**Imports pattern** (student-links.ts lines 1–20 style):
```typescript
import { and, eq } from "drizzle-orm";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";
// No DB imports — this module is pure functions only (no DB access)
// Exports are all named; no default export
```

**Core normalize pattern** — reuse and extend `normalizeLineStudentCode` (student-links.ts lines 83–89):
```typescript
// Existing (code-matching — strips whitespace entirely):
export function normalizeLineStudentCode(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9.ก-๙]/g, "");
}

// NEW version for name-matching — keeps spaces as token delimiters:
// NFKC → lowercase → trim → collapse spaces → strip non-[a-z0-9ก-๙ ]
// (note: keeps the space character, unlike normalizeLineStudentCode)
export function normalizeForNameMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9ก-๙ ]/g, "");
}
```

**Levenshtein to re-implement/re-export** (from data.ts lines 1090–1107 — private there, must be named export here for testability):
```typescript
// data.ts:1090-1107 — copy and export from name-matcher.ts
export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}
```

**Core match result type** — mirror the `resolveLineStudentCodeMatches` return shape (student-links.ts lines 385–416):
```typescript
// Existing shape (code matcher):
export function resolveLineStudentCodeMatches(
  label: string | null,
  students: LineStudentDirectoryRow[],
): {
  matches: Array<{ student: LineStudentDirectoryRow; parsed: ParsedLineStudentCode; matchType: LineStudentMatchType }>;
  evidenceSource: "line_display_name" | "admin_helper_text";
  parsedCodes: ParsedLineStudentCode[];
}

// New shape (name matcher) — analogous structure:
export interface NameMatchCandidate {
  student: LineStudentDirectoryRow;
  score: number;       // 0–100
  matchBasis: "student_name_exact" | "parent_name_exact" | "student_name_token"
            | "parent_name_token" | "student_name_fuzzy" | "parent_name_fuzzy";
}

export function matchNamesToDirectory(
  names: { studentName?: string | null; parentName?: string | null },
  students: LineStudentDirectoryRow[],
): NameMatchCandidate[]
```

**Constants pattern** — calibrated thresholds as module-scope UPPER_SNAKE_CASE constants:
```typescript
// Copy naming convention from search/compare engine constants
export const SUGGEST_SINGLE_MIN_SCORE = 70;
export const SUGGEST_SHORTLIST_MIN_SCORE = 50;
```

**Error handling:** pure functions — no try/catch needed; callers handle errors. Return `[]` on empty/null input (same as `parseLineStudentCodes` returning `[]` on empty label).

---

### `src/lib/line/__tests__/name-matcher.test.ts` (test)

**Analog:** `src/lib/line/__tests__/student-links.test.ts`

**Imports and fixture helper pattern** (student-links.test.ts lines 1–21):
```typescript
import { describe, expect, it } from "vitest";
import {
  matchNamesToDirectory,
  normalizeForNameMatch,
  levenshtein,
  SUGGEST_SINGLE_MIN_SCORE,
  SUGGEST_SHORTLIST_MIN_SCORE,
} from "@/lib/line/name-matcher";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";

// Factory function — matches the `student(overrides)` pattern in student-links.test.ts:
function student(overrides: Partial<LineStudentDirectoryRow>): LineStudentDirectoryRow {
  return {
    wiseStudentId: "wise-student",
    studentKey: "student::parent",
    studentName: "Student",
    parentName: "Parent",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
    ...overrides,
  };
}
```

**Test structure pattern** (student-links.test.ts lines 23–80):
```typescript
// Flat describe blocks per behavior, not per function:
describe("name matcher — exact match", () => {
  it("matches romanized student name exactly", () => { ... });
  it("matches Thai student name exactly", () => { ... });
  it("returns score >= SUGGEST_SINGLE_MIN_SCORE for exact match", () => { ... });
});

describe("name matcher — token overlap", () => { ... });
describe("name matcher — levenshtein fallback", () => { ... });
describe("name matcher — fail-closed", () => {
  it("returns [] when score < SUGGEST_SHORTLIST_MIN_SCORE", () => { ... });
  it("never produces a verified link", () => { ... });
});
```

No mocks needed — pure functions, no DB.

---

### `src/lib/line/__tests__/name-matcher.eval.test.ts` (test, eval fixture)

**Analog:** `src/lib/line/__tests__/client.test.ts` (fixture-driven pattern) + RESEARCH.md eval spec

**Test structure** (client.test.ts lines 1–52 as structural analog):
```typescript
import { describe, expect, it } from "vitest";
import { matchNamesToDirectory } from "@/lib/line/name-matcher";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";

// Fixture array — populated with real labeled messages (ground truth from prod DB query)
const EVAL_FIXTURES: Array<{
  label: string;
  studentName: string | null;
  parentName: string | null;
  expectedStudentKey: string;
}> = [
  // ... 50 entries from real messages
];

// Mock student directory built from fixture expected keys
// Precision/recall assertions at describe level
describe("name-matcher eval set", () => {
  it("achieves precision >= 0.90 on labeled eval set", () => {
    // Run matcher over all fixtures, count correct suggestions
    // Record the threshold: no fixture has a wrong student in top suggestion
  });

  it("achieves recall >= 0.60 on labeled eval set", () => {
    // Count contacts where expectedStudentKey appears in any suggestion
  });
});
```

Note: no `vi.mock()` calls — pure function, no DB access.

---

### `src/app/api/line/contacts/followers-reanchor/route.ts` (controller, request-response)

**Analog:** `src/app/api/line/contacts/link-validation/[linkId]/route.ts` (exact 4-step mutating-route pattern)

**Imports pattern** (link-validation/[linkId]/route.ts lines 1–6):
```typescript
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runLineFollowersReanchor } from "@/lib/line/student-links";
// No NextRequest needed if body is empty; use POST() with no args like refresh-profiles/route.ts
```

**Complete 4-step mutating-route pattern** (link-validation/[linkId]/route.ts lines 21–54):

```typescript
// Step 1: auth() → 401
export async function POST() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Step 2: request.json() in try/catch → 400
  // (No body required for this route — skip step 2; body is empty)

  // Step 3: schema.safeParse() → 400 with .error.flatten()
  // (No body params — skip; validate LINE API response internally in the service)

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

**maxDuration pattern** — set at file scope, not in vercel.json (CLAUDE.md convention):
```typescript
// Copy from publish route (src/app/api/class-assignments/runs/[runId]/publish/route.ts line 10):
export const maxDuration = 60;
```

**after() for long background work** — copy the `schedulePublishJob` pattern from publish/route.ts lines 12–26 IF the re-anchor is expected to exceed the response window. For ~300 followers processed sequentially it should complete synchronously; use `after()` only if Vercel timeout is a concern at actual follower count:
```typescript
// publish/route.ts lines 12-26 — the established pattern for fire-and-after:
import { after } from "next/server";

function scheduleReanchorJob(db: Database) {
  const task = async () => {
    try {
      await runLineFollowersReanchor({ db });
    } catch (error) {
      console.error("Followers re-anchor job failed", error);
    }
  };
  try {
    after(task);
  } catch {
    void task();
  }
}
// POST returns 202 immediately with a progress stub; job runs after response
```

---

### `src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts` (test)

**Analog:** `src/app/api/line/contacts/refresh-profiles/__tests__/route.test.ts` (lines 1–55)

This is the closest structural match because `refresh-profiles` is also a no-body POST admin route that delegates to a single service function.

**Full pattern to copy:**
```typescript
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/student-links", () => ({
  runLineFollowersReanchor: vi.fn(async () => ({
    followerCount: 0,
    upsertedContacts: 0,
    suggestionsCreated: 0,
    errors: [],
  })),
}));

import { auth } from "@/lib/auth";
import { runLineFollowersReanchor } from "@/lib/line/student-links";
import { POST } from "@/app/api/line/contacts/followers-reanchor/route";

const authMock = auth as unknown as Mock;

describe("POST /api/line/contacts/followers-reanchor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(runLineFollowersReanchor).mockResolvedValue({
      followerCount: 5,
      upsertedContacts: 3,
      suggestionsCreated: 2,
      errors: [],
    });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);
    const response = await POST();
    expect(response.status).toBe(401);
    expect(runLineFollowersReanchor).not.toHaveBeenCalled();
  });

  it("runs the followers re-anchor and returns a result", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(runLineFollowersReanchor).toHaveBeenCalledWith({ db: { db: true } });
    // ...assert result shape
  });

  it("is idempotent — re-run creates no duplicate contacts", async () => {
    // Service mock demonstrates idempotency; test re-run returns same counts
  });
});
```

---

### `src/lib/line/student-links.ts` — extend `ensureLineContactStudentLinkSuggestions` and `studentLinkEvidence`

**Analog:** self — existing `ensureLineContactStudentLinkSuggestions` (lines 450–490) is the exact pattern to extend.

**Extension — add `names` param** (lines 450–490):
```typescript
// Current signature:
export async function ensureLineContactStudentLinkSuggestions(
  db: Database,
  contactId: string,
  labelOverride?: string | null,
): Promise<LineContactStudentLinkDto[]>

// Extended signature (add optional names param):
export async function ensureLineContactStudentLinkSuggestions(
  db: Database,
  contactId: string,
  labelOverride?: string | null,
  names?: { studentName?: string | null; parentName?: string | null },
): Promise<LineContactStudentLinkDto[]>
```

**Upsert pattern to replicate for name-based matches** (lines 461–487):
```typescript
// Copy this exact pattern for name-based candidates:
await db
  .insert(schema.lineContactStudentLinks)
  .values({
    contactId,
    wiseStudentId: candidate.student.wiseStudentId,
    studentKey: candidate.student.studentKey,
    studentName: candidate.student.studentName,
    parentName: candidate.student.parentName,
    status: "suggested",          // ALWAYS suggested — never verified from content
    confidence: candidate.score / 100,
    evidence: studentLinkEvidence({
      source: "message_content",  // NEW source kind
      student: candidate.student,
    }),
    sourceKind: "message_content",  // NEW sourceKind value
  })
  .onConflictDoNothing({
    target: [
      schema.lineContactStudentLinks.contactId,
      schema.lineContactStudentLinks.studentKey,
    ],
  });
```

**`studentLinkEvidence` source union extension** (lines 418–436):
```typescript
// Current source union:
source: "line_display_name" | "admin_helper_text" | "admin_search";
// Extended:
source: "line_display_name" | "admin_helper_text" | "admin_search"
      | "message_content"   // NEW: from AI-extracted studentName/parentName
      | "line_followers";   // NEW: from followers/ids re-anchor
```

**`listVerifiedLineStudentKeys` — add isPhantom filter** (lines 677–689):
```typescript
// Current:
.where(and(
  eq(schema.lineContactStudentLinks.contactId, contactId),
  eq(schema.lineContactStudentLinks.status, "verified"),
));

// Extended (add after isPhantom column is added to schema):
.where(and(
  eq(schema.lineContactStudentLinks.contactId, contactId),
  eq(schema.lineContactStudentLinks.status, "verified"),
  eq(schema.lineContactStudentLinks.isPhantom, false),   // NEW
));
```

---

### `src/lib/line/client.ts` — add `fetchLineFollowerIds`

**Analog:** `fetchLineProfile` (client.ts lines 41–61) — exact pattern to follow.

**Full analog to copy** (lines 41–61):
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
    pictureUrl: typeof payload.pictureUrl === "string" ? payload.pictureUrl : undefined,
    statusMessage: typeof payload.statusMessage === "string" ? payload.statusMessage : undefined,
    raw: payload,
  };
}
```

**New function to add** — mirrors the `asRecord` + error shape of `fetchLineProfile`:
```typescript
export interface LineFollowersPage {
  userIds: string[];
  next: string | undefined;
}

export async function fetchLineFollowerIds(startCursor?: string): Promise<LineFollowersPage> {
  const url = new URL(`${LINE_API_BASE}/v2/bot/followers/ids`);
  url.searchParams.set("limit", "300");
  if (startCursor) url.searchParams.set("start", startCursor);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${lineAccessToken()}` },
  });

  // No 404 case (unlike fetchLineProfile) — followers/ids does not 404
  const payload = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(typeof payload.message === "string" ? payload.message : `LINE followers/ids returned HTTP ${response.status}`);
  }

  const userIds = Array.isArray(payload.userIds)
    ? payload.userIds.filter((id): id is string => typeof id === "string")
    : [];
  const next = typeof payload.next === "string" ? payload.next : undefined;
  return { userIds, next };
}
```

Note: `asRecord` and `lineAccessToken` are module-private helpers already in client.ts — reuse them; do not re-declare.

---

### `src/lib/line/link-validation.ts` — widen scope predicate and add phantom filter

**Analog:** `lineOaResolverSourceCondition` + `patchLineLinkValidationTaskStatus` (lines 243–245, 700–738).

**Scope predicate to replace** (line 243–245):
```typescript
// Current (OA-resolver only):
function lineOaResolverSourceCondition() {
  return eq(schema.lineContactStudentLinks.sourceKind, "line_oa_resolver");
}

// New companion predicate for real contacts (D-04):
function realContactCondition() {
  return eq(schema.lineContactStudentLinks.isPhantom, false);
}
// OR: add a new scope value "messaging" to LineLinkValidationScope
// and add a "phantom" scope for the D-03 archive filter
```

**`patchLineLinkValidationTaskStatus` guard fix** (lines 720–724):
```typescript
// Current WHERE (blocks non-resolver links from being verified):
.where(and(
  eq(schema.lineContactStudentLinks.id, input.linkId),
  lineOaResolverSourceCondition(),   // ← remove this for widened flow
))

// Fixed WHERE (widened to all non-phantom links):
.where(and(
  eq(schema.lineContactStudentLinks.id, input.linkId),
  eq(schema.lineContactStudentLinks.isPhantom, false),  // excludes phantoms but allows message_content
))
```

**All count aggregates in `getLineLinkValidationSummary`** — add `isPhantom = false` condition to every `count()` subquery (lines 472–608). Pattern: same as the existing `lineOaResolverSourceCondition()` filtering — find every `.where(lineOaResolverSourceCondition())` and add the phantom filter.

---

### `src/lib/line/review-service.ts` — wire name-based matcher in `processLineMessageForScheduler`

**Analog:** existing call site at lines 134–139 (current `ensureLineContactStudentLinkSuggestions` call):
```typescript
// Current (lines 134-139):
await ensureLineContactStudentLinkSuggestions(
  db,
  lineMessage.contactId,
  profile?.displayName ?? lineMessage.contactDisplayName,
).catch(() => undefined);

// Extended — pass extracted names from conversation:
const conversation = lineMessage.aiSchedulerConversationId
  ? await getLineSchedulerConversationExtractedState(db, lineMessage.aiSchedulerConversationId)
  : null;
const names = conversation?.studentName || conversation?.parentName
  ? { studentName: conversation.studentName, parentName: conversation.parentName }
  : undefined;

await ensureLineContactStudentLinkSuggestions(
  db,
  lineMessage.contactId,
  profile?.displayName ?? lineMessage.contactDisplayName,
  names,                         // NEW 4th arg
).catch(() => undefined);
```

Extension is purely additive — the existing display-name path runs first, name-based matching runs second inside the extended function.

---

### `src/lib/db/schema.ts` — add `isPhantom` column

**Analog:** `active: boolean("active").notNull().default(false)` (schema.ts line 200) — exact pattern.

**Column to add** to `lineContactStudentLinks` table (after line 1754, before the closing `}`):
```typescript
// Pattern: boolean("snake_case_name").notNull().default(false)
// Analog: active: boolean("active").notNull().default(false),  (line 200)
isPhantom: boolean("is_phantom").notNull().default(false),
```

**Index to add** in the table's constraint array (after line 1771):
```typescript
// Pattern: index("table_name_column_suffix_idx").on(table.col1, table.col2)
// Analog: index("line_contact_student_links_contact_status_idx").on(table.contactId, table.status)
index("line_contact_student_links_phantom_idx").on(table.isPhantom, table.status),
```

**Data migration** (one-time UPDATE, runs as part of the phase — NOT in the Drizzle migration SQL):
```sql
-- Sets isPhantom = true for all existing OA-resolver links:
UPDATE line_contact_student_links
SET is_phantom = true
WHERE source_kind = 'line_oa_resolver';
```
Run via `DATABASE_URL=... psql $DATABASE_URL -c "..."` or a one-off seed-style script after `db:migrate`.

---

### `src/components/line-review/mapping-validation-workspace.tsx` — re-anchor button + archive filter

**Analog:** `publishToWise` + `pollPublishProgress` pattern (class-assignments-workspace.tsx lines 418–477)

The re-anchor button is simpler than publish+poll because the re-anchor job is synchronous at Vercel's scale (~300 followers, ~60s max). A fire-and-response pattern (no polling loop) is sufficient unless the route uses `after()`. Use the simpler `refresh-profiles` pattern as the button handler:

**Button state pattern** (mapping-validation-workspace.tsx lines 56–93 — the `busy` state pattern already in use):
```typescript
// Existing busy state in this component (lines 62-63):
const [busy, setBusy] = useState<"runs" | "summary" | null>(null);

// Extend to include reanchor:
const [busy, setBusy] = useState<"runs" | "summary" | "reanchor" | null>(null);

// Handler (mirrors loadRuns pattern, lines 75-93):
const runReanchor = useCallback(async () => {
  setBusy("reanchor");
  setMessage(null);
  try {
    const payload = await jsonFetch<{ result: { followerCount: number; upsertedContacts: number; suggestionsCreated: number } }>(
      "/api/line/contacts/followers-reanchor",
      { method: "POST" },
    );
    setMessage(`Re-anchor complete: ${payload.result.upsertedContacts} contacts, ${payload.result.suggestionsCreated} suggestions.`);
    void Promise.all([loadRuns(), loadSummary()]);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Re-anchor failed");
  } finally {
    setBusy(null);
  }
}, [loadRuns, loadSummary]);
```

**Button JSX** — copy the Button component usage at line 205 (the existing Refresh button):
```tsx
// Existing Refresh button (lines 205-208):
<Button type="button" variant="outline" size="sm" onClick={refreshAll} disabled={Boolean(busy)}>
  {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
  Refresh
</Button>

// New Re-anchor button (same pattern):
<Button type="button" variant="outline" size="sm" onClick={runReanchor} disabled={Boolean(busy)}>
  {busy === "reanchor" ? <Loader2 className="animate-spin" /> : <Users />}
  Re-anchor followers
</Button>
```

**Archive filter** (D-03) — extend the existing `scope` select (lines 178–193):
The worklist scope is a `<select>` with string options tied to `LineLinkValidationScope`. Add `"phantom"` as a new option value corresponding to the new D-03 archive scope. The select already has an `All resolver runs` option — the phantom option goes at the bottom:
```tsx
// Existing scope select pattern in link-validation-panel.tsx (not in this file)
// In mapping-validation-workspace.tsx, the scope is passed to LinkValidationPanel via defaultScope prop.
// Archive filter is implemented as a new scope tab/option in the panel, not directly in workspace.
// The workspace exposes it via the defaultScope flow — no direct select change needed here.
```

---

### `src/components/line-review/utils.ts` — `studentLinkVisibilityForReview` badge live-read

**Analog:** self (lines 115–135) — minimal change after IDENT-06 inline recompute updates the review row.

**Current stale path** (lines 124–126):
```typescript
// Current (stale for non-selected branch):
const verifiedCount = isSelected
  ? verifiedLinks(activeLinks).length
  : Math.max(review.matchedStudentKeys.length, review.verifiedStudentKeys.length);
// ↑ Non-selected branch reads snapshotted values from review creation time
```

**Fix:** The inline-on-verify recompute (IDENT-06) updates `review.matchedStudentKeys` + `review.verifiedStudentKeys` in the DB. The badge automatically reflects fresh values on the next review list fetch — no code change needed to this function itself. The planner should note this in PLAN.md: the badge fix is a consequence of IDENT-06's DB update, not a separate code edit to `utils.ts`.

If a code change IS needed (e.g., if the review DTO served by the list endpoint doesn't include fresh `verifiedStudentKeys` from the updated row), the fix is:
```typescript
// Extend the non-selected branch to prefer verifiedStudentKeys when populated:
const verifiedCount = isSelected
  ? verifiedLinks(activeLinks).length
  : review.verifiedStudentKeys.length > 0
    ? review.verifiedStudentKeys.length
    : review.matchedStudentKeys.length;
```

---

## Shared Patterns

### Authentication (all new/modified routes)
**Source:** `src/app/api/line/contacts/link-validation/[linkId]/route.ts` lines 21–24
**Apply to:** `followers-reanchor/route.ts`
```typescript
const session = await auth();
if (!session) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

### Error Handling — 4-step mutating route (all new/modified POST routes)
**Source:** `src/app/api/line/contacts/link-validation/[linkId]/route.ts` lines 21–54
**Apply to:** `followers-reanchor/route.ts`
```typescript
// Step 1: auth() → 401
// Step 2: request.json() in try/catch → 400  (skip if no body)
// Step 3: schema.safeParse() → 400 with .error.flatten()  (skip if no body)
// Step 4: business logic in try/catch → 500:
try {
  // ... business logic
  return NextResponse.json({ ... });
} catch (error) {
  const message = error instanceof Error ? error.message : "Fallback error string";
  return NextResponse.json({ error: message }, { status: 500 });
}
```

### Idempotent upsert (re-anchor contact creation)
**Source:** `src/lib/line/student-links.ts` lines 461–487 (`onConflictDoNothing`)
**Apply to:** `runLineFollowersReanchor` in `student-links.ts`
```typescript
await db
  .insert(schema.lineContacts)
  .values({ lineUserId, displayName, pictureUrl, ... })
  .onConflictDoNothing({ target: schema.lineContacts.lineUserId });
```

### Boolean schema column with notNull default
**Source:** `src/lib/db/schema.ts` line 200
**Apply to:** `isPhantom` column in `lineContactStudentLinks`
```typescript
isPhantom: boolean("is_phantom").notNull().default(false),
```

### Named exports only (no default exports)
**Source:** CLAUDE.md conventions + every file in `src/lib/`
**Apply to:** `name-matcher.ts` — all exports are named. No `export default`.

### Pure library module structure (no DB, fully testable)
**Source:** `src/lib/line/student-links.ts` — `normalizeLineStudentCode`, `parseLineStudentCodes`, `resolveLineStudentCodeMatches` are all pure functions at the top of the file.
**Apply to:** `name-matcher.ts` — all functions pure, no DB imports, no Next.js imports.

### `jsonFetch` for client-side API calls
**Source:** `src/components/line-review/utils.ts` lines 67–75
**Apply to:** Re-anchor button handler in `mapping-validation-workspace.tsx`
```typescript
export async function jsonFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : "Request failed";
    throw new Error(message);
  }
  return payload as T;
}
```

### Async job trigger button (fire-and-response)
**Source:** `src/components/class-assignments/class-assignments-workspace.tsx` lines 418–440 (`publishToWise`)
**Apply to:** Re-anchor button handler — use the simpler no-poll variant (re-anchor completes synchronously)
```typescript
// Simpler than publish+poll because no long-running background job is needed:
async function triggerReanchor() {
  setBusy("reanchor");
  try {
    const response = await fetch("/api/line/contacts/followers-reanchor", { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setMessage(`Re-anchor complete: ${body.result.upsertedContacts} contacts upserted.`);
  } catch (err) {
    setMessage(err instanceof Error ? err.message : "Re-anchor failed");
  } finally {
    setBusy(null);
  }
}
```
If the route uses `next/server after()` and returns 202 before completion, adopt the full poll pattern from class-assignments-workspace.tsx lines 442–477.

---

## No Analog Found

All files have close analogs in the codebase. No file requires relying solely on RESEARCH.md patterns.

---

## Metadata

**Analog search scope:** `src/lib/line/`, `src/app/api/line/`, `src/components/line-review/`, `src/components/class-assignments/`, `src/lib/db/schema.ts`
**Files scanned:** 20
**Pattern extraction date:** 2026-06-06
