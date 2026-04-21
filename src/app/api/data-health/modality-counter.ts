/**
 * Filter raw data_issues into the page-consumed "unresolvedModality" list.
 *
 * MOD-03 / D-10: includes BOTH legacy group-level `"modality"` issues (emitted
 * by `deriveModality` per-tutor-group) AND session-level `"conflict_model"`
 * issues (emitted by `detectSessionModalityConflict` during sync
 * orchestration). Surfaced as one admin-facing "Modality issues" number.
 *
 * The counter is expected to rise after MOD-01 ships — surface-of-reality
 * per D-11, not a regression.
 *
 * Lives in a dedicated module (not inline in `route.ts`) so Vitest can import
 * the helper without pulling the full Next.js route module graph (which
 * transitively imports `next-auth`, whose ESM subpath `next/server` cannot be
 * resolved by Vitest's bare Node resolver).
 *
 * `route.ts` re-exports this as `export { selectModalityIssues }`.
 */
export function selectModalityIssues<
  T extends { type: string; entityName: string | null; message: string },
>(
  issues: T[],
): { entityName: string; message: string; issueType: string }[] {
  return issues
    .filter((i) => i.type === "modality" || i.type === "conflict_model")
    .map((i) => ({
      entityName: i.entityName ?? "",
      message: i.message,
      issueType: i.type,
    }));
}
