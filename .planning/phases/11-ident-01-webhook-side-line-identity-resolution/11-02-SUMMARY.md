---
phase: 11-ident-01-webhook-side-line-identity-resolution
plan: "02"
subsystem: line
tags: [name-matching, levenshtein, nfkc, thai, identity-resolution, eval, tdd]

# Dependency graph
requires: []
provides:
  - "Pure-TS deterministic name matcher (matchNamesToDirectory) producing scored NameMatchCandidate[]"
  - "normalizeForNameMatch (space-preserving NFKC normalizer) and exported levenshtein"
  - "Threshold constants SUGGEST_SINGLE_MIN_SCORE=70, SUGGEST_SHORTLIST_MIN_SCORE=50"
  - "Distractor-rich eval harness gating precision >= 0.90 / recall >= 0.60"
affects: [11-03 student-links wiring, 11-04 followers-reanchor]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Three-tier deterministic matcher (exact NFKC -> token subset -> Levenshtein <=2) with per-tier score table"
    - "Sibling dominance: parent-only candidate dropped when it shares a confidently name-matched student's parent"
    - "Eval-as-precision-gate with hand-built distractor directory (>=3x distractors, hard cases, negatives)"

key-files:
  created:
    - src/lib/line/name-matcher.ts
    - src/lib/line/__tests__/name-matcher.test.ts
    - src/lib/line/__tests__/name-matcher.eval.test.ts
  modified: []

key-decisions:
  - "Kept thresholds at 70/50 (unchanged from plan); fixed precision via tier logic (sibling dominance), not threshold inflation"
  - "Added a 4th step (sibling dominance) on top of the planned 3 tiers to drop sibling distractors when the student is confidently named"
  - "Tier 2/3 use full intersection (ALL input tokens must match) so a shared first name alone never yields a high-confidence match"

patterns-established:
  - "Sibling dominance: when input names a student (studentName match >=70), drop parent-only candidates that share that student's parent name; preserve genuine parent-only shortlists and conflicting-signal cases"
  - "Fail-closed: matcher returns suggestions only, no DB writes, no auto-confirm path"

requirements-completed: [IDENT-01, IDENT-02]

# Metrics
duration: ~95min (incl. interrupted first run + calibration finalization)
completed: 2026-06-07
---

# Phase 11 / Plan 02: Deterministic Name Matcher Summary

**Pure-TS three-tier name matcher (exact NFKC -> token subset -> Levenshtein <=2) with sibling-dominance, calibrated to precision 0.905 / recall 1.0 against a 26-student distractor-rich eval directory.**

## Performance

- **Duration:** ~95 min (first executor run interrupted by an API socket error after the RED commit; calibration + sibling-dominance fix + finalization completed in continuation)
- **Completed:** 2026-06-07
- **Tasks:** RED (tests) + GREEN (implementation + calibration)
- **Files modified:** 3 created

## Accomplishments
- `matchNamesToDirectory` — deterministic three-tier matcher producing scored `NameMatchCandidate[]`, deduped by studentKey, sorted by score
- `normalizeForNameMatch` (space-preserving NFKC/lowercase/Thai-aware) distinct from the code-matching `normalizeLineStudentCode`
- `levenshtein` extracted as a named export
- Threshold constants `SUGGEST_SINGLE_MIN_SCORE=70`, `SUGGEST_SHORTLIST_MIN_SCORE=50`
- 41 unit tests (all three tiers, Thai + romanized, fail-closed cases) + 4 eval tests (precision/recall + fixture-integrity assertions)

## Task Commits

1. **RED — failing unit + eval tests** - `58f757c` (test)
2. **GREEN — matcher implementation + sibling dominance + calibration** - `55f7f52` (feat)

_TDD discipline preserved: RED commit asserts the eval gate before implementation; GREEN brings it to pass._

## Files Created/Modified
- `src/lib/line/name-matcher.ts` - Pure matcher module (6 named exports, no DB imports, no auto-confirm path)
- `src/lib/line/__tests__/name-matcher.test.ts` - 41 tier/behavior unit tests
- `src/lib/line/__tests__/name-matcher.eval.test.ts` - Distractor-rich eval fixture with precision/recall gate

## Eval Set Details (per plan <output>)
- **Fixtures:** 26 total — 19 positive, 7 negative. Breakdown: 5 exact full names, 1 unique first name, 1 full Thai multi-token, 1 combined student+parent signal, 1 Thai nickname (positive), 2 sibling-ambiguity (parent-only), 2 shared-first-name + parent, 4 parent-name-only, 2 fuzzy, 7 negatives.
- **Hard cases present:** Thai nicknames (น้องส้ม, หนูนา); romanized-vs-Thai mismatch (หนูนา vs "Nuuna Sripan" -> correctly []); shared-first-name ambiguity (3x Nicha, 2x James/Kanya/Pim in directory); near-Levenshtein neighbors (Nisha, Kanaya, Jamos, Pimchanon); siblings sharing a parent (som/peesom share คุณแม่ส้ม; nicha/minta share คุณแม่นิชา); 7 negative cases asserting [].
- **Mock directory:** 26 students — 6 expected-match, 20 distractors (2 siblings + 4 shared-first-name + 4 near-Levenshtein + 10 padding). Distractor ratio **3.33x** (>= 3x required).
- **Measured precision:** **0.905** (19 correct / 21 total suggestions) — required >= 0.90
- **Measured recall:** **1.000** (19/19 positive fixtures shortlisted the correct student) — required >= 0.60
- **Thresholds adjusted?** No. `SUGGEST_SINGLE_MIN_SCORE` (70) and `SUGGEST_SHORTLIST_MIN_SCORE` (50) are unchanged from the plan. Precision was lifted by fixing tier logic (sibling dominance), not by inflating thresholds or simplifying the distractor set.
- **Tests added:** 45 (41 unit + 4 eval).
- **Fixture provenance:** Synthetic-but-realistic Thai/English scheduling-message name patterns; no row linked to a real production DB row. Production-labeled calibration against live extracted_state is a noted follow-up; admin-verify still gates every link, so this gate ensures the worklist is not flooded with garbage suggestions.

## Decisions Made
- **Sibling dominance (step 4):** The eval's shared-first-name + sibling-parent case (`Nicha Suwanprasert` + `คุณแม่นิชา`) surfaced the sibling `minta.cs` via parent_name_exact even though the studentName uniquely identified `nicha.sw`. Added a 4th step: when a studentName confidently matches (>=70), drop parent-only candidates that share that student's parent name. This is sibling-specific — a parent-only match on a student with a *different* parent (a conflicting signal) is preserved for admin review, and parent-only inputs (genuine sibling shortlists) are untouched. This aligns with the eval author's documented intent that the full-name signal should dominate.
- Kept thresholds; relied on tier logic per the plan's guidance ("raise thresholds or fix the tier logic").

## Deviations from Plan

### Process deviation (execution, not scope)
- The first executor agent was interrupted by an API socket error after committing the RED tests; the GREEN implementation existed uncommitted and the eval was still mid-calibration (precision 0.864). Finalization (calibration fix, cleanup, commit, summary) was completed in continuation by the orchestrator. Two scratch debug test files (`debug-eval.test.ts`, `debug-eval2.test.ts`) left by the interrupted run were removed.

### Design refinement (within plan latitude)
- Added the sibling-dominance step (4th step beyond the planned 3 tiers). The plan explicitly anticipated tier-logic changes if precision < 0.90, so this is within-plan latitude, not scope creep. The distractor-rich fixture and all hard cases were preserved; precision was earned, not gamed.

**Impact on plan:** Matcher meets all success criteria. No scope creep.

## Issues Encountered
- Eval precision initially 0.864 (one unintended sibling false-positive beyond the two intentional sibling-ambiguity cases). Resolved via sibling dominance. An over-broad first version of the rule (drop all parent-only when any confident studentName match exists) broke a unit test encoding a conflicting-signal (non-sibling) case; refined to the sibling-sharing condition, after which both unit (41/41) and eval (4/4) pass.

## User Setup Required
None - pure module, no external service configuration.

## Next Phase Readiness
- `matchNamesToDirectory` + `NameMatchCandidate` + threshold constants are ready to be wired into the suggestion pipeline in Plan 11-03 (`ensureLineContactStudentLinkSuggestions`).
- `LineStudentDirectoryRow` import contract confirmed against `src/lib/line/student-links.ts`.

---
*Phase: 11-ident-01-webhook-side-line-identity-resolution*
*Completed: 2026-06-07*
