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
