// ── Tutor payout sheet parsing and matching ─────────────────────────────
//
// The payout sheets record class times in **UTC**, not Bangkok. Verified
// against production: a 25 Jul session stored at `scheduled_start_at`
// 06:00Z appears on the sheet as 06:00, and 09:30Z as 09:30. Every
// comparison in this module is therefore done in UTC. Treating these as
// Bangkok times would silently shift every match by seven hours.
//
// `fetchGoogleSheetRows` requests UNFORMATTED_VALUE + SERIAL_NUMBER, so
// dates and times arrive as Google serial numbers rather than strings.

/** Columns on the payout table, 0-based within the sheet row array. */
export const PAYOUT_SHEET_COLUMNS = {
  date: 0,
  time: 1,
  duration: 2,
  credits: 3,
  sessionName: 4,
  studentName: 5,
  payoutAmount: 6,
  notes: 7,
} as const;

export interface PayoutSheetRow {
  /** 1-based sheet row number, usable directly in A1 notation. */
  rowNumber: number;
  /** Class start as a UTC instant, combining the Date and Time cells. */
  startAt: Date | null;
  studentName: string;
  sessionName: string;
  payoutAmount: number | null;
}

export interface PayoutSheetTable {
  /** 1-based row number of the header row. */
  headerRowNumber: number;
  rows: PayoutSheetRow[];
}

const HEADER_TOKENS = ["date", "time", "student name", "payout amount"];

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
 * instant. Sheets counts days from 1899-12-30; a time is the fractional
 * part of a day. Both arrive as plain numbers under SERIAL_NUMBER rendering.
 */
export function serialToUtc(dateSerial: unknown, timeSerial: unknown): Date | null {
  const day = numberValue(dateSerial);
  if (day === null) return null;
  const fraction = numberValue(timeSerial);
  // A Date cell can already carry its time in the fractional part; a
  // separate Time cell is a day fraction in [0,1).
  const dayPart = Math.floor(day);
  const timePart = fraction !== null && fraction < 1 ? fraction : day - dayPart;
  const epochDays = dayPart - 25569; // 1899-12-30 → 1970-01-01
  const ms = Math.round((epochDays + timePart) * 86_400_000);
  const instant = new Date(ms);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Locate the payout table inside a raw sheet grid.
 *
 * Returns null when no header row carrying Date/Time/Student name/Payout
 * amount is present — a sheet whose shape we do not recognise must never be
 * written to.
 */
export function parsePayoutSheet(grid: unknown[][]): PayoutSheetTable | null {
  const headerIndex = grid.findIndex((row) => {
    const cells = (row ?? []).map((cell) => cellText(cell).toLocaleLowerCase("en-US"));
    return HEADER_TOKENS.every((token) => cells.includes(token));
  });
  if (headerIndex === -1) return null;

  const rows: PayoutSheetRow[] = [];
  for (let index = headerIndex + 1; index < grid.length; index += 1) {
    const row = grid[index] ?? [];
    const studentName = cellText(row[PAYOUT_SHEET_COLUMNS.studentName]);
    const startAt = serialToUtc(
      row[PAYOUT_SHEET_COLUMNS.date],
      row[PAYOUT_SHEET_COLUMNS.time],
    );
    if (!studentName && !startAt) continue;
    rows.push({
      rowNumber: index + 1,
      startAt,
      studentName,
      sessionName: cellText(row[PAYOUT_SHEET_COLUMNS.sessionName]),
      payoutAmount: numberValue(row[PAYOUT_SHEET_COLUMNS.payoutAmount]),
    });
  }
  return { headerRowNumber: headerIndex + 1, rows };
}

/** True when a raw grid row carries nothing in any cell. */
export function isBlankPayoutGridRow(row: unknown[] | undefined): boolean {
  // Read off the RAW grid, not `PayoutSheetTable.rows` — `parsePayoutSheet`
  // drops blank rows, so a parsed table cannot answer this question at all.
  // A short array is blank: Sheets truncates trailing empty cells.
  if (!row) return true;
  return row.every((cell) => cellText(cell) === "");
}

export interface PayoutSheetWindow {
  /** Bangkok calendar dates, `YYYY-MM-DD`, or null when the sheet omits them. */
  windowStart: string | null;
  windowEnd: string | null;
}

const WINDOW_LABELS = {
  windowStart: /^start\s*date$/iu,
  windowEnd: /^end\s*date$/iu,
} as const;

/**
 * Convert a Sheets serial or a written date to a `YYYY-MM-DD` Bangkok date.
 *
 * `fetchGoogleSheetRows` requests SERIAL_NUMBER, so a real date cell arrives as
 * a number; a text cell arrives as whatever the tutor typed.
 */
function windowDateValue(value: unknown): string | null {
  const serial = typeof value === "number" ? value : null;
  if (serial !== null) {
    const instant = serialToUtc(serial, null);
    return instant ? instant.toISOString().slice(0, 10) : null;
  }
  const text = cellText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;

  // Slashed dates are read as D/M/Y — the tenant's convention — but ONLY when
  // the first component cannot be a month. `26/06/2026` is unambiguous;
  // `06/07/2026` is not, and a wrong guess here would silently approve a
  // mismatched sheet, so it is left unparsed and the guard simply abstains.
  const slashed = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);
  if (slashed) {
    const [, first, second, year] = slashed;
    if (Number(first) <= 12) return null;
    return `${year}-${second.padStart(2, "0")}-${first.padStart(2, "0")}`;
  }

  const parsed = new Date(`${text} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Read the `START DATE` / `END DATE` preamble a payout sheet carries above its
 * table.
 *
 * `post_class_tutor_payout_sheets` has no month dimension — one active row per
 * tutor that someone re-points each month — so without this a run published
 * after a re-point would write its deductions into the following month's sheet,
 * silently, with date matching that still looks correct. Comparing against the
 * sheet's own declared window is the only evidence available that the mapping
 * still points where the run expects.
 *
 * Nulls mean "this sheet does not say", which is not the same as a mismatch;
 * callers must only refuse on a positive disagreement.
 */
export function parsePayoutSheetWindow(grid: unknown[][]): PayoutSheetWindow {
  const window: PayoutSheetWindow = { windowStart: null, windowEnd: null };
  for (const row of grid) {
    const cells = row ?? [];
    for (let index = 0; index < cells.length; index += 1) {
      const label = cellText(cells[index]);
      if (!label) continue;
      for (const [key, pattern] of Object.entries(WINDOW_LABELS)) {
        if (!pattern.test(label)) continue;
        // The value sits in the next cell that holds anything — sheets pad
        // labels with merged or empty cells before the value.
        for (let next = index + 1; next < cells.length; next += 1) {
          if (cellText(cells[next]) === "") continue;
          const parsed = windowDateValue(cells[next]);
          if (parsed) window[key as keyof PayoutSheetWindow] ??= parsed;
          break;
        }
      }
    }
  }
  return window;
}

/**
 * Whether a sheet's declared window is compatible with the run's.
 *
 * Absent dates are compatible: a sheet that does not declare its window cannot
 * contradict the run, and refusing on silence would make every sheet without a
 * preamble unwritable.
 */
export function payoutSheetWindowMatches(
  sheet: PayoutSheetWindow,
  run: { windowStart: string; windowEnd: string },
): boolean {
  if (sheet.windowStart && sheet.windowStart !== run.windowStart) return false;
  if (sheet.windowEnd && sheet.windowEnd !== run.windowEnd) return false;
  return true;
}

export type PayoutMatchStatus = "matched" | "unmatched" | "ambiguous";

export interface PayoutMatchResult {
  status: PayoutMatchStatus;
  row: PayoutSheetRow | null;
  /** Every row inside tolerance, for surfacing an ambiguous match. */
  candidates: PayoutSheetRow[];
}

/** Rows written by a previous publish must never be matched again. */
export const DEDUCTION_SESSION_NAME = "Feedback deduction";

export interface PayoutMatchInput {
  table: PayoutSheetTable;
  /** Scheduled start of the deducted class, as stored (UTC). */
  scheduledStartAt: Date;
  /** Student names on the session; any one matching is enough. */
  studentNames: string[];
  toleranceMinutes?: number;
}

/**
 * Match a deducted class to its payout row by UTC date + student + start
 * time within a tolerance.
 *
 * The tolerance exists because live sessions record their **actual** start:
 * production shows a sheet row at 10:26 for a class scheduled at 10:30.
 * Exact time matching would miss every one of those.
 */
export function matchPayoutRow(input: PayoutMatchInput): PayoutMatchResult {
  const toleranceMs = Math.max(0, input.toleranceMinutes ?? 15) * 60_000;
  const wanted = new Set(input.studentNames.map(normalizeStudentName).filter(Boolean));
  const targetDay = input.scheduledStartAt.toISOString().slice(0, 10);

  const candidates = input.table.rows.filter((row) => {
    if (!row.startAt) return false;
    // Never match a row a previous publish inserted.
    if (row.sessionName === DEDUCTION_SESSION_NAME) return false;
    if (row.startAt.toISOString().slice(0, 10) !== targetDay) return false;
    if (wanted.size > 0 && !wanted.has(normalizeStudentName(row.studentName))) return false;
    return Math.abs(row.startAt.getTime() - input.scheduledStartAt.getTime()) <= toleranceMs;
  });

  if (candidates.length === 0) return { status: "unmatched", row: null, candidates };
  if (candidates.length === 1) return { status: "matched", row: candidates[0], candidates };

  // Several rows inside tolerance. A single strictly-nearest row is still an
  // unambiguous answer; a tie is not, and must not be guessed at.
  const byDistance = candidates
    .map((row) => ({
      row,
      distance: Math.abs((row.startAt as Date).getTime() - input.scheduledStartAt.getTime()),
    }))
    .toSorted((left, right) => left.distance - right.distance);
  if (byDistance[0].distance < byDistance[1].distance) {
    return { status: "matched", row: byDistance[0].row, candidates };
  }
  return { status: "ambiguous", row: null, candidates };
}
