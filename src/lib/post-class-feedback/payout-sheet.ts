// ── Payout sheet cell helpers ───────────────────────────────────────────
//
// What remains of the original per-tutor workbook parser. Deductions are
// appended to the app-owned `Feedback Deductions` tab (`payout-master.ts`),
// never written into a tutor's workbook — that workbook is a
// `QUERY(IMPORTRANGE(...))` view, and writing into an array formula's output
// breaks it to `#REF!`.
//
// Both payout surfaces record class times in **UTC**, not Bangkok. Verified
// against production: a session stored at `scheduled_start_at` 06:00Z appears
// as 06:00. Treating these as Bangkok would shift every match by seven hours.
//
// `fetchGoogleSheetRows` requests UNFORMATTED_VALUE + SERIAL_NUMBER, so dates
// and times arrive as Google serial numbers rather than strings.

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/gu, " ").trim();
}

/** Case- and whitespace-insensitive name key for matching students. */
export function normalizeStudentName(value: unknown): string {
  return cellText(value).toLocaleLowerCase("en-US");
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[,\s฿]/gu, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Convert a Google Sheets serial date (+ optional serial time) to a UTC
 * instant. Sheets counts days from 1899-12-30; a time is the fractional part
 * of a day.
 */
export function serialToUtc(dateSerial: unknown, timeSerial: unknown): Date | null {
  const day = numberValue(dateSerial);
  if (day === null) return null;
  const fraction = numberValue(timeSerial);
  // A Date cell can already carry its time in the fractional part; a separate
  // Time cell is a day fraction in [0,1).
  const dayPart = Math.floor(day);
  const timePart = fraction !== null && fraction < 1 ? fraction : day - dayPart;
  const epochDays = dayPart - 25569; // 1899-12-30 → 1970-01-01
  const ms = Math.round((epochDays + timePart) * 86_400_000);
  const instant = new Date(ms);
  return Number.isNaN(instant.getTime()) ? null : instant;
}
