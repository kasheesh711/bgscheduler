// ── US locator dot-map projection (pure) ───────────────────────────────
// Linear equirectangular projection calibrated to the continental-US
// bounding box. This powers a LOCATOR dot-map only — it is NOT a choropleth
// and carries no aggregated/derived data; callers plot raw lat/lng points.
// Fail-closed: any coordinate outside the continental bounds (Alaska,
// Hawaii, territories) or non-finite projects to null so it is never drawn
// as a misplaced pin.

export interface DotMapViewBox {
  width: number;
  height: number;
}

/** Continental-US bounding box (excludes AK/HI/territories by design). */
export const CONTINENTAL_BOUNDS = {
  latMin: 24,
  latMax: 50,
  lngMin: -125,
  lngMax: -66,
} as const;

/** Default SVG coordinate space; the silhouette path is authored to match. */
export const DOT_MAP_VIEWBOX: DotMapViewBox = { width: 960, height: 600 };

/**
 * Project a lat/lng to viewBox coordinates via linear equirectangular mapping.
 * Steps:
 *   1. Reject null/undefined/non-finite inputs.
 *   2. Reject coordinates outside CONTINENTAL_BOUNDS.
 *   3. x scales lng left→right; y scales lat top→bottom (north = smaller y).
 * Returns null when the point cannot be placed inside the continental frame.
 */
export function projectLatLng(
  lat: number | null | undefined,
  lng: number | null | undefined,
  viewBox: DotMapViewBox = DOT_MAP_VIEWBOX,
): { x: number; y: number } | null {
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const { latMin, latMax, lngMin, lngMax } = CONTINENTAL_BOUNDS;
  if (lat < latMin || lat > latMax) return null;
  if (lng < lngMin || lng > lngMax) return null;
  const x = ((lng - lngMin) / (lngMax - lngMin)) * viewBox.width;
  const y = ((latMax - lat) / (latMax - latMin)) * viewBox.height;
  return { x, y };
}

/**
 * Label for an out-of-bounds institution (e.g. AK/HI/PR) rendered as a chip
 * instead of a misplaced pin. Returns null when no usable abbreviation.
 */
export function outOfBoundsLabel(stateAbbr: string | null | undefined): string | null {
  if (!stateAbbr) return null;
  const trimmed = stateAbbr.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase();
}
