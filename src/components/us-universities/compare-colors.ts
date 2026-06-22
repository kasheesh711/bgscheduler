// ── Per-school compare color assignment ────────────────────────────────
// Maps a unit id to a stable chart-color slot by its position in the
// ordered compare set. Clamped to 0..4 so it always indexes a real
// chartColors().chart entry even though MAX_COMPARE (4) and the chart
// palette length (5) differ — callers do chart[compareColorIndex(...) % 5].

/**
 * Resolve the color slot for a school in the shortlist.
 *
 * @param unitId    The institution's IPEDS unit id.
 * @param orderedIds The compare set in display order (URL `?compare=` order).
 * @returns Index into the 5-slot chart palette, clamped to 0..4. Ids not
 *          present in the list (e.g. a phantom deep-link id) fall back to 0.
 */
export function compareColorIndex(unitId: number, orderedIds: number[]): number {
  const idx = orderedIds.indexOf(unitId);
  if (idx < 0) return 0;
  return Math.min(idx, 4);
}
