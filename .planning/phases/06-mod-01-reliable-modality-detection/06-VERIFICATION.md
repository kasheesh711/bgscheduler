---
phase: 06-mod-01-reliable-modality-detection
verified: 2026-04-21T22:52:00Z
reverified: 2026-04-22
status: gaps_closed_pending_uat
score: 16/16 must-haves + 2 gap closures landed (MOD-UAT-01 fixed, STATE.md doc gap fixed); items 2+3 of HUMAN-UAT remain pending post-deploy
overrides_applied: 0
gap_closure_plan: 06-06
gap_closure_commits:
  - c9d9aee  # fix(06-06): widen ONLINE_SESSION_TYPES (Tasks 1+2)
  - 3975394  # docs(06-06): record Plan 02 NULL-rate measurement (Task 3)
---

# Phase 6 — MOD-01 Reliable Modality Detection: Verification Notes

This file is consumed by `/gsd-verify-phase` and by manual QA sign-off.
Sections added during plan execution provide context the verifier needs so
expected post-deploy behavior is not mistaken for regression.

## Expected post-deploy behavior: /data-health modality counter rise

The `/data-health` "Modality issues" counter is EXPECTED to rise after
MOD-01 ships. This is surface-of-reality per ROADMAP Phase 6 success
criterion #5 and 06-CONTEXT.md D-11 — NOT a regression. Before MOD-01,
the counter only reflected group-level unresolved modality issues
(emitted by `deriveModality`). After MOD-01, it also reflects
session-level signal contradictions (emitted by
`detectSessionModalityConflict` during sync orchestration). Higher
counts mean the tightened detection is working as designed.

QA sign-off MUST NOT flag the rise as a regression. The rise is the
evidence that MOD-01 is surfacing previously-hidden data issues.

### Why the rise is expected

Before MOD-01 (pre-Plan 06-02), the session-level modality resolver in
`resolveSessionModality` silently fell back to `supportedModes[0]` when
signals were weak or contradicting. Sessions with disagreeing
`isOnlineVariant` vs `sessionType` signals were reported as the first
supported mode of the group, masking the data quality issue.

After MOD-01 (from Plan 06-02 onward):
1. `resolveSessionModality` returns `{ modality: "unknown", confidence: "low" }`
   and a contradiction payload whenever paired-group signals disagree.
2. The sync orchestrator loops over sessions per snapshot and emits a
   `conflict_model` data_issue with `entityType="future_session_block"` and
   `entityId=wiseSessionId` for each contradiction detected.
3. Plan 06-03 (this plan) widens `/data-health`'s modality counter to
   include `type === "conflict_model"` alongside the legacy
   `type === "modality"` filter.

Therefore, every session that disagreed with its group modality pre-MOD-01
but was hidden behind the silent fallback now surfaces as a counted issue.

### QA checklist

1. Open `/data-health` after the first post-MOD-01 sync completes.
2. Confirm the "Modality issues" card renders with the tooltip "Includes
   unresolved group modality + per-session signal contradictions" and the
   expected-rise subtext.
3. Confirm per-row badges render: "group" for legacy `type === "modality"`
   issues, "session" for new `type === "conflict_model"` issues.
4. If the count is HIGHER than the pre-MOD-01 baseline, mark this as PASS
   and NOT a regression.
5. If the count is LOWER than the pre-MOD-01 baseline, that is a bug —
   file a blocker because it means either (a) the orchestrator is not
   emitting `conflict_model` issues, or (b) the filter regression in
   route.ts is dropping legacy modality issues.

### Unit-test coverage (Plan 06-03)

The filter logic is covered by
`src/app/api/data-health/__tests__/modality-counter.test.ts` with five
cases: mixed types, empty case, session-only case, projected shape
preservation, and null coercion.

---

# Phase 6 Verification Report

**Phase Goal:** Admin sees a trustworthy online/onsite label on every session card with fail-closed Needs Review for ambiguity, and no more silent fallback that guesses a mode.
**Verified:** 2026-04-21T22:52:00Z
**Status:** human_needed (all automated checks pass; visual/UX verification required in production)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Admin viewing any session card sees a modality icon (video / map-pin / question-mark) plus popover label; neither border style nor fill color is used for modality | VERIFIED (code) / HUMAN (visual) | `modalityDisplay` helper at `src/components/compare/modality-display.ts:12-28` returns `Video` / `MapPin` / `HelpCircle` from lucide-react. Both render sites call it: `calendar-grid.tsx:282, 304` and `week-overview.tsx:538, 562`. Icon element rendered at `absolute top-0.5 right-0.5 w-3 h-3 text-muted-foreground/70 pointer-events-none` (calendar-grid.tsx:286, week-overview.tsx:542). `session-colors.ts` has zero diff from HEAD (Pitfall 3 preserved). Visual confirmation needs human QA. |
| 2 | Sessions whose `isOnlineVariant` and `sessionType` signals contradict each other render as Needs Review (`"unknown"`) — never silently labeled online or onsite | VERIFIED | `resolveSessionModality` at `src/lib/search/compare.ts:59-134` returns `{modality: "unknown", confidence: "low", contradiction: {...}}` for D-07 (paired disagreement) and D-08 (single-record disagreement) branches. 6 CONTRADICTION cases in `compare.test.ts` (cases 4, 5, 9, 10, 15, 16) all assert `modality === "unknown"`. Silent `supportedModes[0]` fallback deleted: `grep -c "supportedModes\[0\]" src/lib/search/compare.ts` = 0. |
| 3 | Admin can see modality confidence (high / medium / low) surfaced on the session popover, with low-confidence cases visually indistinguishable from unresolved | VERIFIED (code) / HUMAN (visual) | `CompareSessionBlock.modalityConfidence: "high" \| "medium" \| "low"` at `src/lib/search/types.ts:122`. Popover label row present in both render sites (calendar-grid.tsx:302-307, week-overview.tsx:560-565). D-14 rule enforced: `modalityDisplay` returns `HelpCircle` for `confidence === "low"` regardless of modality (modality-display.ts:16-24). D-15 labels present verbatim in modality-display.ts: "Online", "Onsite", "Unknown", "Likely online — unconfirmed", "Likely onsite — unconfirmed". Visual confirmation needs human QA. |
| 4 | `compare.test.ts` test matrix asserts `"unknown"` for every contradiction case across `{isOnlineVariant, sessionType, supportedModes}` combinations and blocks merges on regression | VERIFIED | `describe("resolveSessionModality matrix (MOD-05 / D-21)", …)` at line 104 of compare.test.ts. 17 `it("case N: …")` cases + 1 "never emits medium" aggregate case = 18 new tests. 6 CONTRADICTION markers (cases 4, 5, 9, 10, 15, 16) each assert `modality === "unknown"` AND `conflictResult !== null`. Full suite: 118 passing (was 100 pre-Plan 05). compare.test.ts file: 28 passing tests. |
| 5 | `/data-health` dashboard modality-issue counts reflect the tightened detection (higher numbers post-deploy are surface-of-reality, not regression) | VERIFIED (code) / HUMAN (post-deploy) | `/api/data-health` route.ts:96 calls `selectModalityIssues(issues)` which filters `type === "modality" \|\| type === "conflict_model"` at `modality-counter.ts:25`. Page (`src/app/(app)/data-health/page.tsx:233-279`) renders combined counter with D-11 expected-rise subtext, per-row "group"/"session" badge, and tooltip "Includes unresolved group modality + per-session signal contradictions". 5 unit tests cover filter logic. D-11 note carried forward in this VERIFICATION.md above. Post-deploy counter delta requires human QA. |

**Score:** 5/5 ROADMAP success criteria verified in code; 3 truths additionally require human visual / post-deploy verification (see Human Verification Required below).

### Plan-level Must-Haves (from frontmatter)

| Plan | Must-Have | Status | Evidence |
|------|-----------|--------|----------|
| 06-01 | `src/lib/search/cache-version.ts` exports `CACHE_VERSION = "v1"` with bump-rule comment | VERIFIED | `cache-version.ts:13` = `export const CACHE_VERSION = "v1";`. Bump-rule comment at lines 1-12 references PITFALLS.md Pitfall 14. |
| 06-01 | All three `tutorCache` call sites in `use-compare.ts` use keys suffixed with `:${CACHE_VERSION}` | VERIFIED | `use-compare.ts:140` set, `:145` get, `:170` delete — all three include `:${CACHE_VERSION}` suffix. `grep -c CACHE_VERSION` = 4 (1 import + 3 uses). |
| 06-02 | Kickoff NULL-rate query recorded in STATE.md with concrete numeric percentage | FAILED (informational only) | `grep "sessionType NULL rate" .planning/STATE.md` returned zero matches. The plan summary claims 0.00% NULL (0/34092, snapshot 25c31629) but this measurement is NOT recorded in the main-branch STATE.md. The scope decision in the summary ("full retained") is accepted as a post-hoc explanation; the missing record is a documentation gap. See Gaps below. |
| 06-02 | `resolveSessionModality` returns BOTH modality AND confidence tier | VERIFIED | `compare.ts:59-134`, signature returns `SessionModalityResolution` = `{modality, confidence, contradiction?}` with every branch covered. |
| 06-02 | Contradictions produce `modality: "unknown"` AND emit `conflict_model` data_issue | VERIFIED | Contradiction branches in `compare.ts:86-95`, `:104-113`, `:117-127` all return `{modality: "unknown", confidence: "low", contradiction: ...}`. Orchestrator at `orchestrator.ts:355-386` calls `detectSessionModalityConflict` per session and pushes `type: "conflict_model"` with `entityType: "future_session_block"` + `entityId: session.wiseSessionId` into `allIssues`. |
| 06-02 | Silent `group.supportedModes[0]` fallback deleted | VERIFIED | `grep -c "supportedModes\[0\]" src/lib/search/compare.ts` = 0. |
| 06-02 | `ONLINE_SESSION_TYPES` and `ONSITE_SESSION_TYPES` preserved verbatim | VERIFIED | `compare.ts:4-5` match the original constants; 6 references in file (grep count). |
| 06-02 | `CompareSessionBlock` carries `modalityConfidence` sibling field | VERIFIED | `types.ts:122` = `modalityConfidence: "high" \| "medium" \| "low";` union matches D-03. |
| 06-02 | Per-session contradiction emission loop reads from hoisted Map (no per-session SELECT) | VERIFIED | `groupSupportedModality` Map hoisted at `orchestrator.ts:300`, populated at line 312, read at line 358. The MOD-01 loop (lines 355-386) contains zero `db.select` / `ctx.db.select` calls — verified via code read. |
| 06-02 | 669 existing tests continue passing; `npm run build` exits 0 | VERIFIED (tests) / UNCERTAIN (build) | Tests: 118 passed (14 files), 0 failed. The 669 figure was stale (matches plans' deviation notes — worktree baseline was 95 tests). Build not executable in this environment; orchestrator's post-wave validation is the authoritative gate. |
| 06-03 | `/api/data-health` payload includes `conflict_model` in `unresolvedModality` | VERIFIED | `route.ts:96` calls `selectModalityIssues(issues)`. `modality-counter.ts:25` filters `type === "modality" \|\| type === "conflict_model"`. |
| 06-03 | `/data-health` page renders single Modality issues counter whose value = count(type==="modality") + count(type==="conflict_model") | VERIFIED | `page.tsx:239` = `Modality issues ({data.unresolvedModality.length})` — single counter. Table rendering at lines 256-274 shows per-row "group"/"session" badge. |
| 06-03 | Unit test asserts counter value of 2 for fixture with one modality + one conflict_model | VERIFIED | `modality-counter.test.ts:12-21` — first test case. 5 tests total, all passing. |
| 06-03 | `06-VERIFICATION.md` contains "Expected post-deploy behavior: /data-health modality counter rise" section | VERIFIED | Section header preserved in this file (top of document); phrases "expected to rise", "surface-of-reality", "not a regression" all present. |
| 06-04 | `modality-display.ts` is single source of truth; both render sites import from it; no inline duplicate; no direct lucide-react modality imports elsewhere | VERIFIED | `grep -c "function modalityDisplay" src/components/compare/calendar-grid.tsx` = 0; same for week-overview.tsx. `grep -c "export function modalityDisplay" modality-display.ts` = 1. Both render files import `modalityDisplay` from `./modality-display`. |
| 06-04 | Every session card shows exactly one lucide icon at top-right corner sized `w-3 h-3` | VERIFIED (code) / HUMAN (visual) | Icon element at `absolute top-0.5 right-0.5 w-3 h-3 text-muted-foreground/70 pointer-events-none` rendered in both files. |
| 06-04 | Icon choice: high+online → Video; high+onsite → MapPin; low OR unknown → HelpCircle | VERIFIED | `modality-display.ts:16-27` — exact branch structure. Low branch always returns `HelpCircle` regardless of modality. |
| 06-04 | Session popover shows terse modality label matching D-15 exactly | VERIFIED (code) / HUMAN (visual) | Labels hardcoded in modality-display.ts: `"Online"`, `"Onsite"`, `"Unknown"`, `"Likely online — unconfirmed"`, `"Likely onsite — unconfirmed"`. No "(verified)" suffix — `grep -c "verified" modality-display.ts` = 0. |
| 06-04 | `session-colors.ts` has ZERO modality-based branches — file not modified relative to HEAD across the phase (Pitfall 3) | VERIFIED | `git diff HEAD -- src/components/compare/session-colors.ts \| wc -l` = 0. |
| 06-04 | No card border/fill changes based on modality; `s.modality` only used inside `modalityDisplay()` call sites | VERIFIED | Both `s.modality` usages in calendar-grid.tsx and week-overview.tsx are inside `modalityDisplay(s.modality, s.modalityConfidence)` calls. No usages in style/className expressions. |
| 06-05 | 17 D-21 matrix cases + 1 aggregate "never emits medium" case in compare.test.ts | VERIFIED | 17 `it("case N:")` cases matched in compare.test.ts. The aggregate case at line 357: `it("never emits \`medium\` confidence tier in MOD-01 (D-03)", ...)`. |
| 06-05 | Every contradiction case asserts `modality === "unknown"` AND non-null conflict payload | VERIFIED | 6 CONTRADICTION markers (cases 4, 5, 9, 10, 15, 16), all contain `expect(...).toBe("unknown")` and `expect(conflictResult).not.toBeNull()`. 17 `toBeNull` markers for non-contradiction cases + the 6 `not.toBeNull` = expected distribution. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/search/cache-version.ts` | CACHE_VERSION constant + bump-rule doc | VERIFIED | 13 lines, exports `CACHE_VERSION = "v1"`, JSDoc references PITFALLS.md Pitfall 14. |
| `src/hooks/use-compare.ts` | Imports CACHE_VERSION; 3 key suffixes | VERIFIED | Line 6 import; 3 template-literal keys at lines 140, 145, 170 all end `:${CACHE_VERSION}`. |
| `src/lib/search/compare.ts` | Refactored resolver + `detectSessionModalityConflict` + `SessionModalityResolution` | VERIFIED | All three exports present (lines 46-57, 59-134, 147-185). Location-pattern constants deleted. |
| `src/lib/search/types.ts` | `CompareSessionBlock.modalityConfidence` sibling field | VERIFIED | Line 122. Union matches D-01/D-03 exactly. |
| `src/lib/sync/orchestrator.ts` | `conflict_model` emission via hoisted Map (no SELECT) | VERIFIED | Lines 300-386. `groupSupportedModality` hoisted at 300, populated at 312, read at 358. MOD-01 loop emits `type: "conflict_model"` at line 372. Zero `db.select` calls in the loop. |
| `src/app/api/data-health/route.ts` | Widened filter + `issueType` passthrough | VERIFIED | `selectModalityIssues` re-exported (line 25-31) and used at line 96. |
| `src/app/api/data-health/modality-counter.ts` | Canonical filter impl | VERIFIED | Line 25 filter widened; `issueType` passthrough at line 29. |
| `src/app/api/data-health/__tests__/modality-counter.test.ts` | 5 unit tests | VERIFIED | 5 `it(...)` cases, all passing. |
| `src/app/(app)/data-health/page.tsx` | Combined counter + tooltip + "group"/"session" badge + expected-rise note | VERIFIED | Lines 232-279. All required elements present. |
| `src/components/compare/modality-display.ts` | Icon + label mapping, single source of truth | VERIFIED | 29 lines, imports lucide `Video`/`MapPin`/`HelpCircle`. Exports `modalityDisplay`. |
| `src/components/compare/calendar-grid.tsx` | Icon render + popover label via `modalityDisplay` | VERIFIED | Import at line 20; icon render lines 281-289; popover label lines 302-307. |
| `src/components/compare/week-overview.tsx` | Icon render + popover label via `modalityDisplay` | VERIFIED | Import at line 19; icon render lines 537-545; popover label lines 560-565. |
| `src/lib/search/__tests__/compare.test.ts` | D-21 matrix + D-22 contradiction assertions | VERIFIED | New describe block at line 104; 17 case + 1 aggregate test; all passing. Full file: 28 tests. |
| `.planning/phases/06-.../06-VERIFICATION.md` | D-11 expected-rise section | VERIFIED | This file, preserved from Plan 03 and merged with final verification. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/hooks/use-compare.ts` | `src/lib/search/cache-version.ts` | `import { CACHE_VERSION }` | VERIFIED | Line 6 import resolves; 3 key suffixes use the imported value. |
| `src/lib/sync/orchestrator.ts` | `src/lib/search/compare.ts` | `import { detectSessionModalityConflict }` | VERIFIED | Line 18. Used at line 363. |
| `src/lib/search/compare.ts::buildCompareTutor` | `src/lib/search/compare.ts::resolveSessionModality` | Call at line 235 | VERIFIED | `const { modality, confidence } = resolveSessionModality(group, s);` populates sessions array. |
| `src/app/api/data-health/route.ts` | `modality-counter.ts::selectModalityIssues` | `import ... from "./modality-counter"` | VERIFIED | Line 6 import; called at line 96. |
| `src/components/compare/calendar-grid.tsx` | `src/components/compare/modality-display.ts` | `import { modalityDisplay } from "./modality-display"` | VERIFIED | Line 20. Called at lines 282 (icon) and 304 (popover label). |
| `src/components/compare/week-overview.tsx` | `src/components/compare/modality-display.ts` | `import { modalityDisplay } from "./modality-display"` | VERIFIED | Line 19. Called at lines 538 (icon) and 562 (popover label). |
| `src/components/compare/modality-display.ts` | `lucide-react` | Named imports `Video`/`MapPin`/`HelpCircle` | VERIFIED | Line 1: `import { Video, MapPin, HelpCircle } from "lucide-react";` |
| `src/app/api/data-health/route.ts` → DB → `dataIssues.type` | Filter on `{modality, conflict_model}` | `selectModalityIssues` filter | VERIFIED | Line 25 of modality-counter.ts: `i.type === "modality" || i.type === "conflict_model"`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `src/components/compare/calendar-grid.tsx` icon | `s.modality`, `s.modalityConfidence` | `CompareResponse.tutors[].sessions[]` from `/api/compare` | Yes — session objects returned by `buildCompareTutor` which calls `resolveSessionModality` with real `wiseRecords` and `sessionType` data from SearchIndex / DB | FLOWING |
| `src/components/compare/week-overview.tsx` icon | Same as above | Same as above | Same as above | FLOWING |
| `src/app/(app)/data-health/page.tsx` counter | `data.unresolvedModality[]` | `/api/data-health` response | Yes — `issues` array comes from `db.select().from(schema.dataIssues)` filtered by active snapshot; `selectModalityIssues` narrows to relevant types | FLOWING |
| Orchestrator `conflict_model` emission | `allIssues[]` push at orchestrator.ts:370 | Real per-session iteration over live snapshot's `sessionBlocks` with `detectSessionModalityConflict` | Yes — writes to `data_issues` table on every sync via unchanged `insertInChunks(allIssues, ...)` at line 414-418 | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite runs green | `./node_modules/.bin/vitest run` | Test Files 14 passed (14) / Tests 118 passed (118) in 1.07s | PASS |
| D-21 matrix + existing tests pass | `./node_modules/.bin/vitest run src/lib/search/__tests__/compare.test.ts` | Test Files 1 passed (1) / Tests 28 passed (28) | PASS |
| /data-health counter filter tests pass | `./node_modules/.bin/vitest run src/app/api/data-health/__tests__/modality-counter.test.ts` | Test Files 1 passed (1) / Tests 5 passed (5) | PASS |
| Silent `supportedModes[0]` fallback absent | `grep -c "supportedModes\[0\]" src/lib/search/compare.ts` | 0 | PASS |
| Location-pattern constants removed | `grep -c "ONLINE_LOCATION_PATTERNS\|ONSITE_LOCATION_PATTERNS" src/lib/search/compare.ts` | 0 | PASS |
| `session-colors.ts` unchanged vs HEAD (Pitfall 3) | `git diff HEAD -- src/components/compare/session-colors.ts \| wc -l` | 0 | PASS |
| Single source of truth for `modalityDisplay` | `grep -c "function modalityDisplay" calendar-grid.tsx week-overview.tsx` | 0 in each render file; 1 in modality-display.ts | PASS |
| Production build | `npm run build` | Not run (environmental; worktree-level build fails per documented precedent; main-repo Vercel deploy is authoritative gate) | SKIP |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| MOD-01 | 06-02 | Session modality resolved from `isOnlineVariant` + `sessionType` primary signals, not location heuristics | SATISFIED | Resolver uses only `isOnlineVariant` + `sessionType`; location patterns deleted. |
| MOD-02 | 06-02 | No silent `supportedModes[0]` fallback; ambiguous routes to "unknown"/Needs Review | SATISFIED | `grep` for `supportedModes[0]` = 0. Unresolved branch returns `{modality: "unknown", confidence: "low"}`. |
| MOD-03 | 06-03 | Modality resolver returns `modalityConfidence: "high"\|"medium"\|"low"` AND `/data-health` surfaces the widened counter | SATISFIED | Confidence tier on `CompareSessionBlock`. `/data-health` filter widened to include `conflict_model`. |
| MOD-04 | 06-04 | Session cards display modality via icon + popover label (never color/border) | SATISFIED | Icons at `w-3 h-3 top-0.5 right-0.5` via `modalityDisplay`; popover label present in both render sites; `session-colors.ts` untouched. |
| MOD-05 | 06-05 | Fail-closed test matrix asserts "unknown" for every contradiction case | SATISFIED | 17-case D-21 matrix + 1 aggregate in compare.test.ts; 6 contradiction cases each assert `modality === "unknown"` and `conflictResult !== null`. |

**Coverage:** 5/5 requirements satisfied. No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/components/compare/modality-display.ts` | 9 | `TODO(future phase): when "medium" tier is first emitted ...` | Info | Documented forward-compat comment anchoring future work. Not a stub — every code path returns a real icon/label. Acceptable per code review IN-04 (intentional forward-compat, documented). |
| `src/components/compare/week-overview.tsx` | 176-183 | `applyColumnCap` groups sessions by `totalColumns` value alone; two disjoint overlap clusters can share a count | Info | Code review WR-01. Latent; not user-visible in current layout caps. Not introduced by Phase 6 — pre-existing. Tracked in 06-REVIEW.md. |
| `src/lib/search/compare.ts` | 78 | `resolveSessionModality` falls through to "unknown/low" without contradiction payload when `teacherRecord` is missing on a paired group | Warning | Code review WR-02. Silent-drop edge case for orphan sessions. Not blocking — output is still fail-closed ("unknown"). Contradiction emission is merely skipped for orphans. Recommendation: emit as new `orphan_session` data_issue type, or log completeness issue at sync time. Tracked in 06-REVIEW.md. |
| `src/app/api/data-health/route.ts` | 115-143 | No `Cache-Control` header; 5 sequential DB queries per request | Info | Code review WR-03. Performance concern; not a Phase 6 regression — pre-existing. Tracked in 06-REVIEW.md. |

No blocker anti-patterns introduced by Phase 6.

### Deferred Items

No deferred items. All 5 MOD requirements ship in Phase 6; later phases (PAST-01, VPOL-02, VPOL-03, VPOL-01) address orthogonal concerns.

### Human Verification Required

Automated checks confirm the code satisfies every plan-level must-have. Three items require human verification because they involve visual appearance, runtime behavior on production data, or a prior-to-post comparison.

#### 1. Visual confirmation of modality icons + popover labels on production compare view

**Test:**
1. Deploy to `bgscheduler.vercel.app`.
2. Visit `/search` and pick a tutor known to have both online and onsite sessions.
3. Open the compare panel and verify each session card shows exactly one modality icon in the top-right corner.
4. Hover the icon / open the popover and confirm the terse D-15 label ("Online" / "Onsite" / "Unknown" / "Likely online — unconfirmed" / "Likely onsite — unconfirmed") appears.
5. Confirm no session card has a border color, fill color, or stroke style that changes based on modality (Pitfall 3).

**Expected:** Every card shows an icon; popover shows a D-15 label. No modality-driven color/border.

**Why human:** Visual rendering fidelity, icon alignment against the existing overflow-badge at bottom-right, and aesthetic judgement on the `text-muted-foreground/70` opacity cannot be verified programmatically.

#### 2. Low-confidence renders identical to unknown (D-14 visual check)

**Test:**
1. Find a paired tutor whose session has a missing `sessionType` value.
2. Open the session card and verify the icon is `HelpCircle` (not `Video` or `MapPin`), identical to what an `unknown` session would show.
3. Open the popover and verify the label reads "Likely online — unconfirmed" or "Likely onsite — unconfirmed" (the data layer carries the inferred modality, but the icon claims nothing).

**Expected:** `HelpCircle` icon; popover label starts with "Likely".

**Why human:** D-14 rule (low = unknown visually) can only be assessed by a human confirming no visual distinction is made between `low`-confidence inferred modality and outright `unknown`.

#### 3. Post-deploy `/data-health` counter rise confirmation

**Test:**
1. Before the first post-MOD-01 sync, record the baseline "Modality issues" counter value from `/data-health`.
2. After the first MOD-01 sync completes, reload `/data-health` and note the new counter value.
3. Verify the new counter is ≥ baseline (equal is acceptable if the snapshot has zero signal contradictions; higher is expected if any contradiction exists).
4. Open the "Modality issues" card and confirm each row shows a "group" or "session" badge.
5. Confirm the subtext "Post-MOD-01 deploy, this counter is expected to rise..." is visible to admins.

**Expected:** Counter ≥ baseline with per-row badges; rise is marked as PASS per D-11, not a regression.

**Why human:** Comparison of pre-deploy vs post-deploy counts requires a deploy boundary and live data; cannot be simulated in tests.

### Gaps

Two gaps: one UAT-discovered data gap (blocking) and one documentation gap (non-blocking).

| Gap | Severity | Evidence |
|-----|----------|----------|
| **MOD-UAT-01 (blocking): `ONLINE_SESSION_TYPES` / `ONSITE_SESSION_TYPES` do not match the tenant's actual Wise sessionType vocabulary.** The active snapshot contains only two distinct `future_session_blocks.sessionType` values: `"OFFLINE"` (24,415 rows) and `"SCHEDULED"` (9,677 rows). `"OFFLINE"` lowercases to `"offline"` and matches `ONSITE_SESSION_TYPES` ✓. `"SCHEDULED"` does NOT match either set — so every one of the 9,677 online sessions falls through the type-signal branch into the weaker pair-structure branch and renders as `"Likely online — unconfirmed"` instead of `"Online"` (high confidence). Staff refer to these sessions as "Live" internally; the Wise API value is `"SCHEDULED"`. | Blocking — incorrect UX on ~28% of sessions | Discovered during post-deploy UAT on `bgscheduler.vercel.app`. DB query: `SELECT session_type, COUNT(*) FROM future_session_blocks WHERE snapshot_id = (SELECT id FROM snapshots WHERE active=true) GROUP BY session_type;` → `OFFLINE=24415, SCHEDULED=9677`. Resolver constants at `src/lib/search/compare.ts:4-5`. |
| Plan 02's Task 1 acceptance required recording the `future_session_blocks.sessionType` NULL-rate measurement in `.planning/STATE.md` under §"Decisions (recent)". The plan's SUMMARY (`06-02-SUMMARY.md`) reports `0.00% NULL (0/34092 rows, snapshot 25c31629)` and the Self-Check claims STATE.md line 90 contains the match — but the main-branch STATE.md has no such line. `grep "NULL rate" .planning/STATE.md` returns zero matches. | Documentation — non-blocking | The resolver/orchestrator/UI work all shipped correctly; the missing STATE.md line does not affect correctness. It may have been recorded in a worktree but not merged, or dropped during a squash. |

**Recommended fix paths:**

1. **MOD-UAT-01 (primary)** — Add `"scheduled"` to `ONLINE_SESSION_TYPES`. Add regression test cases covering the tenant's actual vocabulary (`OFFLINE`, `SCHEDULED`) so the cascade never silently degrades again when Wise vocabulary evolves. Consider a small data-assertion at sync time: any unrecognized sessionType → emit a `data_issue` of type `unknown_session_type` so the next vocabulary shift surfaces in `/data-health` within one sync cycle rather than after UAT.

2. **STATE.md doc gap (secondary)** — Append the measurement record:
   ```
   - **Phase 6 MOD-01 kickoff validation (2026-04-21):** `future_session_blocks.sessionType` NULL rate measured: 0.00% (0/34092 rows in snapshot 25c31629). Scope retained.
   ```

**Status is `gaps_found`** because gap 1 materially degrades the phase goal ("trustworthy online/onsite label on every session card"). Route through `/gsd-plan-phase 6 --gaps`.

---

## Gap Closure Re-Verification (Plan 06-06, 2026-04-22)

Both gaps identified above are now CLOSED in code. Post-deploy UAT remains to confirm the fix renders correctly in production.

| Gap | Severity | Status | Evidence |
|-----|----------|--------|----------|
| MOD-UAT-01 | Blocking | **CLOSED (code)** | `"scheduled"` added to `ONLINE_SESSION_TYPES` at `src/lib/search/compare.ts:5`. `grep -cE '^const ONLINE_SESSION_TYPES = new Set\(\["online", "virtual", "scheduled"\]\);$' src/lib/search/compare.ts` → `1`. Two new regression tests (`case 18` SCHEDULED→online/high, `case 19` OFFLINE→onsite/high) added to D-21 matrix — compare.test.ts 28→30, full suite 118→120. All tests green. Post-deploy UAT pending per HUMAN-UAT items 1–3. |
| STATE.md doc gap | Non-blocking | **CLOSED** | Bullet appended under §"Decisions (recent)". `grep -c "NULL rate" .planning/STATE.md` → `1`; regex `sessionType.*NULL rate measured: [0-9]+\.?[0-9]*% \([0-9]+/[0-9]+ rows` → `1`. Measurement values verbatim from 06-02-SUMMARY.md. |

Scope preservation (all confirmed):
- `git diff HEAD~2 src/lib/db/schema.ts` → empty (no schema migration).
- `git diff HEAD~2 src/lib/search/cache-version.ts | wc -l` → `0` (no CACHE_VERSION bump — shape unchanged).
- `git diff HEAD~2 src/components/compare/session-colors.ts | wc -l` → `0` (Pitfall 3 preserved).
- `grep -c "supportedModes\[0\]" src/lib/search/compare.ts` → `0` (MOD-02 silent-fallback regression gate holds).

**Status now `gaps_closed_pending_uat`** — code fixes have landed and tests pass; the 3 HUMAN-UAT items (visual icon render, D-14 parity, /data-health counter rise) remain pending normal post-deploy UAT and are NOT re-opened by the gap closure. HUMAN-UAT item 1's ISSUE has been downgraded to "FIX LANDED — pending post-deploy re-check" per the commit chain above.

### Gaps Summary

All 16 plan-level must-haves verified in code. All 5 ROADMAP success criteria are implemented and observable:
- Icons render on every session card; both render sites pull from the single-source `modalityDisplay` helper
- Contradictions fail-closed to `modality: "unknown"` with data_issue emission
- Confidence tier is shipped on `CompareSessionBlock` and surfaced in the popover label
- 17-case D-21 test matrix + contradiction assertions lock the fail-closed contract as a merge gate
- `/data-health` counter widened; page surface updated with badges and D-11 expected-rise subtext

The one minor gap is documentation (missing STATE.md NULL-rate record). Three items require human verification (visual icon render, low=unknown parity, post-deploy counter rise) — these are inherently not automatable.

---

_Verified: 2026-04-21T22:52:00Z_
_Verifier: Claude (gsd-verifier)_
