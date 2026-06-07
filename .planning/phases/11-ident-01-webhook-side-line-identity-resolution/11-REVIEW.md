---
phase: 11-ident-01-webhook-side-line-identity-resolution
reviewed: 2026-06-07T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - src/lib/line/name-matcher.ts
  - src/lib/line/student-links.ts
  - src/lib/line/client.ts
  - src/lib/line/review-service.ts
  - src/lib/line/link-validation.ts
  - src/app/api/line/contacts/followers-reanchor/route.ts
  - src/components/line-review/mapping-validation-workspace.tsx
  - src/components/line-review/link-validation-panel.tsx
  - src/components/line-review/types.ts
  - src/lib/db/schema.ts
  - drizzle/0040_nifty_mercury.sql
  - src/lib/line/__tests__/name-matcher.test.ts
  - src/lib/line/__tests__/name-matcher.eval.test.ts
  - src/lib/line/__tests__/student-links.test.ts
  - src/lib/line/__tests__/client.test.ts
  - src/lib/line/__tests__/link-validation.test.ts
  - src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts
findings:
  critical: 0
  warning: 1
  info: 2
  total: 3
status: issues_found
---

# Phase 11: Code Review Report

**Reviewed:** 2026-06-07
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Phase 11 wires a deterministic name matcher into the LINE student-link suggestion
pipeline, adds an `isPhantom` quarantine column, a followers re-anchor job + admin
route, widens the mapping-validation worklist to include a phantom archive scope, and
adds inline re-link recompute on verify.

The implementation is strong on the non-negotiable safety rules:

- **Fail-closed is honored.** `matchNamesToDirectory` is pure, has no DB imports, and
  returns `NameMatchCandidate[]` with no `status` field (asserted by tests). The
  content-match insert path in `ensureLineContactStudentLinkSuggestions` hardcodes
  `status: "suggested"` (IDENT-02) — content matching can never produce `verified`.
- **The `isPhantom` filter is applied consistently.** `listVerifiedLineStudentKeys`
  (the availability-feeding read), `patchLineLinkValidationTaskStatus`, the active
  worklist scopes, and every aggregate in `getLineLinkValidationSummary` (totals,
  reviewer breakdown, recent activity) all carry `isPhantom = false`. The new `phantom`
  scope correctly inverts this to `isPhantom = true` with no status constraint (D-03).
- **The re-anchor job is idempotent** (`onConflictDoNothing` on the `lineUserId` unique
  index for contacts and on `(contactId, studentKey)` for links).
- **The inline recompute is fail-isolated** — each `buildLineOperationalReviewPlan` and
  `patchLineSchedulerOperationalPlan` call has a per-row `.catch()`, and message-text
  guards skip cleanly. Covered by a "continues loop if one throws" test.
- **The followers-reanchor route follows the 4-step contract** (auth→401; body
  steps correctly skipped since there is no body; business logic in try/catch→500).
- **`db` is threaded correctly** in `review-service.ts` — `extractedState` is read via
  the `db` param already in scope, never via `getDb()` inside a lib function.

One genuine functional gap was found: the new `phantom` worklist scope is exposed in the
UI and accepted by the library, but the API route's Zod `scopeSchema` was not updated to
include it, so the archive tab returns HTTP 400 and is unreachable.

## Warnings

### WR-01: `phantom` scope is unreachable — route Zod schema rejects it with HTTP 400

**File:** `src/app/api/line/contacts/link-validation/route.ts:10`

**Issue:** This phase adds `"phantom"` to `LineLinkValidationScope`
(`link-validation.ts:12`), branches `listLineLinkValidationTasks` on it
(`link-validation.ts:421-430`), and surfaces it in the UI dropdown as
`{ value: "phantom", label: "Legacy / needs re-match" }`
(`link-validation-panel.tsx:36`). But the GET route that backs that dropdown validates
the `scope` query param against a stale enum that does **not** include `phantom`:

```ts
const scopeSchema = z.enum(["my", "all", "unassigned", "verified", "rejected"]);
```

When an admin clicks the "Legacy / needs re-match" tab, the client issues
`GET /api/line/contacts/link-validation?scope=phantom`. `scopeSchema.safeParse("phantom")`
fails, and the handler returns `400 "Invalid scope"` (route.ts:29-32). The phantom
archive — the entire admin-facing purpose of the `isPhantom` quarantine and the D-03
archive filter — cannot be viewed through the UI.

This slipped through because `link-validation/route.ts` was not part of this phase's
changed files, and its route test (`route.test.ts`) only feeds `scope=my`/`scope=all`
and asserts that an *invalid* scope (`scope=mine`) returns 400. No test exercises
`scope=phantom` end-to-end, so the library-level phantom tests pass while the user-facing
path is broken.

**Fix:** Add `"phantom"` to the route's enum so it matches the type union and the UI:

```ts
const scopeSchema = z.enum(["my", "all", "unassigned", "verified", "rejected", "phantom"]);
```

Consider deriving the route enum from the exported `LineLinkValidationScope` union (or
adding a `scope=phantom` case to `route.test.ts`) so the schema and the type can never
drift apart again.

## Info

### IN-01: Worklist scope semantically widened from OA-resolver-only to all non-phantom links

**File:** `src/lib/line/link-validation.ts:245-249`

**Issue:** The active-scope predicate changed from
`lineOaResolverSourceCondition()` (`sourceKind = "line_oa_resolver"`) to
`realContactCondition()` (`isPhantom = false`). This is an intentional widening — the
worklist now includes the new `message_content` (name-match) and `line_followers`
suggestions alongside OA-resolver rows. The change is internally consistent: list,
summary aggregates, assign, and patch all moved to the new predicate together, and the
bulk-assign path (`assignLineLinkValidationTasks:666-670`) still additionally requires
`lineOaResolverRunCondition(runId)` (which filters on `sourceRunId = runId`), so
non-resolver suggestions with a null `sourceRunId` are not swept into a run's
round-robin assignment.

This is flagged for **awareness, not correction**: operators who previously saw only
OA-resolver rows in the "all"/"unassigned" scopes will now also see content/follower
suggestions. That appears to be the phase's intent (the matcher is meant to feed the
validation worklist), but it is a behavior change worth confirming against the product
expectation, and the `validationAssignedRunId`/`sourceRunId`-scoped summary will now
mix sources when no `runId` is provided.

**Fix:** No code change required if the widening is intended (it appears to be).
Confirm the product expectation that name-match suggestions surface in the unfiltered
worklist scopes.

### IN-02: `suggestionsCreated` counter relies on a before/after row-count delta per follower

**File:** `src/lib/line/student-links.ts:779-793`

**Issue:** `runLineFollowersReanchor` computes `suggestionsCreated` by selecting all
link ids for the contact before and after calling
`ensureLineContactStudentLinkSuggestions`, then adding `after.length - before.length`.
This is correct for the reported metric (net new rows, and `onConflictDoNothing` keeps
the delta non-negative), but it issues two extra full-table `SELECT`s per follower
purely for a reported count. At follower-list scale (paginated 300 at a time, capped by
`maxDuration = 60`) this is a measurable amount of redundant query volume.

**Fix:** Optional. If the exact count matters, have
`ensureLineContactStudentLinkSuggestions` return the number of inserted rows (e.g. via
the `onConflictDoNothing(...).returning()` row count) instead of bracketing it with two
`SELECT`s. If the count is only informational, the current approach is acceptable.

---

_Reviewed: 2026-06-07_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
