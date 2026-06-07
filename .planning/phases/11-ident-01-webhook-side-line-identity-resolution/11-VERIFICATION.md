---
phase: 11-ident-01-webhook-side-line-identity-resolution
verified: 2026-06-07T00:00:00Z
status: human_needed
score: 6/6 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Verify a suggested link in the Mapping Validation UI and confirm the badge flips to 'Verified student' without a manual recompute"
    expected: "After clicking Verify on a message_content-sourced suggested link, the review queue badge immediately reads 'Verified student' and the review's matchedStudentKeys/writebackStatus are updated in the DB"
    why_human: "IDENT-06 inline recompute fires on patchLineLinkValidationTaskStatus server-side; the badge flip requires a real pending review + verified link in production. Cannot exercise without mutating production state."
  - test: "Click the 'Re-anchor followers' button in Mapping Validation and confirm the route returns a non-zero upsertedContacts count"
    expected: "The button triggers POST /api/line/contacts/followers-reanchor, fetches LINE follower IDs, upserts correct-namespace contacts, and displays 'Re-anchor complete: N contacts upserted' in the UI"
    why_human: "Requires a live LINE access token and calls the real LINE /v2/bot/followers/ids API; cannot run programmatically without production credentials."
  - test: "Navigate to the Mapping Validation panel, select the 'Legacy / needs re-match' scope tab, and confirm phantom rows are visible (not HTTP 400)"
    expected: "The tab loads and shows the 696 quarantined OA-resolver rows; active scopes ('My', 'All', 'Unassigned') show only real-contact suggestions"
    why_human: "WR-01 fix was verified by code inspection and a route test, but the admin-facing tab interaction and row rendering have not been exercised end-to-end in the production UI."
---

# Phase 11: IDENT-01 Webhook-Side LINE Identity Resolution Verification Report

**Phase Goal:** Link the parents who actually message the LINE OA (identified by the Messaging-API webhook `source.userId`) to Wise students, so downstream scheduling automation has trustworthy identity. Target: >=80% of active messaging contacts have a verified or parent-confirmed student link after a verification pass, and every new scheduling message yields a student-link suggestion or routes to human verification (fail-closed).

**Verified:** 2026-06-07
**Status:** human_needed
**Re-verification:** No — initial verification

## Operational Metric Note

The >=80% verified-link coverage target is an **operational metric**, not a code gate. This phase delivers the tooling; admin verification drives the number up. The post-quarantine baseline measured at 1.6% (3/187 real active messaging contacts verified) is correct and expected — the 656 wrong-namespace OA-resolver phantom "verified" rows were quarantined, revealing the true unverified baseline. This does NOT constitute a code failure. Each IDENT requirement is judged against its CODE/BEHAVIOR acceptance criteria below.

---

## Goal Achievement

### Observable Truths (IDENT-01..06)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| IDENT-01 | A name-based matcher creates `suggested` links from AI-extracted studentName/parentName on real messaging contacts | VERIFIED | `matchNamesToDirectory` exists in `src/lib/line/name-matcher.ts` (pure TS, no DB imports, returns `NameMatchCandidate[]` with no status field); wired into `ensureLineContactStudentLinkSuggestions` via optional `names` param; wired into `processLineMessageForScheduler` via `extractedState` read at lines 138-162 of `review-service.ts`. Eval gate: precision 0.905 (>= 0.90), recall 1.0 (>= 0.60) per `name-matcher.eval.test.ts`. |
| IDENT-02 | No code path creates `status="verified"` from content matching alone; a contact with only `suggested` links is treated as unverified | VERIFIED | `name-matcher.ts` has zero DB imports (confirmed by inspection). Content-match insert at `student-links.ts:508` hardcodes `status: "suggested"` with comment "ALWAYS suggested — NEVER verified from content (IDENT-02)". `status="verified"` is only written in: `createVerifiedLineContactStudentLink` (admin search action) and `patchLineContactStudentLinkStatus`/`patchLineLinkValidationTaskStatus` (admin review). `listVerifiedLineStudentKeys` filters `isPhantom=false` AND `status="verified"`. `approveLineSchedulerReview` gates on `listVerifiedLineStudentKeys` — a contact with only `suggested` links returns an empty array and is treated as unverified. |
| IDENT-03 | A one-time followers/ids re-anchor job creates correct-namespace contacts; it is idempotent (re-run adds no duplicates) | VERIFIED | `fetchLineFollowerIds` in `src/lib/line/client.ts:68` calls `/v2/bot/followers/ids` with cursor-based pagination (limit=300, `next` cursor loop). `runLineFollowersReanchor` in `student-links.ts:753` paginates to collect all follower IDs, upserts contacts via `onConflictDoNothing({ target: schema.lineContacts.lineUserId })` (idempotent). Route `POST /api/line/contacts/followers-reanchor` is admin auth-gated (401 on no session). UI button in `mapping-validation-workspace.tsx` bound to the route with spinner + success message reading real response fields (`upsertedContacts`, `suggestionsCreated`). |
| IDENT-04 | The Mapping Validation worklist surfaces `suggested` links on real contacts and allows verifying them; phantom scope is reachable via UI | VERIFIED | `patchLineLinkValidationTaskStatus` WHERE clause uses `eq(isPhantom, false)` (not `sourceKind`), allowing `message_content` suggested links to be verified. Active worklist queries use `realContactCondition()` (`isPhantom=false`). Route `src/app/api/line/contacts/link-validation/route.ts` derives `scopeSchema = z.enum(LINE_LINK_VALIDATION_SCOPES)` from the shared const (which includes `"phantom"`), fixing WR-01. Route test at line 75 exercises `scope=phantom` and asserts HTTP 200. `link-validation-panel.tsx` SCOPES array includes `{ value: "phantom", label: "Legacy / needs re-match" }`. Component-local `LineLinkValidationScope` in `types.ts:263` includes `"phantom"`. |
| IDENT-05 | Phantom contacts/links are flagged and excluded from validation worklists, verified-count summaries, and action-readiness checks; zero rows deleted | VERIFIED | `isPhantom: boolean("is_phantom").notNull().default(false)` at `schema.ts:1747`; `index("line_contact_student_links_phantom_idx").on(table.isPhantom, table.status)` at `schema.ts:1760`. Migration `drizzle/0040_nifty_mercury.sql` contains exactly 2 DDL statements (ALTER TABLE + CREATE INDEX). Production migration applied; 696 OA-resolver rows quarantined with `is_phantom=true` (documented in `11-01-SUMMARY.md`). All 5 active query surfaces replaced `lineOaResolverSourceCondition()` with `realContactCondition()`. `getLineLinkValidationSummary` count aggregates at `link-validation.ts:499` use `realContactCondition()`. `listVerifiedLineStudentKeys` at `student-links.ts:723` filters `isPhantom=false`. Zero rows deleted — quarantine is flag-only. |
| IDENT-06 | Verifying a link refreshes the contact's pending review badge + plan without a manual recompute | VERIFIED | `patchLineLinkValidationTaskStatus` at `link-validation.ts:749-794`: when `input.status === "verified"`, queries all `pending_review` rows for the contact, calls `buildLineOperationalReviewPlan` per row, calls `patchLineSchedulerOperationalPlan` updating `matchedStudentKeys` and `writebackStatus`. Each step is fail-isolated with `.catch(() => null)` / `.catch(() => undefined)`. 4 TDD tests cover: verify triggers recompute, reject does not, error isolation continues loop, missing message text skips review. |

**Score:** 6/6 truths verified

---

### Required Artifacts

| Artifact | Provides | Status | Details |
|----------|----------|--------|---------|
| `src/lib/line/name-matcher.ts` | Pure deterministic name matcher (IDENT-01/02) | VERIFIED | 269 lines; 6 named exports; no DB imports; no `status` field in return type; eval gate: precision 0.905 / recall 1.0 |
| `src/lib/line/__tests__/name-matcher.test.ts` | 41 unit tests covering all 3 tiers + fail-closed cases | VERIFIED | File present; 41 tests per SUMMARY |
| `src/lib/line/__tests__/name-matcher.eval.test.ts` | Distractor-rich eval fixture with precision/recall gate | VERIFIED | File present; 26-student directory (3.33x distractor ratio); 4 eval tests |
| `src/lib/line/student-links.ts` | Names param in `ensureLineContactStudentLinkSuggestions`; `isPhantom` filter in `listVerifiedLineStudentKeys`; `runLineFollowersReanchor` | VERIFIED | `matchNamesToDirectory` imported (line 4); `status: "suggested"` hardcoded (line 508); `isPhantom=false` filter (line 723); `runLineFollowersReanchor` exported (line 753) |
| `src/lib/line/review-service.ts` | `processLineMessageForScheduler` wired with `extractedNames` (IDENT-01) | VERIFIED | `extractedState` read (lines 138-155); `extractedNames` passed as 4th arg (line 162) |
| `src/lib/line/client.ts` | `fetchLineFollowerIds` with cursor pagination (IDENT-03) | VERIFIED | Function at line 68; `/v2/bot/followers/ids` URL; `limit=300`; `next` cursor pagination |
| `src/app/api/line/contacts/followers-reanchor/route.ts` | Admin-authenticated POST route for re-anchor (IDENT-03) | VERIFIED | Auth gate (401); `maxDuration=60`; `runLineFollowersReanchor` called; 4-step error handling |
| `src/lib/line/link-validation.ts` | Widened worklist + phantom scope + IDENT-06 inline recompute | VERIFIED | `LINE_LINK_VALIDATION_SCOPES` const (line 12) includes `"phantom"`; `realContactCondition()` (line 247); phantom archive branch (lines 420-431); inline recompute block (lines 749-794) |
| `src/app/api/line/contacts/link-validation/route.ts` | Route Zod schema accepts `"phantom"` scope (WR-01 fix) | VERIFIED | `scopeSchema = z.enum(LINE_LINK_VALIDATION_SCOPES)` derived from shared const; `"phantom"` accepted |
| `src/components/line-review/mapping-validation-workspace.tsx` | Re-anchor followers button (IDENT-03 UI) | VERIFIED | `setBusy("reanchor")`; POST to `/api/line/contacts/followers-reanchor`; success message reads `upsertedContacts`/`suggestionsCreated` |
| `src/components/line-review/link-validation-panel.tsx` | Phantom scope tab (IDENT-04/05 UI) | VERIFIED | `{ value: "phantom", label: "Legacy / needs re-match" }` in SCOPES array (line 36) |
| `src/components/line-review/types.ts` | Component-local `LineLinkValidationScope` includes `"phantom"` | VERIFIED | Line 263: `"my" \| "all" \| "unassigned" \| "verified" \| "rejected" \| "phantom"` |
| `src/lib/db/schema.ts` | `isPhantom` column + phantom index on `lineContactStudentLinks` | VERIFIED | Column at line 1747; index at line 1760 |
| `drizzle/0040_nifty_mercury.sql` | Migration: 2 DDL statements only | VERIFIED | `ALTER TABLE ... ADD COLUMN "is_phantom" boolean DEFAULT false NOT NULL` + `CREATE INDEX ... USING btree ("is_phantom","status")` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `name-matcher.ts::matchNamesToDirectory` | `student-links.ts::ensureLineContactStudentLinkSuggestions` | import + optional 4th `names` param | WIRED | `student-links.ts:4` imports; block at lines 495-520 calls `matchNamesToDirectory` |
| `student-links.ts::ensureLineContactStudentLinkSuggestions` | `review-service.ts::processLineMessageForScheduler` | import + `extractedNames` arg | WIRED | `review-service.ts:37` imports; line 158-163 calls with `extractedNames` |
| `student-links.ts::runLineFollowersReanchor` | `route.ts::followers-reanchor` | import + POST handler | WIRED | Route imports `runLineFollowersReanchor`; calls it on POST |
| `client.ts::fetchLineFollowerIds` | `student-links.ts::runLineFollowersReanchor` | import + cursor loop | WIRED | `student-links.ts:5` imports; pagination loop at lines 756-761 |
| `link-validation.ts::LINE_LINK_VALIDATION_SCOPES` | `link-validation/route.ts::scopeSchema` | `z.enum(LINE_LINK_VALIDATION_SCOPES)` | WIRED | Route derives schema from shared const — WR-01 fix confirmed in commit `3cbbea9` |
| `link-validation.ts::patchLineLinkValidationTaskStatus` (verify path) | `operational.ts::buildLineOperationalReviewPlan` + `data.ts::patchLineSchedulerOperationalPlan` | inline block on `status === "verified"` | WIRED | Both imported at `link-validation.ts:5-6`; block at lines 749-794 |
| `schema.ts::isPhantom` | `link-validation.ts::realContactCondition()` | `eq(schema.lineContactStudentLinks.isPhantom, false)` | WIRED | `realContactCondition()` at line 247-249; used in 5 active query surfaces |
| `schema.ts::isPhantom` | `student-links.ts::listVerifiedLineStudentKeys` | `eq(isPhantom, false)` in WHERE | WIRED | Line 723 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `ensureLineContactStudentLinkSuggestions` | `nameCandidates` | `matchNamesToDirectory(names, students)` where `students` comes from `listCurrentLineStudents(db)` | Yes — DB query against credit-control snapshot | FLOWING |
| `listVerifiedLineStudentKeys` | verified keys | DB query `WHERE status='verified' AND isPhantom=false` | Yes | FLOWING |
| `runLineFollowersReanchor` | `allUserIds` | LINE API `/v2/bot/followers/ids` paginated | Yes — external API | FLOWING (requires live credentials) |
| `listLineLinkValidationTasks` (phantom scope) | phantom rows | DB query `WHERE isPhantom=true` | Yes — DB query | FLOWING |
| `getLineLinkValidationSummary` | count aggregates | DB aggregates `WHERE isPhantom=false` | Yes — DB query | FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED for live API calls (LINE followers fetch, production verify flow). These require external credentials and mutation of production state. Routed to human verification. The route handler logic, DB query logic, and idempotency behavior are covered by unit/integration tests.

### Requirements Coverage (IDENT-01..06)

| Requirement | Plans | Description | Status | Evidence |
|-------------|-------|-------------|--------|----------|
| IDENT-01 | 11-02, 11-03 | Content-based name-matcher creating `suggested` links | SATISFIED | `name-matcher.ts` + wiring in `student-links.ts` + `review-service.ts`; eval precision 0.905 / recall 1.0 |
| IDENT-02 | 11-02, 11-03 | Fail-closed: no content path creates `verified` | SATISFIED | `status: "suggested"` hardcoded in content path; only explicit admin functions write `verified`; `listVerifiedLineStudentKeys` and approval gate use phantom-filtered verified query |
| IDENT-03 | 11-04, 11-07 | followers/ids re-anchor job + admin UI | SATISFIED | `fetchLineFollowerIds` + `runLineFollowersReanchor` + route + re-anchor button in workspace |
| IDENT-04 | 11-05, 11-07 | Mapping Validation worklist surfaces real-contact suggestions; phantom scope reachable | SATISFIED | `realContactCondition()` across all active scopes; `patchLineLinkValidationTaskStatus` uses `isPhantom=false` guard; route accepts `"phantom"`; panel SCOPES array includes it |
| IDENT-05 | 11-01, 11-05 | Phantom quarantine: flagged, excluded, zero rows deleted | SATISFIED | `isPhantom` column + index in schema; migration applied; 696 rows quarantined; `realContactCondition()` excludes phantoms from all active surfaces; phantom archive scope for visibility |
| IDENT-06 | 11-06 | Review re-link refresh on verify | SATISFIED | Inline recompute block in `patchLineLinkValidationTaskStatus`; updates `matchedStudentKeys` + `writebackStatus`; fail-isolated; 4 TDD tests |

### Anti-Patterns Found

No anti-patterns detected. Scanned:
- `src/lib/line/name-matcher.ts`
- `src/lib/line/student-links.ts`
- `src/lib/line/link-validation.ts`
- `src/lib/line/review-service.ts`
- `src/lib/line/client.ts`
- `src/app/api/line/contacts/followers-reanchor/route.ts`
- `src/components/line-review/mapping-validation-workspace.tsx`
- `src/components/line-review/link-validation-panel.tsx`
- `src/components/line-review/types.ts`

Zero TODO/FIXME/HACK/PLACEHOLDER comments in any of the above. No stub returns (empty arrays, null returns) on data paths. No hardcoded empty props.

### WR-01 Code Review Finding: RESOLVED

The code review (`11-REVIEW.md`) found 1 warning: the link-validation API route's Zod enum did not include `"phantom"`, making the phantom archive tab return HTTP 400. This was fixed in commit `3cbbea9`: the route now uses `z.enum(LINE_LINK_VALIDATION_SCOPES)` derived from the shared const, and a route test exercises `scope=phantom` at line 75 of the route test file.

### Human Verification Required

Three items need admin confirmation in the production UI. All code paths are test-covered and inspected clean; these require production mutations or a live LINE API call.

#### 1. Live verify-link + badge flip (IDENT-06)

**Test:** In the Mapping Validation panel, select a real contact with a `suggested` link (message_content source), click Verify.
**Expected:** The review queue badge immediately shows "Verified student". In the DB, `matchedStudentKeys` is populated and `writebackStatus` reflects the new identity.
**Why human:** `patchLineLinkValidationTaskStatus` triggers the recompute server-side on the `verified` status transition. Exercising this path requires a real pending review and a real suggested link in production, and writes a verified status to production data.

#### 2. Re-anchor followers button (IDENT-03)

**Test:** In the Mapping Validation workspace, click "Re-anchor followers". Observe the spinner and the resulting success message.
**Expected:** The button calls `POST /api/line/contacts/followers-reanchor`, which pages through the LINE `/v2/bot/followers/ids` API, upserts correct-namespace contacts, and returns a non-zero `upsertedContacts` count displayed in the UI.
**Why human:** Requires a live LINE access token and calls the real LINE Messaging API. The idempotency is verified by code inspection (`onConflictDoNothing`), but the actual follower count and overlap with the messaging namespace must be confirmed against production.

#### 3. Phantom archive scope tab (IDENT-04/05)

**Test:** In the Mapping Validation panel, click the "Legacy / needs re-match" scope tab.
**Expected:** The tab renders 696 phantom rows (the quarantined OA-resolver links) without an error, and the active scopes (My, All) show only real-contact suggestions (not phantom rows).
**Why human:** WR-01 is confirmed fixed by code inspection and route test, but the admin-facing scope tab rendering (including the actual phantom row display and the correct exclusion from active scopes) has not been walked through in the production UI.

### Gaps Summary

No gaps blocking goal achievement. All 6 IDENT requirements have code-verified implementation with test coverage. The 3 human verification items are confirmatory (live production behavior) not corrective — the code paths they exercise are implemented and tested.

---

_Verified: 2026-06-07_
_Verifier: Claude (gsd-verifier)_
