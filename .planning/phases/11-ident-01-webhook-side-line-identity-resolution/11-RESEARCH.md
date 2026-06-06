# Phase 11: IDENT-01 Webhook-Side LINE Identity Resolution — Research

**Researched:** 2026-06-06
**Domain:** LINE Messaging API identity, Thai name matching, Drizzle schema evolution
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Tiered match — confident single → one `suggested` link; multiple plausible → ranked shortlist (still `suggested`); no/weak → contact stays unlinked, reviews route to Needs Review. Never auto-chosen.
- **D-02:** `followers/ids` re-anchor runs as an admin-triggered, re-runnable, idempotent button in the LINE admin UI. Not a cron, not a one-off script.
- **D-03:** Phantom quarantine = hidden from active views but visible behind a labeled "legacy / needs re-match" archive filter. Flag + exclude, never delete.
- **D-04:** Minimal UI — widen the existing link-validation worklist to surface `suggested` links on real messaging/follower contacts (drop the `lineOaResolverSourceCondition()` OA-resolver-only scope); reuse current verify flow and UI.

### Claude's Discretion
- Name-matching algorithm internals (Thai normalization, fuzzy/token strategy, confidence scoring, candidate dedup)
- Confidence thresholds (single-suggest vs shortlist vs drop)
- Quarantine flag mechanism (column vs derived predicate)
- Re-link recompute trigger (inline-on-verify vs lightweight backfill)
- `followers/ids` pagination + rate-limit handling, `getProfile` batching
- Eval set construction, precision/recall measurement, integration with eval harness

### Deferred Ideas (OUT OF SCOPE)
- Conversational self-identify (AI asks parent "which student is this for?")
- Any Wise mutation / writeback
- Autonomous reply / auto-send
- Deleting phantom data (quarantine only)
- Changing the classifier / AI extraction itself
- Deprecating/removing the OA-resolver extension code
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| IDENT-01 | Content-based link suggestions from AI-extracted `studentName`/`parentName` on real messaging contacts | Name-matching algorithm, confidence scoring, `processLineMessageForScheduler` wiring |
| IDENT-02 | Fail-closed verification — `suggested` only from content; `verified` only via admin action; unresolved → Needs Review | Confirmed: code paths, `approveLineSchedulerReview` gate, `listVerifiedLineStudentKeys` |
| IDENT-03 | `followers/ids` re-anchor: bulk correct-namespace contacts seeded, idempotent, runs matcher for suggestions | LINE API contract, `fetchLineProfile` batching, upsert pattern |
| IDENT-04 | Mapping Validation UI re-pointed to real contacts — widen `lineOaResolverSourceCondition()` scope | `listLineLinkValidationTasks` rewrite, archive filter via new `scope` value |
| IDENT-05 | Quarantine phantom contacts/links — excluded from counts/queues; flagged, never deleted | Quarantine column recommendation and all affected surfaces identified |
| IDENT-06 | On link verify, pending reviews recompute and badge refreshes without manual click | Inline-on-verify pattern using existing `operational-plan` route |
</phase_requirements>

---

## Summary

This phase's core challenge is building a name-based contact→student matcher that works reliably for Thai names (no inter-word spaces, heavy nickname culture, Buddhist era dates) with zero new heavy dependencies. The codebase already contains the exact primitives needed: Unicode NFKC normalization (`normalizeLineStudentCode`), a Levenshtein function (`data.ts:1090`), and a ranked student search (`searchLineStudentRows`). The recommended strategy stacks these: exact NFKC match first, then token overlap, then character-level edit distance — all in deterministic pure TypeScript, no new packages.

The six discrete work streams (matcher, followers/ids re-anchor, UI re-point, quarantine, re-link refresh, eval set) are largely independent and map naturally to planning waves. The only cross-stream dependency is quarantine-before-UI-re-point: the worklist must exclude phantoms before it can be widened to show real contacts without inflating the queue with noise.

The Drizzle migration workflow is confirmed: `npm run db:generate` (drizzle-kit generate against `schema.ts`) then `DATABASE_URL=... npm run db:migrate`. The known gotcha — bloated catch-up migrations from `db:generate` — applies here; any added column must be trimmed before running.

**Primary recommendation:** Use a three-tier deterministic matcher (exact NFKC → token overlap → Levenshtein ≤ 2) with precision-first thresholds calibrated against a 50-message labeled eval set drawn from the 805 real scheduling messages. Quarantine via a new `boolean` column `isPhantom` on `line_contact_student_links` (not a derived predicate). Trigger the re-link recompute inline on verify, not as a separate backfill job.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Name-based link suggestion | API / Backend (`src/lib/line/student-links.ts`) | — | Deterministic matcher runs in the Node process alongside the student directory; no browser involvement |
| Content-name extraction source | Already API-tier (`ai_scheduler_conversations.extractedState`, `ai_scheduler_messages.structuredPayload`) | — | Names are already extracted by the AI scheduler turn; matcher consumes them |
| `followers/ids` re-anchor job | API / Backend (new internal route + `src/lib/line/client.ts`) | Frontend trigger button | LINE API call + DB upsert is server-only; button lives in mapping validation workspace |
| Phantom quarantine flag | Database / Storage (Drizzle schema column) | API filtering | Flag set once at classify time; all queries filter on it at the DB layer |
| Link validation worklist | API / Backend (`src/lib/line/link-validation.ts`) | Frontend panel component | Query scope predicate lives in lib; panel renders the result |
| Review re-link refresh | API / Backend (reuse `operational-plan` POST route) | Frontend badge | Route already exists and calls `buildLineOperationalReviewPlan`; badge reads live link state |
| Eval set measurement | Test infrastructure (`src/lib/line/__tests__/`) | — | Vitest unit test with fixture file |

---

## Standard Stack

### Core (no new dependencies required)

All required capabilities are already present in the installed dependencies.

| Library | Version | Purpose | Relevance |
|---------|---------|---------|-----------|
| `zod` | `^4.3.6` | Validate `followers/ids` response, new route bodies | Already used everywhere |
| `drizzle-orm` | `0.45.2` | New schema column, all DB queries | Already used |
| `drizzle-kit` | `^0.31.10` | `db:generate` to produce migration | Already used |
| `uuid` | `^13.0.0` | New route IDs | Already used |
| `date-fns-tz` | `^3.2.0` | Asia/Bangkok time in re-anchor job | Already used |

### No new dependencies needed

The `levenshtein` function already exists in `src/lib/line/data.ts:1090-1107` (pure TypeScript). The `normalizeLineStudentCode` function already handles Unicode NFKC + Thai character range. No fuzzy-matching library is needed or appropriate given the determinism requirement.

**Confirmed absent from `package.json`:** `fuse.js`, `fuzzysort`, `natural`, `fast-fuzzy`, `string-similarity`, `wink-distance` — none present. Adding any would be unjustified.

---

## Architecture Patterns

### System Architecture Diagram

```
LINE Webhook message
        │
        ▼
processLineMessageForScheduler (review-service.ts:126)
        │
        ├─► fetchLineProfile()  (profile for display-name match)
        │
        ├─► ensureLineContactStudentLinkSuggestions()  [EXTEND THIS]
        │         │
        │         ├─► resolveLineStudentCodeMatches()   (existing: dotted code)
        │         └─► matchNamesToStudentDirectory()    [NEW: name-based matcher]
        │                   │
        │                   ├─► listCurrentLineStudents() → student directory
        │                   ├─► extractNames from classifierPayload / extractedState
        │                   └─► produce scored suggestions → INSERT suggested links
        │
        └─► classifyLineSchedulerMessage() → review created
                                                    │
                                             (badge reads live link state via IDENT-06)

Admin-triggered re-anchor button (D-02)
        │
        ▼
POST /api/line/contacts/followers-reanchor   [NEW ROUTE]
        │
        ├─► fetchLineFollowerIds()  [NEW in client.ts] — paginated GET /v2/bot/followers/ids
        ├─► fetchLineProfile() — batch per follower userId
        ├─► upsertLineContact() — onConflictDoNothing on lineUserId
        └─► ensureLineContactStudentLinkSuggestions() — matcher runs per new contact

Admin verifies link via existing UI
        │
        ▼
PATCH /api/line/contacts/link-validation/{linkId}  (patchLineLinkValidationTaskStatus)
        │
        └─► [NEW] trigger inline recompute for contact's pending reviews  (IDENT-06)
                    │
                    └─► buildLineOperationalReviewPlan() + patchLineSchedulerOperationalPlan()
```

### Recommended Project Structure (new files only)

```
src/lib/line/
├── name-matcher.ts          # New: deterministic name-based matcher
│                            # (pure functions, no DB access, fully testable)
├── student-links.ts         # Extend: add matchNamesForContact(), wire new source types
├── client.ts                # Extend: add fetchLineFollowerIds()
├── link-validation.ts       # Extend: widen scope predicate, add archive filter
└── __tests__/
    ├── name-matcher.test.ts         # New: matcher precision/recall unit tests
    └── name-matcher.eval.test.ts   # New: eval set fixture (labeled real messages)

src/app/api/line/contacts/
└── followers-reanchor/
    └── route.ts             # New: POST handler for D-02 button
```

---

## Research Target 1: Name-Matching Algorithm

### Source of Extracted Names

The AI scheduler already extracts `studentName` and `parentName` into two places:

1. **`aiSchedulerConversations.extractedState`** (JSONB) — accumulated state across turns; contains `{ studentName?: string, parentName?: string, ... }`. Type: `SchedulerExtractedState` (`src/lib/ai/scheduler-conversation.ts:57-82`).

2. **`aiSchedulerMessages.structuredPayload.extractedState`** — the per-turn extraction (same fields).

For the matcher to work per-message in `processLineMessageForScheduler`, the names must be read from the **classifier payload or the existing conversation's extractedState**. The cleanest path: after `ensureLineContactStudentLinkSuggestions` is extended, it also accepts a `names?: { studentName?: string; parentName?: string }` parameter sourced from the thread's `aiSchedulerConversation.extractedState` JSONB. The caller (`processLineMessageForScheduler`) already has `lineMessage.aiSchedulerConversationId` and can supply cached extracted state.

**Important:** The classifier (`classifyLineSchedulerMessage`) does NOT extract student names — it only classifies intent. Names come from the AI scheduler extraction turn. This means the name-based matcher can only run on contacts that have had at least one AI scheduler turn. For contacts with only an initial webhook with no prior AI run, the matcher falls back to display-name parsing (existing behavior). This is fine — most of the 252 real messaging contacts have 805 classified messages with at least one AI scheduler run.

### Recommended Algorithm

**Three-tier deterministic pipeline (no new dependencies):**

```typescript
// src/lib/line/name-matcher.ts
export interface NameMatchCandidate {
  student: LineStudentDirectoryRow;
  score: number;        // 0-100
  matchBasis: "student_name_exact" | "parent_name_exact" | "student_name_token" | "parent_name_token" | "student_name_fuzzy" | "parent_name_fuzzy";
}

export function matchNamesToDirectory(
  names: { studentName?: string | null; parentName?: string | null },
  students: LineStudentDirectoryRow[],
): NameMatchCandidate[] {
  // Step 1: normalize inputs with existing normalizeLineStudentCode (NFKC, Thai-aware)
  // Step 2: Tier 1 — exact NFKC match → score 90
  // Step 3: Tier 2 — token subset match (every input token appears in student name) → score 70
  // Step 4: Tier 3 — Levenshtein ≤ 2 on shortest token → score 50
  // Combine studentName + parentName signals, dedup by studentKey, sort descending
}
```

**Normalization function (already exists, reuse):**

```typescript
// src/lib/line/student-links.ts:83-89
export function normalizeLineStudentCode(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9.ก-๙]/g, "");
}
```

This already strips Thai tone marks and handles Unicode variants. For name matching, a slightly looser version that keeps spaces as token delimiters is needed. Concretely: `NFKC → lowercase → trim → collapse spaces → strip non-[a-z0-9ก-๙ ]`. The existing function's `.replace(/\s+/g, "")` collapses all whitespace which is correct for code matching but wrong for token splitting — use a separate normalizer for the name matcher.

**Levenshtein (already in codebase):**

```typescript
// src/lib/line/data.ts:1090-1107 — private but can be extracted to a shared helper
function levenshtein(a: string, b: string): number { ... }
```

The planner should move or re-implement this in `name-matcher.ts` as a named export for testability.

**Token strategy for Thai names:**

Thai names have no inter-word spaces (e.g., "นิชา" is a single token). The `studentName` field in the credit-control snapshot uses the Wise API's format which may be romanized (e.g., "Nicha Suwanprasert") or Thai (e.g., "นิชา สุวรรณประเสริฐ"). The AI extractor is already asked to return names "as mentioned by the parent," which may be a nickname ("หนูนา"), romanized first name ("Nicha"), or full Thai name.

**Recommended token matching approach:**

1. Split on whitespace and common separators after NFKC normalization.
2. For Thai-only tokens (all characters in ก-๙ range): compare the entire token (no sub-word splitting — Thai word segmentation needs a library like `thai-tokenizer` which is NOT installed). A full-token exact/edit-distance match is sufficient given most names are single words.
3. For romanized tokens: standard space-split + Levenshtein on individual tokens.

**Confidence scoring:**

| Match type | Score | Confidence |
|------------|-------|------------|
| Exact NFKC match on studentName | 90 | High |
| Exact NFKC match on parentName only | 75 | High |
| Token subset match on studentName (≥1 token) | 70 | Medium |
| Token subset match on parentName | 55 | Medium |
| Levenshtein ≤ 2 on studentName token | 50 | Low |
| Levenshtein ≤ 2 on parentName token | 35 | Low |

**Threshold recommendations (calibrate against eval set):**

| Result | Condition | Confidence value stored |
|--------|-----------|------------------------|
| Single-suggest (D-01 confident) | One student with score ≥ 70 | `score / 100` |
| Shortlist (D-01 plausible) | Multiple students with score ≥ 50, or one at 50-69 | `score / 100` |
| Drop (no match) | All scores < 50 | No row inserted |

These are initial calibration targets. The eval set (Research Target 3) determines whether they should be raised or lowered.

**Rejected alternatives:**

- **AI-powered matching (LLM call):** Explicitly out of scope per SPEC. Non-deterministic, adds latency, costs tokens per message.
- **Fuse.js / fast-fuzzy:** No dependency justified when the three-tier pure-TS approach covers the cases. Thai phonetic matching (romanization libraries) similarly unjustified — the names already appear in their spoken form in the AI extraction.
- **Soundex/Metaphone:** English-only, would fail all Thai names.

---

## Research Target 2: Confidence Scoring and Thresholds

### Precision-First Calibration

**Wrong-student is the highest-severity error.** This mandates aggressive precision thresholds:

- The single-suggest threshold (≥ 70 score) means the matcher must find a single student where the normalized name overlaps at the token level or better. A score of 69 or lower routes to shortlist or drop — never to a single suggestion.
- The shortlist is surfaced to the admin, who must pick. This is not an error; it is the designed workflow.
- Scores below 50 produce no link at all, not even a shortlist entry.

**Calibration methodology:**

1. Build a labeled eval set of 50 messages (Research Target 3).
2. Run the matcher over the eval set with the initial thresholds.
3. Compute precision (correct student in suggestion / total suggestions) and recall (contacts with correct student link / total contacts that should have one).
4. Adjust thresholds to maximize precision subject to recall ≥ 60%.
5. Record the calibrated thresholds as constants in `name-matcher.ts`: `SUGGEST_SINGLE_MIN_SCORE = 70`, `SUGGEST_SHORTLIST_MIN_SCORE = 50`.

**Wrong-student detection note:** Because `onConflictDoNothing` is used on `(contactId, studentKey)`, running the matcher multiple times on a contact that already has a `suggested` link does not overwrite it with a lower-quality match. However, a higher-quality match for a DIFFERENT student may be missed if the contact already has a link for another student. The planner should note that re-running the matcher on a contact with existing `suggested` links should check for new, higher-scoring students not yet linked.

---

## Research Target 3: Eval Set Construction

### Where Names Are Stored for Querying

Extracted names for real messages are found in:
1. `ai_scheduler_conversations.extracted_state` JSONB — the accumulated state including `studentName`, `parentName`.
2. `ai_scheduler_messages.structured_payload.extractedState` — per-turn extraction.

The eval set should join `line_messages` (scheduling-classified) → `line_threads` → `ai_scheduler_conversations` → `extracted_state` to retrieve names alongside the contact's ground-truth `studentKey` (established by a human reviewer).

### Eval Set Construction Steps

1. **Sample:** Take 50 contacts from the 252 real messaging contacts that have at least one `scheduling_request` or `scheduling_change` classified message and a non-null `extractedState.studentName` or `extractedState.parentName`.
2. **Label:** For each sampled contact, a human reviewer determines the correct `studentKey` from the credit-control student directory (this is the ground truth). Store as a JSON fixture.
3. **Fixture format:** A TypeScript array of `{ contactId, lineUserId, studentName, parentName, expectedStudentKey }` in a test file `src/lib/line/__tests__/name-matcher.eval.test.ts`.
4. **Measurement:** The eval test runs the matcher over each fixture and reports: precision (fraction of suggestions where `expectedStudentKey` is in the suggestion set), recall (fraction of contacts where at least one suggestion is correct), and false positives (suggestions for the wrong student).

### Integration with Existing Eval Harness

The existing AI scheduler eval pattern uses standard Vitest unit tests in `src/lib/ai/__tests__/scheduler-conversation.test.ts` and `src/lib/ai/__tests__/scheduler.test.ts` with fixture helper functions (`group()`, `index()`, `hold()`). The name-matcher eval follows the same pattern:

```typescript
// src/lib/line/__tests__/name-matcher.eval.test.ts
import { describe, expect, it } from "vitest";
import { matchNamesToDirectory } from "@/lib/line/name-matcher";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";

const EVAL_FIXTURES = [
  { studentName: "Nicha", parentName: null, expectedStudentKey: "nicha.sw::parent" },
  { studentName: "นิชา", parentName: "คุณแม่ส้ม", expectedStudentKey: "nicha.sw::parent" },
  // ... 48 more from real messages
] as const;
```

**Run command:** `npx vitest run --project unit src/lib/line/__tests__/name-matcher.eval.test.ts`

No separate eval harness infrastructure is needed — Vitest's `it` blocks with precision/recall assertions are the harness.

---

## Research Target 4: `followers/ids` Re-Anchor Mechanics

### LINE API Contract (verified via SDK source)

**Endpoint:** `GET /v2/bot/followers/ids`
**Authorization:** `Bearer {LINE_CHANNEL_ACCESS_TOKEN}`
**Account requirement:** Verified or premium OA (confirmed: the production OA is verified/premium per SPEC)

**Query parameters:**
| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `start` | `string` | — | — | Continuation token from previous response's `next` field. Omit on first call. |
| `limit` | `integer` | 300 | 300 | Max user IDs per page. (SDK docs confirm 300, not 1000.) |

**Response JSON:**
```json
{
  "userIds": ["Uxxxxxxxxxxxxxxxx", "Uxxxxxxxxxxxxxxxx"],
  "next": "optional-continuation-token"
}
```

- `next` is absent when there are no more pages.
- Continuation token expires in 24 hours.
- `userIds` contains user IDs in the **same Messaging-API namespace as webhook `source.userId`** — this is the key property that makes these IDs useful (unlike the OA-resolver IDs).

**Rate limits:** Not explicitly documented per-endpoint. LINE's general Messaging API rate limit is per-channel. Given ~252 real messaging contacts and the OA is likely followed by a few hundred people, a single paginated sweep will complete quickly with no retry logic needed at the pagination level.

### Fetcher Implementation

Add to `src/lib/line/client.ts`:

```typescript
// Pattern: matches fetchLineProfile (same file, same auth pattern)
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

  if (!response.ok) {
    const payload = asRecord(await response.json().catch(() => ({})));
    throw new Error(typeof payload.message === "string" ? payload.message : `LINE followers/ids returned HTTP ${response.status}`);
  }

  const payload = asRecord(await response.json());
  const userIds = Array.isArray(payload.userIds)
    ? payload.userIds.filter((id): id is string => typeof id === "string")
    : [];
  const next = typeof payload.next === "string" ? payload.next : undefined;
  return { userIds, next };
}
```

### Idempotent Upsert Pattern

The idempotent upsert for `line_contacts` must use `onConflictDoNothing` on the `lineUserId` unique index:

```typescript
// Existing pattern from recordLineWebhookPayload (data.ts:455-474)
await db
  .insert(schema.lineContacts)
  .values({ lineUserId, displayName, pictureUrl, statusMessage, ... })
  .onConflictDoNothing({ target: schema.lineContacts.lineUserId });
```

This is the analog of `recordLineWebhookPayload`'s `onConflictDoNothing` on `webhookEventId`. Re-running the re-anchor job creates no duplicates because the `lineUserId` unique index is the conflict target.

### getProfile Batching

`fetchLineProfile(userId)` makes one HTTP call per user. For ~800 followers, this is ~3 calls per second (safe under LINE's limits). The re-anchor route should process followers sequentially or in small batches (≤ 10 concurrent) using `Promise.all` with a batch slice. The existing `WiseClient` concurrency limiter is not applicable here (it's for Wise, not LINE). A simple sequential-with-error-ignore pattern is sufficient:

```typescript
for (const userId of allUserIds) {
  const profile = await fetchLineProfile(userId).catch(() => null);
  await upsertLineContact(db, { lineUserId: userId, ...profile });
  await ensureLineContactStudentLinkSuggestions(db, contactId, profile?.displayName);
}
```

The re-anchor is a one-time-ish operation run by an admin, not a hot path. Vercel function timeout (default 30s for non-marked routes; use `maxDuration = 60` for this route) is sufficient for ~300 followers processed sequentially.

---

## Research Target 5: Quarantine Flag Mechanism

### Recommendation: New Boolean Column `isPhantom` on `line_contact_student_links`

**Recommended over derived predicate.** Here is why:

**Derived predicate option:** `sourceKind = 'line_oa_resolver' AND contact has no thread AND contact lineUserId pattern does not overlap webhook namespace`. Problems:
1. The "no thread" condition depends on joining `line_threads` which changes if a phantom contact later gains a real message (unlikely but ambiguous).
2. The "namespace mismatch" check has no reliable automated test at query time — it would require calling the LINE API.
3. The derived predicate cannot survive the archive filter requirement: admins need to query "show me phantoms" which requires a stable, indexed predicate.

**Column option:** `isPhantom boolean NOT NULL DEFAULT false` on `line_contact_student_links`.

Benefits:
- Single-column index, no join needed.
- Set once when the ~520 resolver-sourced links are classified.
- Supports the D-03 archive filter via a simple `WHERE is_phantom = true` scope.
- Reversible: set `isPhantom = false` to un-quarantine.
- Drizzle migration: `npm run db:generate` → trim → `npm run db:migrate`.

**Migration implication:** A new nullable column would be added to `line_contact_student_links`. All existing rows default to `false`. A one-time data migration sets `isPhantom = true` for all rows where `sourceKind = 'line_oa_resolver'` (the ~520 phantom links). This data migration runs as part of the phase's Wave 0 or Wave 1.

**Drizzle schema addition:**

```typescript
// src/lib/db/schema.ts — add to lineContactStudentLinks columns
isPhantom: boolean("is_phantom").notNull().default(false),
```

**Additional index** (for archive filter performance):

```typescript
index("line_contact_student_links_phantom_idx").on(table.isPhantom, table.status)
```

### All Surfaces That Must Filter/Count Phantoms

Verified by code inspection:

| Surface | File | Change |
|---------|------|--------|
| `listLineLinkValidationTasks` (worklist) | `link-validation.ts:399-469` | Add `eq(schema.lineContactStudentLinks.isPhantom, false)` condition to active scopes; add `"phantom"` scope for archive filter |
| `getLineLinkValidationSummary` (counts) | `link-validation.ts:472-608` | Add `isPhantom = false` to all count aggregates |
| `assignLineLinkValidationTasks` (assignment) | `link-validation.ts:610-698` | Add `isPhantom = false` condition |
| `patchLineLinkValidationTaskStatus` (verify) | `link-validation.ts:700-738` | The `lineOaResolverSourceCondition()` guard already limits this to resolver rows — after quarantine, the new verify flow must NOT require this guard; remove it for the re-pointed flow |
| `listVerifiedLineStudentKeys` | `student-links.ts:677-689` | Add `eq(schema.lineContactStudentLinks.isPhantom, false)` |
| `hasVerifiedLineStudentLink` | `student-links.ts:691-694` | Inherits fix from above |
| `approveLineSchedulerReview` gate | `review-service.ts:438-441` | Calls `listVerifiedLineStudentKeys` → inherits fix |
| `studentLinkVisibilityForReview` badge (non-selected branch) | `utils.ts:124-135` | The non-selected branch reads `review.matchedStudentKeys.length` (snapshotted at review creation) — this is the stale path that IDENT-06 fixes; no additional phantom filter needed here once IDENT-06 is in |

**IDENT-05 acceptance:** After the migration sets `isPhantom = true` on the ~520 resolver rows, the worklist counts drop from ~520 to ~0 (the phantoms had no real matches), and the archive filter shows them under a "legacy / needs re-match" tab label.

---

## Research Target 6: Re-Link Recompute Trigger (IDENT-06)

### Recommendation: Inline-on-Verify

**Inline-on-verify**: When `patchLineLinkValidationTaskStatus` transitions a link to `verified`, the handler immediately calls `buildLineOperationalReviewPlan` for each `pending_review` row on that contact and updates them via `patchLineSchedulerOperationalPlan`.

**Rejected: separate backfill job.** A backfill job would need scheduling (cron or admin trigger), introduces eventual consistency, and complicates testing. The inline approach has a tighter, testable causal chain: verify → recompute → badge shows updated state immediately on next UI render.

**Implementation:** The existing `patchLineLinkValidationTaskStatus` function in `link-validation.ts:700-738` currently updates the link status and returns the updated DTO. After the update, add:

```typescript
// After .returning() and contact fetch
const pendingReviews = await db
  .select({ id: schema.lineSchedulerReviews.id, inboundMessageId: schema.lineSchedulerReviews.inboundMessageId })
  .from(schema.lineSchedulerReviews)
  .where(and(
    eq(schema.lineSchedulerReviews.contactId, row.contactId),
    eq(schema.lineSchedulerReviews.status, "pending_review"),
  ));

for (const review of pendingReviews) {
  const lineMessage = await getLineMessageForProcessing(db, review.inboundMessageId);
  if (!lineMessage) continue;
  const plan = await buildLineOperationalReviewPlan({
    db,
    contactId: row.contactId,
    messageText: lineMessage.text,
    classifierCategory: review.classifierCategory ?? "scheduling_change",
  });
  await patchLineSchedulerOperationalPlan(db, review.id, { ... });
}
```

**`studentLinkVisibilityForReview` badge fix** (`utils.ts:115-135`):

```typescript
// Current: non-selected branch reads stale snapshot
const verifiedCount = isSelected
  ? verifiedLinks(activeLinks).length
  : Math.max(review.matchedStudentKeys.length, review.verifiedStudentKeys.length);
// ↑ stale: matchedStudentKeys/verifiedStudentKeys are snapshotted at review creation

// Fix: the inline-on-verify recomputes review.matchedStudentKeys, so the non-selected
// branch will automatically reflect the updated values after the next review list fetch.
// No change needed to the badge logic itself — just ensure the review DTO is refreshed.
```

The badge fix is automatic once the inline recompute updates `matchedStudentKeys` and `verifiedStudentKeys` on the review row. The UI fetches reviews on mount; after the verify action + recompute, the next fetch returns the updated review.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Levenshtein edit distance | Custom implementation | Reuse `data.ts:1090` (extract to shared module) | Already in codebase, tested in practice |
| Unicode normalization | Custom Thai handling | `String.prototype.normalize("NFKC")` + existing `normalizeLineStudentCode` | Already handles Thai range `ก-๙` |
| LINE API client | New HTTP client | Extend `src/lib/line/client.ts` | Follows established auth/error pattern |
| Idempotent contact upsert | Manual `SELECT` then `INSERT` | `onConflictDoNothing` (Drizzle) | Same pattern as `recordLineWebhookPayload` |
| Eval test harness | Custom metrics pipeline | Vitest `describe`/`it` with fixture array | Matches existing scheduler eval pattern |

**Key insight:** The name-matching domain is deceptively simple-looking but has hard edge cases for Thai (no spaces, tone marks, nicknames). The existing `normalizeLineStudentCode` already handles the hardest cases (NFKC, Thai range). Building on it avoids re-inventing a tested solution.

---

## Common Pitfalls

### Pitfall 1: Namespace Confusion (Provider-Scoped User IDs)
**What goes wrong:** `getProfile(userId)` returns `404` for OA-resolver IDs because they are from a different provider namespace than Messaging-API webhook IDs. The SPEC confirms: 518 resolver IDs, 252 messaging IDs, 0 overlap.
**Why it happens:** LINE user IDs are scoped to the channel/provider, not globally unique. The OA Manager chat surface (`chat.line.biz`) uses a different ID namespace than the Messaging API webhook.
**How to avoid:** The re-anchor job uses `followers/ids` which returns Messaging-API namespace IDs (same as webhook `source.userId`). Never mix the two namespaces. The `isPhantom` quarantine flag makes this permanent.
**Warning signs:** `fetchLineProfile` returning `404` for a userId; a userId that never appears in `line_threads` or `line_messages`.

### Pitfall 2: Overwriting Existing Verified Links
**What goes wrong:** The name matcher's `onConflictDoNothing` on `(contactId, studentKey)` correctly prevents duplicate rows, but a verified link for the correct student won't be overwritten (desired). However, if the matcher generates a `suggested` link for the wrong student and an admin verifies it, that incorrect verification is permanent.
**Why it happens:** Precision-first calibration is the mitigation. A wrong suggestion that gets verified is a data error, not a code error.
**How to avoid:** Never lower precision thresholds below the calibrated minimums. The eval set measurement must confirm no false-positive suggestions before the matcher is deployed.
**Warning signs:** An admin verifying a link and noting "this doesn't match" — the `validationNote` field captures this.

### Pitfall 3: Drizzle `db:generate` Bloated Migrations
**What goes wrong:** `npm run db:generate` (drizzle-kit) emits a catch-up migration that includes all historical schema changes not previously captured, producing a massive file that takes minutes to apply.
**Why it happens:** Drizzle-kit compares current `schema.ts` against the snapshot in `drizzle/meta/`. If the snapshot drifts from what was actually run in production, the generated migration includes ghost changes.
**How to avoid:** Before running `db:generate`, verify the migration output contains ONLY the expected new column(s). Trim any catch-up changes from the generated file before running `db:migrate`. See memory note: [Drizzle snapshot drift](~/.claude/projects/-Users-kevinhsieh-Developer-Scheduling/memory/drizzle-snapshot-drift.md).
**Warning signs:** Generated migration file > 50 lines for a single-column addition.

### Pitfall 4: `patchLineLinkValidationTaskStatus` Guard Mismatch
**What goes wrong:** The current `patchLineLinkValidationTaskStatus` function has `and(..., lineOaResolverSourceCondition())` in its WHERE clause (`link-validation.ts:725`). After D-04, the widened worklist will surface message-content-sourced links, but the verify action still has this guard and will silently return `null` for them.
**Why it happens:** The guard was added to protect OA-resolver links from being verified via wrong flows.
**How to avoid:** The verify path for message-content links must use `patchLineContactStudentLinkStatus` (from `student-links.ts:646`) instead of `patchLineLinkValidationTaskStatus`. Or: create a new `patchLineContactStudentLinkStatus` wrapper that handles both source kinds and also triggers the IDENT-06 recompute.
**Warning signs:** Verify action returns 200 with a null task DTO; badge does not update after verify.

### Pitfall 5: Followers/IDs Continuation Token Expiry
**What goes wrong:** If the re-anchor job is interrupted mid-pagination (Vercel timeout, network error), resuming with a stale `next` cursor fails.
**Why it happens:** LINE continuation tokens expire in 24 hours.
**How to avoid:** The re-anchor job is designed as idempotent; it can restart from the beginning. Given ~300 followers max at 300 per page, the entire sweep likely completes in one request (1 page). Set `maxDuration = 60` on the route. No cursor persistence is needed.
**Warning signs:** `422` or `400` error from LINE API with a message about an invalid continuation token.

---

## Code Examples

### Exact Function Signatures (verified against HEAD)

**`ensureLineContactStudentLinkSuggestions`** — the primary extension point:
```typescript
// src/lib/line/student-links.ts:450-490
export async function ensureLineContactStudentLinkSuggestions(
  db: Database,
  contactId: string,
  labelOverride?: string | null,
): Promise<LineContactStudentLinkDto[]>
// Current behavior: resolves dotted codes from displayName/linkedStudentLabel
// Extension: add optional `names?: { studentName?: string; parentName?: string }` param
//            and call matchNamesToDirectory() in addition to resolveLineStudentCodeMatches()
```

**`studentLinkEvidence`** — add new source types:
```typescript
// src/lib/line/student-links.ts:418-436
function studentLinkEvidence(input: {
  source: "line_display_name" | "admin_helper_text" | "admin_search";
  // ↑ extend to add: "message_content" | "line_followers"
  parsedCodes?: ParsedLineStudentCode[];
  matchedCode?: string;
  matchedField?: LineStudentMatchType;
  label?: string | null;
  student: LineStudentDirectoryRow;
}): Record<string, unknown>
```

**`listCurrentLineStudents`** — the student directory source:
```typescript
// src/lib/line/student-links.ts:182-187
export async function listCurrentLineStudents(db: Database): Promise<LineStudentDirectoryRow[]>
// Returns from active credit-control snapshot; returns [] if no active snapshot
// LineStudentDirectoryRow: { wiseStudentId, studentKey, studentName, parentName, activated, hasFutureSessions, hasLivePackage }
```

**`processLineMessageForScheduler`** — call site to wire name-based matcher:
```typescript
// src/lib/line/review-service.ts:126-378
export async function processLineMessageForScheduler(
  db: Database,
  lineMessageId: string,
): Promise<{ review: LineSchedulerReviewDto | null; category?: string }>
// Lines 134-139: calls ensureLineContactStudentLinkSuggestions
// Extension: extract studentName/parentName from existing conversation's extractedState
//            and pass to the extended ensureLineContactStudentLinkSuggestions
```

**`lineOaResolverSourceCondition`** — the scope predicate to replace (D-04):
```typescript
// src/lib/line/link-validation.ts:243-245 (private)
function lineOaResolverSourceCondition() {
  return eq(schema.lineContactStudentLinks.sourceKind, "line_oa_resolver");
}
// Replace with: new predicate that includes "message_content" and "line_followers" sourceKind values
//               OR remove the sourceKind filter entirely and use isPhantom = false instead
```

**`patchLineLinkValidationTaskStatus`** — verify action with required guard fix:
```typescript
// src/lib/line/link-validation.ts:700-738
export async function patchLineLinkValidationTaskStatus(
  db: Database,
  input: {
    linkId: string;
    status: Extract<LineContactStudentLinkStatus, "verified" | "rejected">;
    note?: string | null;
    actor: LineLinkValidationActor;
  },
): Promise<LineLinkValidationTaskDto | null>
// PROBLEM: WHERE clause includes lineOaResolverSourceCondition() at line 725
//          This blocks verifying non-OA-resolver links via this function
// FIX: replace the sourceKind guard with isPhantom = false guard
//      OR extract to a base function and add IDENT-06 recompute call
```

**`buildLineOperationalReviewPlan`** — reuse for IDENT-06:
```typescript
// src/lib/line/operational.ts:584-686
export async function buildLineOperationalReviewPlan(input: {
  db: Database;
  contactId: string;
  messageText: string;
  classifierCategory: string;
}): Promise<LineOperationalReviewPlan>
```

**`patchLineSchedulerOperationalPlan`** — update review after recompute:
```typescript
// src/lib/line/data.ts:895-929
export async function patchLineSchedulerOperationalPlan(
  db: Database,
  reviewId: string,
  input: {
    intentType: LineOperationalIntentType;
    intentPayload: Record<string, unknown>;
    proposedDraft: string;
    matchedStudentKeys: string[];
    candidateSessions: Record<string, unknown>[];
    proposedWiseActions: Record<string, unknown>[];
    adminSelectedSessionIds: string[];
    writebackStatus: LineWritebackStatus;
  },
): Promise<LineSchedulerReviewDto | null>
```

**`studentLinkVisibilityForReview`** — badge function (currently stale, fixed by IDENT-06):
```typescript
// src/components/line-review/utils.ts:115-135
export function studentLinkVisibilityForReview({
  review,
  activeLinks,
  isSelected,
}: {
  review: Review;
  activeLinks: StudentLink[];
  isSelected: boolean;
}): { label: string; variant: "default" | "outline" | "destructive" }
// Non-selected branch reads review.matchedStudentKeys (stale snapshot)
// Fix: IDENT-06 recompute updates this field; badge becomes fresh on next review list fetch
```

**`fetchLineProfile`** — existing profile fetcher to batch-call for followers:
```typescript
// src/lib/line/client.ts:41-61
export async function fetchLineProfile(userId: string): Promise<LineProfile | null>
// Returns null on 404 (userId not found or wrong namespace)
// Throws on non-404 errors
// Pattern to follow for new fetchLineFollowerIds()
```

**`lineContactStudentLinks` schema** — confirmed columns relevant to this phase:
```typescript
// src/lib/db/schema.ts:1735-1772
export const lineContactStudentLinks = pgTable("line_contact_student_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id").notNull().references(() => lineContacts.id, { onDelete: "cascade" }),
  wiseStudentId: text("wise_student_id").notNull(),
  studentKey: text("student_key").notNull(),
  studentName: text("student_name").notNull(),
  parentName: text("parent_name").notNull().default(""),
  status: lineContactStudentLinkStatusEnum("status").notNull().default("suggested"),
  confidence: doublePrecision("confidence"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  sourceKind: text("source_kind"),            // "line_oa_resolver" | "message_content" | "line_followers" | null
  sourceRunId: uuid("source_run_id"),
  // ... validation assignment fields ...
  // NEW: isPhantom: boolean("is_phantom").notNull().default(false)
}, (table) => [
  uniqueIndex("line_contact_student_links_contact_student_idx").on(table.contactId, table.studentKey),
  // NOTE: existing partial indexes filter on sourceKind = 'line_oa_resolver'
  //       These remain unchanged; new indexes added for isPhantom
]);
```

---

## DB Workflow Note (Drizzle Migrate, NOT Push)

**Confirmed workflow:**
```bash
# 1. Edit src/lib/db/schema.ts — add isPhantom column
# 2. Generate migration
npm run db:generate
# → creates drizzle/XXXX_migration_name.sql
# 3. REVIEW the generated SQL — it should contain ONLY:
#    ALTER TABLE "line_contact_student_links" ADD COLUMN "is_phantom" boolean NOT NULL DEFAULT false;
#    CREATE INDEX ... ON "line_contact_student_links" ("is_phantom", "status");
#    If it contains anything else, trim the file.
# 4. Apply migration
DATABASE_URL=... npm run db:migrate
```

**`drizzle.config.ts`** (confirmed):
```typescript
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

**Package.json scripts** (confirmed):
- `npm run db:generate` → `drizzle-kit generate`
- `npm run db:migrate` → `drizzle-kit migrate`

The `db:push` command is intentionally NOT present in this codebase. Do not add it.

---

## Runtime State Inventory

> Rename/refactor inventory — not directly applicable (this is not a rename phase).
> However, the quarantine classification is a one-time data migration on existing rows.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | ~520 `line_contact_student_links` rows with `sourceKind='line_oa_resolver'` — existing phantom links that must be flagged | One-time `UPDATE line_contact_student_links SET is_phantom = true WHERE source_kind = 'line_oa_resolver'` — part of Wave 0 or Wave 1 data migration in PLAN |
| Live service config | None | — |
| OS-registered state | None | — |
| Secrets/env vars | `LINE_CHANNEL_ACCESS_TOKEN` already present (required for `followers/ids`); no new env vars needed | None — verify token is set in Vercel env |
| Build artifacts | None | — |

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All server-side code | ✓ | Runtime (Vercel) | — |
| Neon Postgres | All DB operations | ✓ | Production (ap-southeast-1) | — |
| `LINE_CHANNEL_ACCESS_TOKEN` | `fetchLineFollowerIds`, `fetchLineProfile` | ✓ (production) | — | Feature gated by `lineSchedulerEnabled()` |
| `LINE_CHANNEL_SECRET` | Webhook signature | ✓ (production) | — | — |
| Docker (for integration tests) | `testcontainers` Postgres | ✓ (dev machine) | 24.x | Skip integration tests in CI if unavailable |

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `^4.1.2` — two projects: `unit` (node env) and `integration` (forks, serial) |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `npx vitest run --project unit src/lib/line/__tests__/name-matcher.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IDENT-01 | Name-based matcher creates `suggested` links from AI-extracted names | unit | `npx vitest run --project unit src/lib/line/__tests__/name-matcher.test.ts` | ❌ Wave 0 |
| IDENT-01 | Eval: matcher precision ≥ X on labeled set | unit (eval fixture) | `npx vitest run --project unit src/lib/line/__tests__/name-matcher.eval.test.ts` | ❌ Wave 0 |
| IDENT-02 | No code path sets `status="verified"` from content matching | unit | `npx vitest run --project unit src/lib/line/__tests__/student-links.test.ts` | ✅ (extend) |
| IDENT-02 | `listVerifiedLineStudentKeys` returns [] for contact with only `suggested` | unit | same | ✅ (extend) |
| IDENT-03 | `fetchLineFollowerIds` paginates via `next` cursor, handles missing `next` | unit | `npx vitest run --project unit src/lib/line/__tests__/client.test.ts` | ✅ (extend) |
| IDENT-03 | Re-anchor route is idempotent — re-run creates no duplicate contacts | unit | `npx vitest run --project unit src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts` | ❌ Wave 0 |
| IDENT-05 | `listLineLinkValidationTasks` excludes phantom rows from active scopes | unit | `npx vitest run --project unit src/lib/line/__tests__/link-validation.test.ts` | ✅ (extend) |
| IDENT-06 | Verifying a link triggers recompute of pending reviews | unit | `npx vitest run --project unit src/lib/line/__tests__/link-validation.test.ts` | ✅ (extend) |
| IDENT-06 | `studentLinkVisibilityForReview` reflects updated `matchedStudentKeys` | unit | `npx vitest run --project unit src/components/line-review/__tests__/line-review-workspace.test.ts` | ✅ (extend) |

### Sampling Rate
- **Per task commit:** `npx vitest run --project unit src/lib/line/__tests__/`
- **Per wave merge:** `npm test` (all 130+ suites)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/lib/line/__tests__/name-matcher.test.ts` — unit tests for all three tiers of the matcher
- [ ] `src/lib/line/__tests__/name-matcher.eval.test.ts` — labeled eval set with precision/recall assertions
- [ ] `src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts` — idempotency and auth tests

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Auth.js session + `auth()` check on new re-anchor route |
| V3 Session Management | no | No new session management |
| V4 Access Control | yes | Admin-only re-anchor route (session-auth, not public); `lineSchedulerEnabled()` gate |
| V5 Input Validation | yes | Zod schema for re-anchor route body (empty body; params from LINE API only); Zod validation of `followers/ids` response shape |
| V6 Cryptography | no | No new cryptographic operations; LINE HMAC signature verification already in place for webhook |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Follower ID enumeration via re-anchor route | Information Disclosure | Admin session required; route not public; LINE OA follower list is not PII-sensitive |
| Wrong-student link auto-verified | Tampering | No auto-verify path exists; `suggested` only from content; admin verify required |
| PII in LINE display names stored in `evidence` JSONB | Information Disclosure | Already present in production DB; no change to storage scope; consistent with existing contact profile storage |
| `followers/ids` bulk harvest for unenrolled followers | Information Disclosure | `getProfile` only fetches the profile LINE already exposes; no additional PII beyond what webhook ingest already captures per-message |
| Phantom re-match: admin un-quarantines wrong contact | Tampering | Archive filter is visible-but-excluded; admin must explicitly flip `isPhantom = false`; no automated path does this |
| `LINE_CHANNEL_ACCESS_TOKEN` leak via error messages | Information Disclosure | `lineAccessToken()` throws on missing token; never logged; consistent with `fetchLineProfile` pattern |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `followers/ids` max limit is 300 per page (per SDK docs) | Research Target 4 | If actual limit is higher, pagination is inefficient but correct; re-anchor still completes |
| A2 | The production OA has ~300 total followers (estimate), fitting in one or two pages | Research Target 4 | If >300 followers, multi-page loop is needed (handled by the pagination logic either way) |
| A3 | AI scheduler runs have happened for most of the 252 messaging contacts, making `extractedState.studentName` available | Research Target 1 | If not, the name-matcher has fewer inputs; the display-name code matcher remains the fallback |
| A4 | The `levenshtein` function at `data.ts:1090` is production-grade for our use (up to ~30 character strings) | Research Target 1 | The function is O(m*n); Thai names are short; no performance risk |

---

## Open Questions (RESOLVED)

> Both questions were resolved during Phase 11 planning (2026-06-06). The decisions below are implemented in plans 11-02/11-03 (name source) and 11-05 (assignment).

1. **Where exactly do AI-extracted names flow per message?** — **RESOLVED**
   - What we know: `aiSchedulerConversations.extractedState` accumulates them; `review_service.ts:305` shows `assistantResult.state.studentName` saved to the conversation.
   - What's unclear: For a contact with no prior AI scheduler turn (first message), `extractedState` is empty. The matcher can still use the display name (existing path) but has no name signal from the message text itself.
   - Recommendation: The name-matcher should also accept the current message's `classifierPayload` (which has `summary` text but not extracted names) as a fallback signal. Alternatively, run a lightweight extraction step in `processLineMessageForScheduler` before the matcher. This decision can be deferred to Wave 1 planning — the eval set will reveal how many contacts have no `extractedState` at message time.
   - **RESOLVED (planning):** Plan 11-03 reads `studentName`/`parentName` from the thread's `aiSchedulerConversations.extractedState` (via the `db` already in scope in `processLineMessageForScheduler`). Contacts with no prior AI turn fall back to the **existing display-name code matcher** (no regression — the name matcher simply yields no candidates when no names are present). Plan 11-02's eval set quantifies the no-name coverage gap so it is measured, not assumed. No new extraction step is added this phase (classifier change is out of scope per SPEC).

2. **Round-robin assignment for widened worklist** — **RESOLVED**
   - What we know: `assignLineLinkValidationTasks` assigns within a `runId` scope and uses `lineOaResolverSourceCondition()`.
   - What's unclear: Should message-content-sourced suggestions also be assignable for validation, or is the current ad-hoc "assigned to whoever opens it" workflow sufficient given small volume?
   - Recommendation: Leave assignment optional for Phase 11; the worklist without assignment is sufficient for the ≥80% coverage target. Remove the assignment requirement from D-04's acceptance scope.
   - **RESOLVED (planning):** Plan 11-05 leaves validation assignment **optional** — message-content/follower links are surfaced in the worklist without `runId`-scoped round-robin assignment; the unassigned worklist meets the ≥80% coverage goal. Assignment for the widened scope is deferred (revisit only if volume warrants, per D-04).

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| OA-resolver browser extension (scrapes chat.line.biz) | Webhook-side contact creation + `followers/ids` bulk seeding | Correct namespace, no browser extension required |
| Dotted enrollment codes in display name → matcher | AI-extracted names from message text → deterministic matcher | Covers real parents who write naturally, not admins who set up formatted labels |
| `lineOaResolverSourceCondition()` scope on all validation queries | `isPhantom` boolean column + widened scope | Clean separation, reversible, supports archive filter |

---

## Sources

### Primary (HIGH confidence)
- Codebase HEAD (`src/lib/line/student-links.ts`, `client.ts`, `link-validation.ts`, `review-service.ts`, `operational.ts`, `data.ts`, `src/lib/db/schema.ts`, `src/components/line-review/utils.ts`) — verified function signatures, exact line numbers, exact column names
- `vitest.config.ts` — confirmed test project structure (unit/integration split, node env)
- `drizzle.config.ts` + `package.json` scripts — confirmed generate+migrate workflow, no push
- `11-SPEC.md`, `11-CONTEXT.md` — locked requirements and decisions

### Secondary (MEDIUM confidence)
- LINE Bot SDK (Python) raw docs — `get_followers` parameters: `start` (cursor), `limit` (default 300, max 300), response `{ userIds: string[], next?: string }`
- LINE Bot SDK (Node.js) TypeScript source — `GetFollowersResponse` type confirmed `userIds` + `next` fields
- LINE Developers official docs — confirmed verified/premium requirement for `followers/ids`

### Tertiary (LOW confidence)
- Web search results re: rate limits — no per-endpoint rate limit documentation found for `followers/ids`; general Messaging API rate limits apply [ASSUMED]
