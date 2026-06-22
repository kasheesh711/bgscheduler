// ── Dossier section guards (pure, exported for tests) ──────────────────
// Fail-closed rendering: a section whose every field is absent is suppressed
// rather than rendered as a grid of em dashes. A value counts as "present"
// only if it is a finite number or a non-blank string.

/** True when at least one field is a finite number or non-blank string. */
export function hasAnyValue(
  fields: ReadonlyArray<number | string | null | undefined>,
): boolean {
  return fields.some((f) => {
    if (typeof f === "number") return Number.isFinite(f);
    if (typeof f === "string") return f.trim().length > 0;
    return false;
  });
}
