// ── US Universities (IPEDS) formatting helpers ─────────────────────────
// Pure, unit-tested display formatters. Fail-closed UI rule: a missing
// numeric metric (number | null | undefined) renders as an em dash "—",
// never coerced to 0. Moved out of institution-profile.tsx and
// institution-table.tsx so charts/dossier/table share one source of truth.

import {
  ADM_CONSIDERATION_LABELS,
  ADM_CONSIDERATION_VALUE_LABELS,
  AWARD_LEVEL_LABELS,
} from "@/lib/us-universities/constants";

export const EM_DASH = "—";

/** USD with thousands separators; null/undefined → em dash. */
export function formatUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

/** Percentage value (already 0–100), one decimal, trailing ".0" dropped; null → em dash. */
export function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  const rounded = Math.round(v * 10) / 10;
  return `${rounded}%`;
}

/** Student-faculty ratio as "N:1"; null/undefined → em dash. */
export function formatRatio(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  const rounded = Math.round(v * 10) / 10;
  return `${rounded}:1`;
}

/** Whole-number locale formatting for enrollment / dollar amounts; null → em dash. */
export function formatInt(v: number | null | undefined, prefix = ""): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `${prefix}${Math.round(v).toLocaleString("en-US")}`;
}

/** SAT range "p25–p75"; em dash when EITHER bound is missing. */
export function formatSatRange(
  p25: number | null | undefined,
  p75: number | null | undefined,
): string {
  if (p25 == null || p75 == null) return EM_DASH;
  return `${p25}–${p75}`;
}

/**
 * Render a p25–p75 range. Em dash only when BOTH bounds are null; a single
 * present bound is kept (the missing side renders as an em dash).
 * Numbers are rendered without locale formatting (raw digits) so SAT/ACT
 * score ranges like 1330–1530 are not comma-separated.
 */
export function rangeText(p25: number | null, p75: number | null): string {
  if (p25 == null && p75 == null) return EM_DASH;
  const lo = p25 == null ? EM_DASH : String(p25);
  const hi = p75 == null ? EM_DASH : String(p75);
  return `${lo}–${hi}`;
}

export interface AdmissionRequirement {
  key: string;
  label: string;
  level: string;
}

/**
 * Build the admission-requirements list from the ADMCON1..12 map.
 * Skips null codes and "Not considered" (code 3), preserving the canonical
 * ADMCON1→ADMCON12 ordering.
 */
export function admissionRequirements(
  adm: Record<string, number | null> | null | undefined,
): AdmissionRequirement[] {
  if (!adm) return [];
  const out: AdmissionRequirement[] = [];
  for (let n = 1; n <= 12; n += 1) {
    const key = `ADMCON${n}`;
    const code = adm[key];
    if (code == null) continue;
    // 3 = "Not considered" — omit it from the surfaced requirements.
    if (code === 3) continue;
    const level = ADM_CONSIDERATION_VALUE_LABELS[code];
    if (!level) continue;
    out.push({ key, label: ADM_CONSIDERATION_LABELS[key] ?? key, level });
  }
  return out;
}

/** Completion row label, preferring the precomputed award-level label. */
export function awardLevelText(
  awardLevel: number | null,
  fallbackLabel: string | null,
): string {
  if (fallbackLabel) return fallbackLabel;
  if (awardLevel != null && AWARD_LEVEL_LABELS[awardLevel]) {
    return AWARD_LEVEL_LABELS[awardLevel];
  }
  return EM_DASH;
}
