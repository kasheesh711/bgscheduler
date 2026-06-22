// ── Admissions-trend shaping (pure) ────────────────────────────────────
// DB-free helpers so they're unit-testable without the data layer.

import type { AdmissionsTrendPoint } from "./types";

/** Group flat cross-year admissions rows into per-unit ascending-by-year series. */
export function shapeAdmissionsTrend(
  rows: Array<{ unitId: number } & AdmissionsTrendPoint>,
): Map<number, AdmissionsTrendPoint[]> {
  const byUnit = new Map<number, AdmissionsTrendPoint[]>();
  for (const row of rows) {
    const { unitId, ...point } = row;
    let arr = byUnit.get(unitId);
    if (!arr) byUnit.set(unitId, (arr = []));
    arr.push(point);
  }
  // dataYear labels ("2020-21" … "2024-25") sort correctly lexically.
  for (const arr of byUnit.values()) arr.sort((a, b) => a.dataYear.localeCompare(b.dataYear));
  return byUnit;
}

/** The data-year immediately before `label` ("2024-25" → "2023-24"); null if unparseable. */
export function priorDataYearOf(label: string): string | null {
  const m = label.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  return `${start - 1}-${String(start).slice(2)}`;
}
