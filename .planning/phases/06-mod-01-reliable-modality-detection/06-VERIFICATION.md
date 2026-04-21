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
