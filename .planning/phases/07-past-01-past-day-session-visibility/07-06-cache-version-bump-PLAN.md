---
phase: 07-past-01-past-day-session-visibility
plan: 06
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/search/cache-version.ts
autonomous: true
requirements:
  - PAST-01

must_haves:
  truths:
    - "`CACHE_VERSION` in `src/lib/search/cache-version.ts` is the string `\"v2\"` (bumped from `\"v1\"` per D-17 / PITFALLS.md Pitfall 14)"
    - "All three call sites in `src/hooks/use-compare.ts` (lines 140, 145, 170) already import from this constant and require NO edit — the bump invalidates long-lived tabs transparently"
    - "The file-level JSDoc comment records the v1→v2 migration so future maintainers see the rule (`PAST-01 / VPOL-03 bump alongside shape change`)"
  artifacts:
    - path: "src/lib/search/cache-version.ts"
      provides: "CACHE_VERSION = \"v2\" constant + updated JSDoc"
      contains: "export const CACHE_VERSION = \"v2\";"
  key_links:
    - from: "src/lib/search/cache-version.ts"
      to: "src/hooks/use-compare.ts lines 140, 145, 170"
      via: "import at use-compare.ts top; three cache-key composite uses"
      pattern: "CACHE_VERSION = \"v2\""
---

<objective>
Bump the client-side tutor cache version string from `"v1"` to `"v2"` per D-17. This is a single-line code change with large client-side impact: it invalidates every long-lived browser tab's `tutorCache` Map so no stale-shape `CompareTutor` (pre-Phase-7, missing past-session merge behavior) can be served to the user. The three call sites at `src/hooks/use-compare.ts:140,145,170` use the constant through composite cache keys (`${tutorGroupId}:${week}:${CACHE_VERSION}`) — bumping the constant is sufficient; no call-site edits needed.

Purpose: Contract carried forward from Phase 6 D-19 — "Future v1.1 phases (PAST-01, VPOL-03) MUST bump this alongside their shape change." Phase 7 changes the semantic shape of `CompareTutor.sessions` (sessions now include past + future merged); the bump ensures correctness of client state after deploy.

Output: Two-line edit: the constant value bumped to `"v2"`, the JSDoc comment updated to record the v1→v2 migration.
</objective>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| CACHE_VERSION string → composite cache keys | Compile-time constant; no runtime input |
| Long-lived browser tabs → client-side state | Bumping invalidates stale client state safely (old keys never match new keys) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-06-01 | Denial of Service | All active tabs issue fresh fetches post-deploy | accept | 8 admin users, typical idle tab count ≤3, Plan 03 `'use cache'` amortizes server load; cold-fetch latency well within <2s budget. |
| T-07-06-02 | Information Disclosure | CACHE_VERSION string leaks auth info | mitigate | String value `"v2"` carries no secrets; already public (shipped in client bundle). |
| T-07-06-03 | Elevation of Privilege | Attacker forges `"v1"`-keyed state to serve old shape | accept | Cache is in-memory only (`useRef`, per PITFALLS.md §Pitfall 14), not persisted; no persistence path an attacker could hijack. |

All LOW. No HIGH severity threats.
</threat_model>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md
@.planning/research/PITFALLS.md
@src/lib/search/cache-version.ts
@src/hooks/use-compare.ts

<interfaces>
<!-- Current file (pre-edit) -->

From src/lib/search/cache-version.ts (the whole file):
```typescript
/**
 * Client-side cache version for `CompareTutor`-shaped data held in the
 * `tutorCache` Map inside `useCompare` (see `src/hooks/use-compare.ts`).
 *
 * Bump this string whenever the shape of `CompareTutor` /
 * `CompareSessionBlock` / any client-cached server shape changes. Future
 * v1.1 phases (PAST-01, VPOL-03) MUST bump this alongside their shape
 * change. The bump invalidates long-lived client tabs without a hard
 * reload.
 *
 * See `.planning/research/PITFALLS.md` Pitfall 14 for rationale.
 */
export const CACHE_VERSION = "v1";
```

From src/hooks/use-compare.ts (lines 140, 145, 170) — already consumes the constant:
```typescript
tutorCache.current.set(`${t.tutorGroupId}:${week}:${CACHE_VERSION}`, t);   // line 140
.map((id) => tutorCache.current.get(`${id}:${week}:${CACHE_VERSION}`))     // line 145
tutorCache.current.delete(`${id}:${weekStart}:${CACHE_VERSION}`);          // line 170
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Bump CACHE_VERSION to "v2" + update file-level JSDoc</name>
  <files>src/lib/search/cache-version.ts</files>
  <read_first>
    - src/lib/search/cache-version.ts (full file — confirm current value is exactly `"v1"`)
    - src/hooks/use-compare.ts (lines 140, 145, 170 — confirm call sites read from the constant, no inline strings)
  </read_first>
  <action>
Replace the entire contents of `src/lib/search/cache-version.ts` with:

```typescript
/**
 * Client-side cache version for `CompareTutor`-shaped data held in the
 * `tutorCache` Map inside `useCompare` (see `src/hooks/use-compare.ts`).
 *
 * Bump this string whenever the shape of `CompareTutor` /
 * `CompareSessionBlock` / any client-cached server shape changes. The bump
 * invalidates long-lived client tabs without a hard reload.
 *
 * Migration history:
 * - v1 (Phase 6, MOD-01): introduced with `modality` + `modalityConfidence`
 *   additions to `CompareSessionBlock`.
 * - v2 (Phase 7, PAST-01): `CompareTutor.sessions` now merges captured past
 *   sessions with future sessions for historical date ranges (D-17 / research
 *   Pitfall 14). Shape is additive, but semantic content changed — bumping
 *   ensures old-shape cached tutors cannot mix with new-shape fetched tutors
 *   on long-lived tabs.
 *
 * Future v1.1 phases (VPOL-03) MUST bump this alongside their shape change.
 *
 * See `.planning/research/PITFALLS.md` Pitfall 14 for rationale.
 */
export const CACHE_VERSION = "v2";
```

Do NOT edit any other file. The three call sites at `src/hooks/use-compare.ts:140,145,170` already read `CACHE_VERSION` via import; the constant bump propagates automatically.

Do NOT add localStorage persistence. Do NOT add a runtime migration path (old `v1` keys are in-memory only — ephemeral — per PITFALLS.md Pitfall 14).

Do NOT export additional symbols from this file — the single-constant surface is intentional.
  </action>
  <verify>
    <automated>grep -c "export const CACHE_VERSION = \"v2\"" src/lib/search/cache-version.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "export const CACHE_VERSION = \"v2\"" src/lib/search/cache-version.ts` returns `1`
    - `grep -c "export const CACHE_VERSION = \"v1\"" src/lib/search/cache-version.ts` returns `0` (no stale value left behind)
    - `grep -cn "\"v1\"" src/lib/search/cache-version.ts` returns `1` or more ONLY inside the Migration history comment (contains the string `"v1"` as documentation, e.g., `- v1 (Phase 6, MOD-01):` — not as a code value). Accepted: comment references. Unacceptable: a live `= "v1"` assignment.
    - `grep -c "= \"v1\"" src/lib/search/cache-version.ts` returns `0` (no assignment statement still uses v1)
    - `grep -c "Phase 7, PAST-01" src/lib/search/cache-version.ts` returns at least `1` (JSDoc documents the bump)
    - `npx tsc --noEmit 2>&1 | grep -c "error TS" | head -1` returns `0`
    - `grep -c "CACHE_VERSION" src/hooks/use-compare.ts` returns at least `3` (the three unchanged call sites at 140, 145, 170)
    - `npm test --run 2>&1 | tail -5 | grep -E "Tests.*passed"` shows no decrease from baseline
  </acceptance_criteria>
  <done>CACHE_VERSION is "v2"; JSDoc records the v1→v2 Phase 7 migration; call sites in use-compare.ts are unchanged and still functional.</done>
</task>

</tasks>

<verification>
- `npm test --run` passes
- `grep -c "CACHE_VERSION = \"v2\"" src/lib/search/cache-version.ts` returns `1`
- `grep -c "CACHE_VERSION = \"v1\"" src/lib/search/cache-version.ts` returns `0`
- No other file modified in this plan
</verification>

<success_criteria>
- CACHE_VERSION bumped to "v2"
- JSDoc comment captures the v1→v2 rationale referencing PAST-01 shape change
- Zero other files touched; call sites at use-compare.ts:140/145/170 unchanged
- All existing tests pass
</success_criteria>

<output>
After completion, create `.planning/phases/07-past-01-past-day-session-visibility/07-06-SUMMARY.md` documenting:
- Commit SHA (after git commit)
- Verified the constant value is exactly `"v2"` in the final file
- Note on client-side impact (long-lived tabs auto-invalidate on next compare fetch)
</output>
