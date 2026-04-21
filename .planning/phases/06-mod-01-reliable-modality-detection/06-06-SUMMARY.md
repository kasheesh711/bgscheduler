---
phase: 06-mod-01-reliable-modality-detection
plan: 06
type: execute
gap_closure: true
status: complete
completed: 2026-04-22
requirements: [MOD-01, MOD-02]
commits:
  - c9d9aee  # fix(06-06): widen ONLINE_SESSION_TYPES (Tasks 1+2)
  - 3975394  # docs(06-06): record Plan 02 NULL-rate measurement (Task 3)
---

## Gap closure — one-line proofs

1. **MOD-UAT-01 (blocking):** `"scheduled"` added to `ONLINE_SESSION_TYPES` at `src/lib/search/compare.ts:5`; paired-group sessions with `sessionType="SCHEDULED"` now resolve to `{modality: "online", confidence: "high"}` via the agreeing-signals branch of `resolveSessionModality`, not the pre-gap `{online, low}` inferred fallthrough. Proof: `grep -cE '^const ONLINE_SESSION_TYPES = new Set\(\["online", "virtual", "scheduled"\]\);$' src/lib/search/compare.ts` → `1`.
2. **STATE.md doc gap (non-blocking):** appended one bullet under §"Decisions (recent)" recording `0.00% (0/34092 rows in snapshot 25c31629)`. Proof: `grep -c "NULL rate" .planning/STATE.md` → `1`.

## What was built

### Task 1 — Set widening + rationale comment (`src/lib/search/compare.ts`)
Changed line 4 from `const ONLINE_SESSION_TYPES = new Set(["online", "virtual"]);` to a 2-line block: one rationale comment citing `MOD-UAT-01, 2026-04-21` plus the widened Set `new Set(["online", "virtual", "scheduled"])`. `ONSITE_SESSION_TYPES` untouched (the tenant's `OFFLINE` value lowercases to `offline` which the Set already contains). No function body changed — the resolver's existing `.trim().toLowerCase()` normalization at line 66 already converts uppercase Wise API values.

### Task 2 — Tenant-vocabulary regression cases (`src/lib/search/__tests__/compare.test.ts`)
Appended `case 18` and `case 19` inside the `describe("resolveSessionModality matrix (MOD-05 / D-21)", …)` block, AFTER the aggregate `never emits medium` test. Both cases use uppercase tenant inputs (`SCHEDULED` / `OFFLINE`) verbatim to exercise end-to-end lowercasing. Each case asserts resolver modality + confidence AND the mirrored `buildCompareTutor` output AND the conflict result, matching the D-21 contract. A 7-line comment header documents the tenant data distribution (9,677 SCHEDULED + 24,415 OFFLINE rows) so future readers understand why these two specific strings are anchored.

### Task 3 — Plan 02 measurement line (`.planning/STATE.md`)
Appended one bullet under §"Accumulated Context > Decisions (recent)" immediately after the existing `v1.0 polish bundled into v1.1 Phase 5` bullet and BEFORE the `### Pending Todos` section header. Measurement values copied verbatim from `06-02-SUMMARY.md` lines 64-68: snapshot `25c31629` / `0.00%` / `0/34092 rows` / `Scope retained.` / dated `2026-04-21`.

## Test count delta

| Suite | Pre-plan | Post-plan |
|-------|----------|-----------|
| `src/lib/search/__tests__/compare.test.ts` | 28 | 30 |
| Full `vitest run` | 118 | 120 |

Exactly +2 in both places; no test skipped, renamed, or weakened. Pre-existing 17 matrix cases + aggregate `never emits medium` test untouched.

## Scope preservation (confirmations)

- `git diff --numstat src/lib/db/schema.ts` → empty output (no `dataIssueTypeEnum` widening, no migration).
- `git diff src/lib/search/cache-version.ts | wc -l` → `0` (no CACHE_VERSION bump — `CompareSessionBlock`/`SessionModalityResolution` shapes unchanged; client cache remains valid).
- `git diff HEAD~2 src/components/compare/session-colors.ts | wc -l` → `0` (Pitfall-3 visual-distinction rule preserved — no modality-driven color/border branching).
- `grep -c "supportedModes\[0\]" src/lib/search/compare.ts` → `0` (MOD-02 silent single-mode fallback regression gate holds).
- `grep -c "ONLINE_LOCATION_PATTERNS\|ONSITE_LOCATION_PATTERNS" src/lib/search/compare.ts` → `0` (Plan 02's location-heuristic deletion preserved).

## Commit structure

Two atomic commits, per the plan's recommendation that a revert of the code commit should not touch STATE.md:

- **c9d9aee** — `fix(06-06): widen ONLINE_SESSION_TYPES for tenant SCHEDULED vocab (MOD-UAT-01)` — 2 files changed (compare.ts + compare.test.ts), +43/-1.
- **3975394** — `docs(06-06): record Plan 02 sessionType NULL-rate measurement in STATE.md` — 1 file changed, +1/-0.

## Hand-offs for re-verification

### For `06-VERIFICATION.md`
- **§Gaps row 1 (MOD-UAT-01):** move from BLOCKING → CLOSED. The 9,677 `SCHEDULED` sessions now render as high-confidence "Online" (`Video` icon per D-15).
- **§Gaps row 2 (STATE.md doc gap):** move to CLOSED. `grep "NULL rate" .planning/STATE.md` now returns ≥1.
- **§Behavioral Spot-Checks:** test count baseline updates from 118 → 120.

### For `06-HUMAN-UAT.md`
- Items **2 (D-14 parity)** and **3 (D-11 counter rise)** can now proceed — they were explicitly deferred pending this gap fix per the UAT doc.

## Explicitly NOT addressed (by design)

- **WR-02 (orphan-session silent drop)** remains in `06-REVIEW.md` for a later touch. Not in scope for this gap plan per `<gap_details>` out-of-scope notes.
- **`"unknown_session_type"` data-assertion** (add to `dataIssueTypeEnum`, generate migration, widen `/data-health`, emit drift counter from sync orchestrator). Evaluated and declined. Reasons recorded in 06-06-PLAN.md §"Deferred to a later phase":
  1. The narrower 1-line Set widening fully closes the observable UX gap on all 9,677 affected sessions.
  2. An enum + migration change would triple the scope of a gap closure and touch a live production schema unnecessarily.
  3. Data-drift detection is orthogonal to MOD-01's fail-closed modality contract — it's a `/data-health` concern, not a resolver concern.

Recommended follow-up: a small dedicated plan under v1.2 (or a POLISH task in a future milestone) to add `"unknown_session_type"` → `data_issues` emission + `/data-health` widening. This can ship independently once the current gap closure is verified in production.

## Self-Check

- [x] All 3 tasks executed in order (Task 1 → Task 2 → Task 3).
- [x] Each task committed atomically (2 commits: code + docs).
- [x] `ONLINE_SESSION_TYPES` contains `"scheduled"` alongside `"online"` and `"virtual"`.
- [x] `ONSITE_SESSION_TYPES` UNCHANGED.
- [x] Two new `case 18` + `case 19` tests present in D-21 matrix block.
- [x] 17 pre-existing matrix cases + aggregate `never emits medium` test UNCHANGED.
- [x] `compare.test.ts` → 30 passing tests (28 + 2).
- [x] Full `vitest run` → 120 passing (118 + 2).
- [x] STATE.md has exactly one new bullet with the required grep regex match; frontmatter/progress metrics untouched.
- [x] No `CACHE_VERSION` bump, no schema migration.
- [x] MOD-UAT-01 cited in both code (compare.ts comment) and tests (case names + inline comments) for traceability.
- [x] SUMMARY.md created (this file).
