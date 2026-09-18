# Classroom overflow planner

This change does not re-enable Wise publishing or automation. Owner checks and `WISE_CLASSROOM_AUTOMATION_ENABLED` remain unchanged.

## Release

1. Apply `0094_classroom_overflow_history.sql` before running the new code against a database. It adds nullable `student_ids` and `overflow_release_room` to assignment rows and the independent, append-only `classroom_mode_history` table. No old assignments are rewritten.
2. Run `npm run classrooms:bootstrap-history` to inspect aggregate counts from available successful snapshots and attendance. Run with `-- --apply` to persist those exact records. Repeating the bootstrap is idempotent. It calls no Wise API and never invents past transitions. Do not imply the available records cover the full 180 days.
3. Deploy a preview with the existing Node 24 project configuration. The pinned HiGHS package is externalized and its WASM is explicitly included in output tracing.
4. As the current operations owner, GET `/api/class-assignments?optimizerCheck=1`. Expect `ok: true`, `wasmLoaded: true`, `package: "highs@1.15.3"`, and `integerOptimum: 1`. This read-only diagnostic solves a tiny integer problem. It reads owner access but never loads/saves allocations or contacts Wise.
5. Review the Overflow plan on a generated, freshly verified overbooked day. Compare actual rows with `predictedAssignments`; proposed switches must be absent from actual modalities. Unresolved source/room issues remain visible.

The additive schema can remain in place if the application is rolled back. Existing classroom pause controls are the operational fallback. Do not enable automation as part of this rollout.

## Evidence and limitations

History capture failures in the successful Wise/Credit Control sync are recorded in `sync_runs.metadata.modalityHistory` / `credit_control_sync_runs.metadata.modalityHistory` and logged; they do not roll back a promoted scheduling snapshot. Past-session capture participates in that sync's transaction. History-read failure labels candidate history unknown and ranking unverified. Missing capacity, inconsistent live inputs, or unresolved source records stop the overflow recommendation.

Observations contain stable IDs and roster hashes, not copied student contact details. The history has no snapshot FK, so routine snapshot pruning cannot erase evidence. The runtime query applies the 180-day lesson window. The bootstrap reads only retained successful scheduling snapshots and exact attendance joins; gaps remain unknown.

Minimum-switch proof applies to the supplied classroom policies, protected assignments and eligible one-to-one lessons. It does not assert parent consent, tutor movement, external publication, or operational readiness. A `best_found` partial result is not an impossibility proof. Full-day occupancy is checked again before accepting a solver incumbent.

## Validation

- `overflow-planner.test.ts`: room-only relief, existing-online relocation, booths and reservations, aliases, protected/group/missing-roster cases, one long switch relieving two pressure periods, unchanged ordinary days, regeneration, sanitized busy-day replay, and generated schedules compared against exhaustive conversion counts and summed ranks.
- `overflow-timeout.test.ts`: feasible timeout incumbents do not claim proof.
- `mode-history.test.ts`: exact transitions, attendance fallback, cancellations, roster changes, deduplication, lookback, sample adjustment, recency and missing evidence.
- `overflow.integration.test.ts`: real migrated Postgres storage, hypothetical/actual separation, fresh-evidence activation and durable history.
- Existing assignment, reconciliation, sync, readiness and owner/pause suites remain release checks. UI tests cover conditional wording, counts, stale state and retained warnings. Browser QA uses sanitized fixtures, never production allocation writes.

Use Node 24 and `npm run verify:release`; run relevant integration suites against disposable Postgres, never production.
