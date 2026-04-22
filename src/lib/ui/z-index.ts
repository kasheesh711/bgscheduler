/**
 * Authoritative z-index scale for the BGScheduler compare view (Phase 8 /
 * VPOL-02 sticky tutor legend).
 *
 * Three-tier scale:
 * - `content` (1): in-flow calendar content — session cards, conflict bands,
 *   free-gap tints, today indicator dots, lane tint backgrounds.
 * - `legend`  (6): sticky surfaces inside the compare-panel scroll container —
 *   WeekOverview's consolidated tutor legend (Plan 03) and CalendarGrid's
 *   sticky day-header (Plan 04). Both use `position: sticky top: 0` and
 *   stack above content but below portal-hoisted popovers.
 * - `popover` (50): portal-hoisted popovers. Base UI's `PopoverPrimitive.Portal`
 *   defaults to `z-50` on both the Positioner and the Popup
 *   (see `src/components/ui/popover.tsx`). Popovers render outside the
 *   compare-panel DOM subtree, so even if an ancestor created a stacking
 *   context, the portal escapes it. Listed here for documentation / single
 *   source of truth; we do not manually re-assign `z-50` on popovers.
 *
 * Scale history & authority:
 * - Original specification: `.planning/REQUIREMENTS.md` §STICKY-02 listed a
 *   5-slot scale (`z-[2]` content, `z-[4]` legend, `z-[5]` lane headers,
 *   `z-[6]` sticky day-header, `z-50` popovers).
 * - Simplified at Phase 8 CONTEXT time (D-08..D-10) to the 3-tier scale above
 *   because Phase 8 D-01 consolidates per-day lane headers INTO the single
 *   sticky legend — the separate `z-[5]` lane-headers slot is no longer a
 *   live surface. REQUIREMENTS.md §STICKY-02 was amended in Plan 01 to
 *   record the simplification (same class as Phase 5 D-02's NVDA
 *   relaxation); the STICKY-02 ID is preserved.
 *
 * Consumer convention:
 * - JSX preferred form: `style={{ zIndex: Z_INDEX.legend }}` for sticky
 *   elements that need a literal numeric value.
 * - Tailwind utility classes (`z-[6]`, `z-50`, `z-[1]`) are also acceptable
 *   at call sites PROVIDED a same-line code comment references the slot name
 *   (e.g., `className="... z-[6]"` with a comment `// Z_INDEX.legend`).
 *   Direct `zIndex: Z_INDEX.slot` is the default because it stays in sync
 *   automatically if the scale ever changes.
 *
 * Not related to CACHE_VERSION:
 * - This constant sits in a different module (`src/lib/ui/`) and has no
 *   lifecycle tie to `src/lib/search/cache-version.ts`. Phase 8 does NOT
 *   bump CACHE_VERSION (see 08-CONTEXT.md D-15) because sticky is pure
 *   CSS + TS constant + markup — no client-cached shape changes.
 *
 * See:
 * - `.planning/phases/08-vpol-02-sticky-tutor-legend/08-CONTEXT.md` §D-08..D-09
 * - `.planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md`
 * - `.planning/REQUIREMENTS.md` §STICKY-02 (amended 2026-04-22)
 */
export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;
