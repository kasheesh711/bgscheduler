# Phase 12: LINE Backlog Identity Recovery (IDENT-07) — Research

**Researched:** 2026-06-07
**Domain:** LINE identity matching — distinctive-token follower-profile matcher, codebase anchor verification
**Confidence:** HIGH (all anchors verified against live source files)

---

## Summary

Phase 11 shipped the infrastructure for webhook-side LINE identity resolution but the Phase 11 name-matcher is noisy on real data: the Levenshtein fuzzy tier floods on short Thai/English nicknames (one contact got 9 wrong suggestions). During UAT a redesign was proposed: anchor matching on the 662 human-verified OA-resolver rows (ground truth) using distinctive tokens (≥4-char lastnames/parent-names/nickname-codes), not the noisy full Wise directory.

UAT-validated result: ~229 high-confidence auto-map candidates across 1,962 followers. The design is locked and UAT-proven. This research's job is to verify every file anchor cited in the design doc against live source, report drift, and fill the planner gaps.

**The design doc is:** `~/.claude/plans/can-t-we-look-for-sunny-lampson.md`. Read it first. This RESEARCH.md is an annotation layer on top of that doc — confirming, correcting, and filling detail gaps.

**Primary recommendation:** Follow the design doc's build order exactly (backlog-matcher → fetchLineProfilesBatched → listVerifiedResolverTargets + dryRun → C1 wiring → drop fuzzy → C2 cron). Every code anchor exists at the expected line. One naming drift between design doc and live code is documented below.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Distinctive-token matching logic | Pure TS lib (`backlog-matcher.ts`) | — | No DB, pure function; mirrors name-matcher.ts architecture |
| Follower profile batch-fetch | `src/lib/line/client.ts` | — | All LINE API calls live in client.ts |
| Target set query (verified resolver rows) | `src/lib/line/student-links.ts` | — | All student-link DB reads live here |
| Suggestion insert | `src/lib/line/student-links.ts` via `ensureLineContactStudentLinkSuggestions` | — | Reuses existing insert path; keeps evidence shape consistent |
| C1 trigger point | `POST /api/line/contacts/followers-reanchor/route.ts` | — | Admin-session auth already wired; fastest path to suggestions in worklist |
| C2 cron trigger | `src/app/api/internal/line-backlog-recovery/route.ts` (NEW) | — | CRON_SECRET constant-time auth; withCronInvocationAudit |
| Worklist display + one-click confirm | `src/components/line-review/link-validation-panel.tsx` | — | Already fully wired; no UI change required for core flow |
| Fuzzy tier removal | `src/lib/line/name-matcher.ts` | `name-matcher.test.ts`/`.eval.test.ts` | Drop Step 3 Levenshtein; update test expectations |

---

## Verified Code Anchors

All files opened and confirmed. Discrepancies from design doc noted with **DRIFT** label.

### 1. `src/lib/line/link-validation.ts` — lineChatUrl assignment

**Design doc says:** ~l.300 sets `lineChatUrl = evidence.originalUrl`
**Verified:** Line 300 EXACTLY — `lineChatUrl: asString(evidence.originalUrl)` inside `buildLineLinkValidationTaskDto`.

```typescript
// src/lib/line/link-validation.ts:286-300
function buildLineLinkValidationTaskDto(
  row: LinkRow,
  contact: ContactRow,
  currentStudent: { activated: boolean; hasFutureSessions: boolean; hasLivePackage: boolean } | null,
): LineLinkValidationTaskDto {
  const evidence = asRecord(row.evidence);
  return {
    // ...
    lineChatUrl: asString(evidence.originalUrl),  // l.300 — confirmed
```

The DTO type `LineLinkValidationTaskDto` (l.15-51) includes `lineChatUrl: string | null`. The "LINE" button in the panel reads `task.lineChatUrl`. So: any `lineContactStudentLinks` row whose `evidence.originalUrl` is set will populate the button — the new matcher only needs to set `evidence.originalUrl` = the verified chat URL from the resolver target row.

### 2. `src/components/line-review/link-validation-panel.tsx` — "LINE" button

**Design doc says:** ~l.587 renders a "LINE" button that opens `task.lineChatUrl`
**Verified:** Lines 582-592 EXACTLY:

```typescript
// link-validation-panel.tsx:582-592
<Button
  type="button"
  size="sm"
  variant="outline"
  className="h-7 px-2"
  onClick={() => task.lineChatUrl && window.open(task.lineChatUrl, "_blank", "noopener,noreferrer")}
  disabled={!task.lineChatUrl}
>
  <ExternalLink />
  LINE
</Button>
```

The "Verify" button at l.593-602 calls `patchTask(task.id, "verified")`. The one-click-confirm path is end-to-end: matcher sets `evidence.originalUrl` → DTO maps it → button opens the real chat → admin clicks Verify → `status:"verified"` + IDENT-06 inline recompute fires. No UI change needed for the core Phase A flow.

### 3. `src/lib/line/oa-resolver.ts` — the pattern the new matcher mirrors

**Design doc says:** ~l.1034 sets `originalUrl: candidate.lineChatUrl`
**Verified:** Lines 1030-1050 — the `linkEvidence` object built at commit time:

```typescript
// oa-resolver.ts:1030-1050
const linkEvidence = {
  source: "line_oa_resolver",
  lineOaAccountId: candidate.lineOaAccountId,
  lineUserId: candidate.lineUserId,
  originalUrl: candidate.lineChatUrl,       // l.1034 — confirmed
  searchCode: candidate.searchCode ?? row.searchCode,
  // ...
};
```

The new matcher must emit the same `originalUrl` key in the evidence object, with `evidence.source = "follower_profile"` (see DRIFT section below). The insert then uses `upsertResolverSuggestedLink`.

### 4. `src/lib/line/student-links.ts` — core anchors

**File size:** 831 lines

**`studentLinkEvidence` source union (l.420-426):**

```typescript
// student-links.ts:420-426
function studentLinkEvidence(input: {
  source:
    | "line_display_name"
    | "admin_helper_text"
    | "admin_search"
    | "message_content"
    | "line_followers";   // ← EXISTS but named "line_followers" not "follower_profile"
```

**DRIFT:** Design doc says add `"follower_profile"` to this union. The current union already has `"line_followers"` (added in Phase 11 for the re-anchor job). The new backlog-recovery matcher should use a NEW variant — choose one of:
- Extend the union with `"follower_profile"` alongside `"line_followers"` (distinct: backlog = name-matched, re-anchor = dotted-code-matched), or
- Reuse `"line_followers"` and disambiguate via a different evidence field.

**Recommended:** Add `"follower_profile"` as a distinct variant. The two signals are different — `"line_followers"` (Phase 11) fires on dotted enrollment codes in display names; `"follower_profile"` (Phase 12) fires on distinctive-token name match against verified resolver ground truth. Keeping them distinct preserves debuggability and future filtering. The planner must include this union extension.

**`ensureLineContactStudentLinkSuggestions` (l.457-526) — full signature:**

```typescript
export async function ensureLineContactStudentLinkSuggestions(
  db: Database,
  contactId: string,
  labelOverride?: string | null,
  names?: { studentName?: string | null; parentName?: string | null },
): Promise<LineContactStudentLinkDto[]>
```

The `names` parameter is the hook the Phase 11 name-matcher uses. The new backlog-recovery path does NOT call this function — it uses a parallel DB insert directly (same `lineContactStudentLinks` table, same `onConflictDoNothing` target). The design doc's `runLineBacklogRecovery` "reuses the insert path" means: replicate the insert pattern from `ensureLineContactStudentLinkSuggestions:467-492`, not call the function directly (since the function also runs the display-name/dotted-code path, which is unnecessary for the backlog recovery).

**`nicknameCodes` (l.310-315) — reuse target for new matcher:**

```typescript
function nicknameCodes(value: string): string[] {
  const matches = [...value.matchAll(/\(([^)]+)\)/g)];
  return matches
    .map((match) => normalizeLineStudentCode(match[1] ?? ""))
    .filter(Boolean);
}
```

This regex extracts parenthesized nickname-codes from e.g. `"Ploychompu (Kaimook.Ka) Kaewkhampholkul"`. Currently `private` (unexported). The new `backlog-matcher.ts` needs this logic — either import it (requires export) or inline it. The planner should export `nicknameCodes` from `student-links.ts` as part of the changes there.

**`normalizeLineStudentCode` (l.85-91) — already exported:**

```typescript
export function normalizeLineStudentCode(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9.ก-๙]/g, "");
}
```

Exported — no change needed. Use as-is in `backlog-matcher.ts`.

**`runLineFollowersReanchor` (l.753-801) — current implementation:**

```typescript
export async function runLineFollowersReanchor({ db }: { db: Database }): Promise<LineFollowersReanchorResult>
```

Step 1: Paginate `fetchLineFollowerIds`. Step 2: For each follower, `fetchLineProfile` + `upsertLineContactFromFollower` + `ensureLineContactStudentLinkSuggestions` (names=undefined, dotted-code only). Step 3: count new links.

The C1 wiring plan: add a `dryRun?: boolean` param to `runLineFollowersReanchor` (or to a new wrapper that calls both `runLineFollowersReanchor` AND `runLineBacklogRecovery`). The route at `followers-reanchor/route.ts` currently takes no query params — extend it to read `?dryRun=true` from the URL.

**`listVerifiedResolverTargets` — does NOT yet exist:**

This is a new function to add to `student-links.ts`. Query: select from `lineOaResolverRows WHERE committedLinkId IS NOT NULL` — columns needed: `studentName`, `parentName`, `searchCode`, `lineChatUrl`, `wiseStudentId`, `studentKey`. The `lineOaResolverRows` table (schema l.1868-1893) has all these columns.

### 5. `src/lib/line/name-matcher.ts` — fuzzy tier to DROP

**File size:** 269 lines (all verified)

**Three tiers confirmed:**
- Step 1 (l.197-205): Exact NFKC → scores 90 (studentName), 75 (parentName)
- Step 2 (l.207-225): Token subset → scores 70 (studentName), 55 (parentName)
- Step 3 (l.227-250): Levenshtein ≤ 2 fuzzy → scores 50 (studentName), 35 (parentName) — THIS IS THE DROP TARGET
- Step 4 (l.253-265): Sibling dominance — KEEP

**`levenshtein` export (l.76):**

```typescript
export function levenshtein(a: string, b: string): number { ... }
```

Must remain exported (test file imports it directly: `name-matcher.test.ts:4` imports `levenshtein`).

**`matchBasis` union (l.24-29):**

```typescript
export interface NameMatchCandidate {
  matchBasis:
    | "student_name_exact"
    | "parent_name_exact"
    | "student_name_token"
    | "parent_name_token"
    | "student_name_fuzzy"    // ← these two exist today
    | "parent_name_fuzzy";    // ← these two exist today
}
```

When the fuzzy tier is dropped, `student_name_fuzzy` and `parent_name_fuzzy` become dead union members. They can be removed from the type — but the eval test currently has fixtures whose expected match happens to arrive via the token tier (not fuzzy), so the type change is safe as long as tests are updated.

**Score table comment (l.96-104):** Should be updated to remove the Levenshtein rows when the fuzzy tier is dropped.

**`normalizeForNameMatch` (l.53-61):** Also exported — the new `backlog-matcher.ts` may reuse this for display-name normalization.

### 6. `src/lib/line/client.ts` — current state and gap

**File size:** 127 lines

**`fetchLineFollowerIds` (l.68-88) — confirmed:**

```typescript
export async function fetchLineFollowerIds(startCursor?: string): Promise<LineFollowersPage>
// LineFollowersPage: { userIds: string[]; next: string | undefined }
// page size hardcoded to 300; paginates via `start` cursor; 404 not handled (unlike fetchLineProfile)
```

**`fetchLineProfile` (l.41-61) — confirmed:**

```typescript
export async function fetchLineProfile(userId: string): Promise<LineProfile | null>
// Returns null on 404; throws on other non-2xx errors
// LineProfile: { userId, displayName?, pictureUrl?, statusMessage?, raw }
```

**`fetchLineProfilesBatched` — does NOT yet exist.** This is the new function needed by `backlog-matcher.ts`. Pattern to implement:
- Input: `userIds: string[]`, `concurrencyLimit?: number` (suggest 5, mirrors Wise client limit)
- Output: `Map<string, LineProfile>` (skips 404s)
- Use bounded-concurrency fan-out (no bulk endpoint exists; confirmed in Phase 11 investigation)
- Retry: `fetchLineProfile` already throws on non-404 errors; caller should handle retries or let errors propagate

The `runLineFollowersReanchor` already does a sequential per-follower loop calling `fetchLineProfile`. `fetchLineProfilesBatched` formalizes this with bounded concurrency.

### 7. `src/app/api/line/contacts/followers-reanchor/route.ts` — current state

**File size:** 26 lines. Full current implementation:

```typescript
// Route: POST /api/line/contacts/followers-reanchor
export const maxDuration = 60;

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await runLineFollowersReanchor({ db: getDb() });
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run followers re-anchor";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

Auth tier: admin session (Auth.js), not CRON_SECRET. For C1, extend this to also call `runLineBacklogRecovery` and accept `?dryRun=true`. The route signature changes to `async function POST(request: NextRequest)` to read the URL param. The `maxDuration = 60` may need to increase — 1,962 follower profile fetches + matching takes longer than 60s in serial; for C1 the matching is done in-memory after profiles are fetched, but 1,962 sequential API calls could take 2-3 minutes.

**Advisory:** The design doc says "wire `runLineBacklogRecovery` into the existing `runLineFollowersReanchor`". In practice, the backlog recovery does NOT re-fetch all followers — it fetches fresh profiles for the full roster (needed for display names), matches against the target set, and inserts suggestions. If follower profiles are already cached in `lineContacts.displayName`, the backlog recovery can skip the fetch step. The planner should decide: (a) always fetch fresh profiles in the backlog recovery path, or (b) use the already-stored `displayName` from `lineContacts`.

### 8. `lineOaResolverRows` schema — target set for `listVerifiedResolverTargets`

**Confirmed columns (schema l.1868-1893):**

```typescript
export const lineOaResolverRows = pgTable("line_oa_resolver_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  wiseStudentId: text("wise_student_id").notNull(),
  studentKey: text("student_key").notNull(),
  studentName: text("student_name").notNull(),
  parentName: text("parent_name").notNull().default(""),
  searchCode: text("search_code"),
  status: text("status").notNull().default("pending"),
  lineOaAccountId: text("line_oa_account_id"),
  lineUserId: text("line_user_id"),
  lineChatUrl: text("line_chat_url"),
  committedLinkId: uuid("committed_link_id").references(...),
  // ...
});
```

**Query for `listVerifiedResolverTargets`:**

```typescript
// Filter: WHERE committed_link_id IS NOT NULL
// Returns ~662 rows (human-verified admin ground truth)
// Columns needed: studentName, parentName, searchCode, lineChatUrl, wiseStudentId, studentKey
await db
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
```

Note: `lineChatUrl` is nullable in the schema. Rows where `lineChatUrl IS NULL` have no chat URL to surface in the "LINE" button — the matching plan should handle this (either filter them out, or insert with `originalUrl: null` and the button gracefully disables).

---

## Drift vs Design Doc

| # | Design Doc Reference | Current Reality | Impact |
|---|---------------------|-----------------|--------|
| D1 | "add `'follower_profile'` to `studentLinkEvidence` source union (l.420)" | Current union has `'line_followers'` at l.426 (Phase 11 addition). `"follower_profile"` does not exist yet. | Planner must add `"follower_profile"` as a NEW variant alongside `"line_followers"`. Both coexist: `"line_followers"` = dotted-code path from Phase 11; `"follower_profile"` = distinctive-token backlog match from Phase 12. |
| D2 | "`runLineFollowersReanchor` / `POST /api/line/contacts/followers-reanchor`" as C1 vehicle | Route currently has `export const maxDuration = 60` and no `NextRequest` param | Extend to `async function POST(request: NextRequest)` to read `?dryRun`; evaluate whether `maxDuration` needs increasing for the combined follower-fetch + backlog-match workload |
| D3 | "`ensureLineContactStudentLinkSuggestions` insert path" as the reuse point | The function runs both the dotted-code path AND the name-matcher path. For backlog recovery the function is NOT called directly — a new direct insert is needed | Planner must write the insert inline in `runLineBacklogRecovery` (same pattern: `.insert(schema.lineContactStudentLinks).values({...}).onConflictDoNothing(...)`) rather than calling `ensureLineContactStudentLinkSuggestions` |
| D4 | "`nicknameCodes`" referenced as a building block for distinctive tokens | Currently `private` (unexported function at l.310) | Either export it from `student-links.ts` or inline it in `backlog-matcher.ts`. Recommend: export it, since it is a domain primitive |

---

## Schema + Migration Workflow (for C2 `lineBacklogRecoverySyncRuns`)

### Model to mirror: `wiseActivitySyncRuns`

```typescript
// schema.ts:280-298 — canonical simple sync-runs model
export const wiseActivitySyncRuns = pgTable("wise_activity_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: syncStatusEnum("status").notNull().default("running"),   // "running"|"success"|"failed"
  triggerType: text("trigger_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  // ... domain-specific counters ...
  errorSummary: text("error_summary"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  uniqueIndex("wise_activity_sync_runs_single_running_idx")
    .on(table.status)
    .where(sql`${table.status} = 'running'`),    // ← single-flight guard
  index("wise_activity_sync_runs_status_started_idx").on(table.status, table.startedAt),
]);
```

**Single-flight guard mechanics:**
- Partial `UNIQUE INDEX` on `status WHERE status = 'running'` — only one running row can exist
- Insert attempt while another is running → Postgres unique violation code `23505`
- Caller catches it: `isUniqueViolation(error)` → throw `WiseActivitySyncAlreadyRunningError` → route returns 409
- Stale-running recovery: at startup, `markAbandonedRuns(db, now)` sets `status="failed"` for rows started more than `STALE_RUNNING_MS` (20 minutes) ago via `lte(schema.wiseActivitySyncRuns.startedAt, new Date(now - STALE_RUNNING_MS))`

**For `lineBacklogRecoverySyncRuns`, add these domain-specific counters:**

```typescript
followerCount: integer("follower_count").notNull().default(0),
targetsCount: integer("targets_count").notNull().default(0),      // verified resolver targets
matchedCount: integer("matched_count").notNull().default(0),      // high-confidence matches
insertedCount: integer("inserted_count").notNull().default(0),    // suggestions actually inserted
dryRun: boolean("dry_run").notNull().default(false),
```

### Migration workflow

**EXACTLY:**

```bash
npm run db:generate        # generates drizzle/XXXX_name.sql + meta snapshot
# THEN: trim the generated .sql to only the new CREATE TABLE
# (drizzle meta is stale at 0021; db:generate emits catch-up noise)
# Verify: grep -E 'CREATE (TABLE|INDEX)|ADD CONSTRAINT' drizzle/XXXX_name.sql | grep -v line_backlog
# should produce zero lines
DATABASE_URL=... npm run db:migrate
```

**CRITICAL gotcha** (from project memory `drizzle-snapshot-drift.md`): The drizzle meta snapshots are NOW current (0040 is the latest committed snapshot — confirmed: `drizzle/meta/0040_snapshot.json` exists). The catch-up problem was resolved when `0038_snapshot.json` was generated (the Progress Tests reconciliation). As of this writing, meta snapshots go to 0040 and SQL migrations also stop at 0040. The `db:generate` for the Phase 12 table should produce a clean, minimal migration — but always verify with the grep before `db:migrate`.

**Next migration number:** `0041` (the `0040_student_promotions.sql` file exists in the tree but is NOT in `_journal.json` — it was committed during the "reconcile live production source" commit and lives outside the Drizzle migration chain; the journal's last entry is `idx: 40, tag: 0040_nifty_mercury`). So the next Drizzle-tracked migration is **0041**.

### Cron route pattern (C2)

Reference: `src/app/api/internal/sync-wise-activity/route.ts`

```typescript
// Pattern for src/app/api/internal/line-backlog-recovery/route.ts
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";

export const maxDuration = 300;   // 1,962 profile fetches + matching; tune at build time

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;

  return withCronInvocationAudit(
    { jobKey: "line_backlog_recovery", triggerSource: "cron", requestMethod: request.method },
    async () => { ... },
  );
}
```

**Registry addition needed:** `src/lib/data-health/cron-registry.ts` — add `"line_backlog_recovery"` to the `CronJobKey` union and a `CRON_JOBS` entry. Mark `manualOnly: true` initially (no auto-schedule until the dry-run gate passes).

**vercel.json:** Only add a cron entry if the job should run on a schedule. For Phase 12, this is a one-time/manual recovery — `manualOnly: true` in the registry + no `vercel.json` entry. If C2 is auto-scheduled in future, add it then.

### `withCronInvocationAudit` — confirmed location

```typescript
// src/lib/data-health/cron-audit.ts:144
export async function withCronInvocationAudit(
  input: AuditInput,
  handler: () => Promise<Response>,
): Promise<Response>
// AuditInput: { jobKey: CronJobKey; triggerSource: CronTriggerSource; actorEmail?: string | null; requestMethod?: string }
```

### `rejectInvalidCronSecret` — confirmed location

```typescript
// src/lib/internal/cron-auth.ts:19
export function rejectInvalidCronSecret(request: NextRequest): NextResponse | null
// Returns null if valid, error response if invalid (401) or misconfigured (500)
// Uses timingSafeEqual with length pre-check (REL-07 compliant)
```

---

## Distinctive-Token Matching Mechanics

### What "distinctive token" means

A token is **distinctive** if it is ≥4 characters AND belongs to one of:
1. **Lastname**: the last space-delimited token of a multi-word name (e.g., `"pinyavorakul"` from `"OIL PinyavorakuL"`)
2. **Parent name**: full parent name tokenized, especially unique lastnames (e.g., `"kaur"` from `"Pavan Kaur"`)
3. **Nickname-code**: text inside `(…)` in the student name/key (e.g., `"kaimook.ka"` from `"Ploychompu (Kaimook.Ka) …"`)

Short tokens (≤3 chars) are excluded because they collide (e.g., "Migs"→4 chars borderline, but many Thai names share 3-char tokens). The ≥4-char cutoff was empirically validated in the UAT evidence.

### Token index structure (for `backlog-matcher.ts`)

```typescript
// buildTargetTokenIndex: Map<normalizedToken, Set<targetRowKey>>
// Built from listVerifiedResolverTargets() results
// For each target row:
//   1. Tokenize parentName: split on spaces after normalizing via normalizeLineStudentCode → filter ≥4 chars
//   2. Tokenize studentName: split + filter ≥4 chars
//   3. Extract nicknameCodes (the (…) regex) from studentName + searchCode → already normalized
// Insert each qualifying token → index[token].add(rowKey)
```

### Match logic

```typescript
// matchFollowersToTargets(followers: LineProfile[], targetIndex) → MatchResult[]
// For each follower display name:
//   1. Normalize via normalizeLineStudentCode (not normalizeForNameMatch — no spaces preserved)
//   2. Extract distinctive tokens (≥4 chars after normalization)
//   3. For each token: look up targetIndex — collect matching student keys
//   4. Union across tokens: if ONE student key appears → high-confidence (unambiguous)
//      If MULTIPLE student keys appear → ambiguous shortlist (never auto-collapse)
//      If ZERO student keys → no match
// Result: { follower, matchedStudentKey, confidence: "high" | "ambiguous", tokens: string[] }
```

### Normalization reuse

- `normalizeLineStudentCode(value)` from `student-links.ts:85` — use for code/token normalization (strips spaces, lowercases, NFKC, keeps `.` for enrollment codes)
- `normalizeForNameMatch(value)` from `name-matcher.ts:53` — use if splitting on spaces for display-name tokens (preserves spaces as delimiters, different from normalizeLineStudentCode which collapses them)
- For distinctive-token extraction from the TARGET set (resolver rows): use `normalizeLineStudentCode` to normalize each token after space-split (since resolver rows have structured Thai/English names)
- For the FOLLOWER display name: normalize the whole string first, then split on spaces, then filter ≥4 chars

### Key invariants

- Exactly-one-student match → high-confidence → insert `status:"suggested"`, `confidence: 0.95`
- Multiple-student match → ambiguous → either omit entirely or insert with lower confidence + `ambiguous: true` in evidence (never auto-collapse to one pick)
- No Levenshtein anywhere in `backlog-matcher.ts`
- No full-Wise-directory fallback
- `lineChatUrl` from the resolver target row → `evidence.originalUrl` → populates the "LINE" button

---

## Test Patterns

### Existing test structure to follow

`src/lib/line/__tests__/name-matcher.test.ts` — unit tests for pure functions:
- Imports with destructuring from the module under test
- `student()` helper for `LineStudentDirectoryRow` with defaults
- `describe` blocks per function, `it` blocks per case
- No DB, no network — pure function tests

`src/lib/line/__tests__/name-matcher.eval.test.ts` — precision/recall eval:
- Mock directory with 3× distractor students
- Fixtures with `{ label, studentName, parentName, expectedStudentKey }`
- Precision/recall assertions in a single `it` block
- Both fuzzy fixtures recall via an exact second-token path:
  - "Pimchaok Wannakorn" → `wannakorn` token → token tier (score 70), not fuzzy (design doc note: "two fuzzy fixtures still recall via an exact second-token")
  - "Nicho Suwanprasert" → `suwanprasert` token → token tier (score 70)
  - So dropping the fuzzy tier does NOT break these fixtures — they already pass via token tier

**Test files to author:**

`src/lib/line/__tests__/backlog-matcher.test.ts` — pure function unit tests:
- Test `distinctiveTokens(name)` with Thai/English/mixed inputs, ≥4-char filter, (…) extraction
- Test `buildTargetTokenIndex(targets)` with known inputs → expected index
- Test `matchFollowersToTargets(followers, index)` covering: unambiguous match, ambiguous (multi-student), no match, empty display name

### After dropping the fuzzy tier from `name-matcher.ts`:

- Remove `student_name_fuzzy` and `parent_name_fuzzy` from the `NameMatchCandidate.matchBasis` union
- Remove corresponding score table comment rows
- Update `name-matcher.test.ts`: any test asserting `matchBasis: "student_name_fuzzy"` must be updated to assert the correct token-tier basis (or removed if it tested a case that now produces no match)
- The eval precision gate should IMPROVE (less noise → higher precision)

### Test baseline

**Current count:** 1,119 tests across 162 files (verified via `npm test -- --reporter=dot` on 2026-06-07).

After Phase 12, count increases by new `backlog-matcher.test.ts` tests plus updated name-matcher tests. The regression gate: all 1,119 pre-existing tests must continue passing.

### Test commands

```bash
npm test                          # unit tests (vitest run --project unit) — quick gate
npm run test:all                  # unit + integration tests
npx tsc --noEmit                  # TypeScript check (no exit-code pipe — check separately)
```

---

## Production Dry-Run Gate Mechanics

### The hard gate before any write

The design doc mandates: **before any DB write, run a read-only dry-run on prod that prints ~229 would-be suggestions with real `chat.line.biz` URLs**. This is the verification step between `runLineBacklogRecovery({ dryRun: true })` and the first real insert.

### Implementation shape

```typescript
// In runLineBacklogRecovery:
export async function runLineBacklogRecovery({ db, dryRun = false }: {
  db: Database;
  dryRun?: boolean;
}): Promise<LineBacklogRecoveryResult> {
  // Step 1: fetch all follower profiles (or use stored displayName from lineContacts)
  // Step 2: load verified targets from listVerifiedResolverTargets(db)
  // Step 3: build token index from targets
  // Step 4: match each follower displayName against index
  // Step 5: if dryRun: console.log each match (lineUserId, displayName, studentName, lineChatUrl)
  //          else: insert suggested links
  return { matched, inserted, dryRunMatches }
}
```

### How to run it in production

```bash
# Pull production env (critical — local LINE token is "BeGifted Testing", not prod)
vercel env pull --environment=production .env.production.local

# Invoke via the C1 route or a local script:
# Option A — via the reanchor endpoint with dryRun=true (after C1 wiring):
curl -X POST https://bgscheduler.vercel.app/api/line/contacts/followers-reanchor?dryRun=true \
  -H "Cookie: <admin-session-cookie>"

# Option B — local script using production env:
DATABASE_URL=<prod-neon-url> LINE_CHANNEL_ACCESS_TOKEN=<prod-token> \
  npx ts-node --project tsconfig.json scripts/backlog-recovery-dry-run.ts
```

### Credential gotcha (CRITICAL)

Local `.env.local` has `LINE_CHANNEL_ACCESS_TOKEN` for the **"BeGifted Testing"** channel — a different OA. Production is `@begifted` (BeGifted Education, premium). Running the dry-run locally against the testing channel will fetch different followers. Use `vercel env pull --environment=production` to get the production token.

### Spot-check against CSV

The UAT produced `/tmp/line-identity-matches.csv` (the 229 match candidates). Spot-check at least 10 dry-run results against this CSV — verify `lineChatUrl` values are real `chat.line.biz` URLs and student names match expectations.

---

## Fail-Closed and Security Surface

### Fail-closed invariants (must be enforced in `backlog-matcher.ts`)

1. `"follower_profile"` rows insert as `status:"suggested"` NEVER `status:"verified"` — hard-code in the insert, comment as "ALWAYS suggested — NEVER verified from content (IDENT-02)" (mirrors student-links.ts:508)
2. Ambiguous matches (multiple student keys from the token index) NEVER auto-collapse to one student — either omit or insert all as an ambiguous shortlist with `confidence < 0.95`
3. `backlog-matcher.ts` has ZERO DB imports — pure function (mirrors name-matcher.ts:10 fail-closed invariant)
4. The existing `lineContactStudentLinks` UNIQUE constraint on `(contactId, studentKey)` prevents duplicate suggestions — use `.onConflictDoNothing()` as the existing insert paths do

### Phase B boundary (change-control)

Phase B (forward deterministic capture via app-sent booking confirmations) requires enabling the LINE write-path (`ENABLE_LINE_SCHEDULER`). This is explicitly deferred. Phase 12 (Phase A) must NOT enable `ENABLE_LINE_SCHEDULER`. The design doc documents this separation clearly. The planner should not include any `ENABLE_LINE_SCHEDULER` change.

### New/extended threat surface for Phase 12

| Threat | Category | Mitigation |
|--------|----------|------------|
| Backlog recovery inserts verified link without admin | Tampering | Hard-code `status:"suggested"` in insert (IDENT-02); no code path sets verified from matcher |
| Ambiguous match auto-selects one student | Tampering | Ambiguous case never collapses — either omit or shortlist all matches |
| Production LINE PII (display names, chat URLs) in logs | Info Disclosure | No `console.log` of display names or chat URLs in production code; dry-run prints are CLI only |
| `evidence.originalUrl` is a `chat.line.biz` URL stored in Postgres | Info Disclosure | Same as Phase 11 accepted risk T-11-03: admin-only routes gate access |
| C2 cron route unauthenticated call | Elevation of Privilege | `rejectInvalidCronSecret` with `timingSafeEqual` (REL-07) — identical to all other internal routes |
| lineChatUrl is null for some resolver targets | Data integrity | Filter out targets with null `lineChatUrl` before building index, or insert with `evidence.originalUrl: null` (button disables gracefully) |

### ASVS scope

Phase 12 is a backend-only data recovery. Phase 11 established the full ASVS assessment. Phase 12 adds:

- V5 Input Validation: follower display names are LINE-API-provided untrusted strings → normalize before token extraction; never pass raw to SQL (parameterized via Drizzle)
- V4 Access Control: C1 route is admin-session gated (Auth.js); C2 cron route is CRON_SECRET gated — both already audited in Phase 11 T-11-11

---

## Environment Availability

The Phase 12 LINE API calls are identical to Phase 11 calls — no new external dependencies. Environment availability was confirmed during Phase 11 UAT on 2026-06-07:

| Dependency | Required By | Available | Notes |
|------------|------------|-----------|-------|
| `GET /v2/bot/followers/ids` | `fetchLineFollowerIds` | YES | 1,962 followers confirmed on prod OA |
| `GET /v2/bot/profile/{userId}` | `fetchLineProfile` | YES | Confirmed for real messaging contacts |
| Neon Postgres (ap-southeast-1) | All DB reads/writes | YES | Production + test |
| `LINE_CHANNEL_ACCESS_TOKEN` (prod) | All LINE API calls | via Vercel | Local token is TESTING channel — use `vercel env pull --environment=production` |

**Critical runtime configuration:** The `lineSchedulerEnabled()` check in `client.ts:19` returns false if `ENABLE_LINE_SCHEDULER === "false"`. However, `fetchLineFollowerIds` and `fetchLineProfile` call `lineAccessToken()` directly — they do NOT check `lineSchedulerEnabled()`. So the backlog recovery works regardless of `ENABLE_LINE_SCHEDULER` flag, as long as `LINE_CHANNEL_ACCESS_TOKEN` is set. Confirm this remains true after any code changes.

---

## Open Questions (RESOLVED)

1. **Display name vs fresh profile fetch for backlog recovery:**
   - What we know: `lineContacts.displayName` was populated by `runLineFollowersReanchor` (Phase 11 re-anchor job). If the re-anchor was run recently, these names are current.
   - What's unclear: if a follower changed their display name since the re-anchor, the stored name is stale.
   - Recommendation: For the dry-run and initial landing, use stored `displayName` from `lineContacts` (no extra API calls needed). For the production run, optionally re-fetch with `fetchLineProfilesBatched`. Let the planner decide at build time.
   - **RESOLVED:** Use stored `displayName` from `lineContacts` (no fresh API fetch). The Phase 11 re-anchor populated these; the backlog recovery reads them in-memory. This keeps `runLineBacklogRecovery` fast and keeps C1 within `maxDuration=300`.

2. **Ambiguous match handling policy:**
   - What we know: UAT showed 323 followers have ≥1 distinctive match; 229 are unambiguous (single student); 94 are ambiguous.
   - What's unclear: design doc says "many → ambiguous shortlist" but doesn't specify whether to insert or omit them.
   - Recommendation: Insert ambiguous matches with `confidence: 0.60` and `evidence.matchBasis: "ambiguous"` so admins can review, but do not surface them in the primary worklist by default (or mark them in the UI with a badge). This is a planner decision — document it in the plan.
   - **RESOLVED:** Insert ambiguous matches with `confidence: 0.60` and `evidence.ambiguous: true`. They are inserted as `status:"suggested"` and appear in the review worklist (distinguishable from high-confidence 0.95 entries). Never auto-collapsed to one student pick.

3. **maxDuration for C1 route:**
   - What we know: `runLineFollowersReanchor` currently has `maxDuration = 60` on the route. The backlog recovery must fetch 1,962 profiles (if fresh) + match all against the target index.
   - What's unclear: actual latency of 1,962 sequential `getProfile` calls in production.
   - Recommendation: If using stored `displayName` (not fresh fetch), the backlog recovery is fast (in-memory match only). If fetching fresh, increase `maxDuration` to 300. The planner must pick one approach and set `maxDuration` accordingly.
   - **RESOLVED:** `maxDuration` raised to 300 on C1 route (`followers-reanchor`). The backlog recovery itself is in-memory (fast); the 300s budget covers `runLineFollowersReanchor`'s ~1,962 sequential LINE API calls.

---

## Assumptions Log

All factual claims in this research were verified against live source files on 2026-06-07. No claims are tagged `[ASSUMED]`.

| # | Claim | Section | Verification |
|---|-------|---------|--------------|
| — | — | — | (table is empty — all claims verified) |

---

## Sources

- `~/.claude/plans/can-t-we-look-for-sunny-lampson.md` — locked design doc [VERIFIED: read in full]
- `.planning/phases/11-*/11-IDENTITY-FINDINGS.md` — UAT evidence, ~229 number, distinctive-token method [VERIFIED: read in full]
- `src/lib/line/link-validation.ts` l.300 — lineChatUrl assignment [VERIFIED: opened]
- `src/lib/line/link-validation.ts` l.15-51 — LineLinkValidationTaskDto type [VERIFIED: opened]
- `src/components/line-review/link-validation-panel.tsx` l.582-592 — LINE button [VERIFIED: opened]
- `src/lib/line/oa-resolver.ts` l.1030-1050 — linkEvidence pattern [VERIFIED: opened]
- `src/lib/line/student-links.ts` l.85, 310, 420, 457, 753 — core functions [VERIFIED: opened]
- `src/lib/line/name-matcher.ts` l.76, 96, 197-265 — 3-tier matcher [VERIFIED: read in full]
- `src/lib/line/client.ts` l.41-88 — fetchLineProfile + fetchLineFollowerIds [VERIFIED: read in full]
- `src/app/api/line/contacts/followers-reanchor/route.ts` — full route [VERIFIED: read in full]
- `src/lib/db/schema.ts` l.1735-1774, 1868-1893 — lineContactStudentLinks + lineOaResolverRows [VERIFIED: opened]
- `src/lib/wise-activity/sync.ts` l.13-165 — single-flight pattern [VERIFIED: opened]
- `src/lib/internal/cron-auth.ts` — rejectInvalidCronSecret [VERIFIED: read in full]
- `src/lib/data-health/cron-audit.ts` l.144-159 — withCronInvocationAudit [VERIFIED: opened]
- `src/lib/data-health/cron-registry.ts` — CronJobKey union + CRON_JOBS [VERIFIED: read in full]
- `vercel.json` — cron registrations [VERIFIED: read in full]
- `drizzle/meta/_journal.json` — migration state (last entry idx:40) [VERIFIED: opened]
- `~/.claude/projects/-Users-kevinhsieh-Developer-Scheduling/memory/drizzle-snapshot-drift.md` [VERIFIED: read]
- `npm test -- --reporter=dot` output — 1,119 tests / 162 files baseline [VERIFIED: executed]

---

## RESEARCH COMPLETE

**Phase:** 12 — LINE Backlog Identity Recovery (IDENT-07)
**Confidence:** HIGH — all code anchors verified against live source

### Key Findings

- All design-doc anchors exist at approximately the stated lines. One naming drift: the design doc says add `"follower_profile"` to `studentLinkEvidence` source union but the current union has `"line_followers"` (added in Phase 11). Both variants should coexist; the planner must add `"follower_profile"` as a new distinct member.
- The one-click-confirm UI path is end-to-end: `evidence.originalUrl` → `lineChatUrl` in DTO (l.300) → "LINE" button (l.587) → opens real chat. No UI change needed for core flow.
- `backlog-matcher.ts` is a net-new file: pure TS, no DB, mirrors `name-matcher.ts` architecture. `nicknameCodes` must be exported from `student-links.ts` for reuse.
- `fetchLineProfilesBatched` is a net-new function in `client.ts`: bounded-concurrency fan-out over the existing `fetchLineProfile`; 404→skip.
- Migration: next number is **0041**; drizzle meta snapshots are current (0040); the catch-up drift problem from memory is resolved. Still trim-verify the generated SQL before `db:migrate`.
- Test baseline: **1,119 tests / 162 files** as of 2026-06-07. The two fuzzy eval fixtures recall via token tier already — dropping the fuzzy tier from `name-matcher.ts` does not break them.
- Phase B (`ENABLE_LINE_SCHEDULER`) is explicitly deferred. The planner must not include any write-path enablement in Phase 12 plans.
- Production credential gotcha: local LINE token is "BeGifted Testing". Use `vercel env pull --environment=production` before any prod dry-run.

### File Created

`.planning/phases/12-line-backlog-identity-recovery-ident-07-map-existing-line-co/12-RESEARCH.md`

### Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Code anchors | HIGH | All files opened and line numbers confirmed |
| Schema/migration | HIGH | Schema columns verified; migration journal state confirmed |
| Matching mechanics | HIGH | UAT-validated approach; token logic mirrors verified Phase 11 patterns |
| Test patterns | HIGH | Existing test files read; fuzzy fixture behavior verified |
| Dry-run gate | HIGH | Credential gotcha documented from IDENTITY-FINDINGS.md §6 |

### Open Questions

1. Whether to use stored `displayName` vs fresh `fetchLineProfilesBatched` for the backlog recovery (planner decides)
2. Ambiguous match insert vs omit policy for the 94 multi-student matches (planner decides)
3. `maxDuration` for C1 route if fresh profile fetch is chosen (planner decides, recommend 300s)

### Ready for Planning

Research complete. Planner can now create PLAN.md files following the design doc build order:
1. `backlog-matcher.ts` + unit tests
2. `fetchLineProfilesBatched` in `client.ts`
3. `listVerifiedResolverTargets` + `runLineBacklogRecovery({ dryRun: true })` → prod dry-run
4. C1 wiring: extend `runLineFollowersReanchor` route
5. Drop fuzzy tier from `name-matcher.ts` + update tests
6. C2: `lineBacklogRecoverySyncRuns` schema + cron route + registry
