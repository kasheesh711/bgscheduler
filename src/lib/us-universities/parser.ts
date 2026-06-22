// ── IPEDS CSV cell parsing (pure) ──────────────────────────────────────
// Coercion + derivation helpers shared by the import transform and tests.

import { ADM_CONSIDERATION_LABELS } from "./constants";

/**
 * Parse an IPEDS numeric cell. Missing markers (blank, ".") → null
 * (fail-closed: never fabricate a 0 for unreported data). Valid negatives
 * are preserved — IPEDS longitude is legitimately negative (D-IPEDS-NA).
 */
export function coerceIpedsNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const t = value.trim().replace(/^"|"$/g, "").replace(/,/g, "");
  if (t === "" || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse an IPEDS integer cell (rounds; null on missing). */
export function coerceIpedsInt(value: string | null | undefined): number | null {
  const n = coerceIpedsNumber(value);
  return n == null ? null : Math.round(n);
}

/** Parse an IPEDS yes/no flag: 1 → true, 2 → false, anything else → null. */
export function coerceIpedsBool(value: string | null | undefined): boolean | null {
  const n = coerceIpedsInt(value);
  if (n === 1) return true;
  if (n === 2) return false;
  return null;
}

/** Trimmed string, or null when empty. */
export function emptyToNull(value: string | null | undefined): string | null {
  const t = (value ?? "").trim();
  return t === "" ? null : t;
}

/** 2-digit CIP family from a CIP code ("11.0701" → "11", "1.1001" → "01"). */
export function deriveCip2(cip: string): string {
  const head = (cip ?? "").trim().split(".")[0].replace(/\D/g, "");
  return head.padStart(2, "0").slice(0, 2);
}

/**
 * True only for 6-digit detail CIP codes ("11.0701"). IPEDS C2024_A reports the
 * SAME conferred degrees at three nested granularities (2-digit "11", 4-digit
 * "11.07", 6-digit "11.0701"); keeping only detail rows avoids triple-counting
 * while still rolling up correctly to a family via deriveCip2.
 */
export function isSixDigitCip(cip: string): boolean {
  return /^\d{2}\.\d{4}$/.test((cip ?? "").trim());
}

/** Upper-case all keys of a row map — IPEDS varies UNITID/unitId/unitid. */
export function upperKeys(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(row)) out[key.toUpperCase()] = row[key];
  return out;
}

/** Build the admission-considerations map (ADMCON1-12 code values) from an ADM row. */
export function parseAdmConsiderations(
  row: Record<string, string>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of Object.keys(ADM_CONSIDERATION_LABELS)) {
    out[key] = coerceIpedsInt(row[key]);
  }
  return out;
}
