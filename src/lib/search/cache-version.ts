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
