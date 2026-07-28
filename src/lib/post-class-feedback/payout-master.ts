import { serialToUtc, normalizeStudentName } from "./payout-sheet";

// ── The master payout ledger ────────────────────────────────────────────
//
// `Begifted Payouts` → tab `Begifted Payouts Detailed` is where every payout
// line for every tutor actually lives. Each tutor's own workbook is a *view*
// over it: one `QUERY(IMPORTRANGE(...))` array formula filtered by that
// tutor's two identity strings and a date window. So a deduction is appended
// here, once, and reaches the tutor's sheet and their TOTAL PAYOUTS by itself.
//
// Nothing may be written into a tutor's workbook: writing into an array
// formula's output breaks it to `#REF!` and destroys their payout view.
//
// Times are **UTC**, matching `scheduled_start_at` — verified against
// production on the view this tab feeds. Treating them as Bangkok would shift
// every match by seven hours.

/**
 * 0-based columns of the master tab.
 *
 * `studentName` is column C even though its header reads "Course name" — the
 * header is wrong and the data is student names. Verified against production.
 */
export const MASTER_COLUMNS = {
  teacherName: 0,
  sessionName: 1,
  studentName: 2,
  date: 3,
  time: 4,
  duration: 5,
  credits: 6,
  payoutAmount: 7,
} as const;

export const MASTER_COLUMN_COUNT = 8;

/** What an appended deduction row says in the Session name column. */
export const DEDUCTION_SESSION_NAME = "Feedback deduction";
const MARKER_PREFIX = "BGS-PAYOUT";
/**
 * 12 hex, not 8. A marker collision reads as "already written" and silently
 * skips a deduction — a fail-*open* money error — so the extra four characters
 * buy the removal of a whole class of bug.
 */
const MARKER_DEDUCTION_CHARS = 12;
const MARKER_PATTERN = new RegExp(
  `${MARKER_PREFIX}\\s+(\\d{4}-\\d{2})\\s+([0-9a-f]{${MARKER_DEDUCTION_CHARS}})`,
  "iu",
);

export interface MasterPayoutRow {
  /** 1-based row number in the master tab. */
  rowNumber: number;
  teacherName: string;
  sessionName: string;
  studentName: string;
  /** Class start as a UTC instant, from the Date and Time cells. */
  startAt: Date | null;
  payoutAmount: number | null;
  /**
   * The Date and Time cells exactly as read. An appended deduction copies
   * these verbatim rather than formatting its own, so the new row's cell types
   * match the column and Google's QUERY cannot treat it as a minority type and
   * silently drop it.
   */
  rawDate: unknown;
  rawTime: unknown;
  /** Marker if this row is one a payout run appended, else null. */
  marker: string | null;
}

export interface MasterPayoutTable {
  headerRowNumber: number;
  rows: MasterPayoutRow[];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/gu, " ").trim();
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
 * Combine the master's Date and Time cells into a UTC instant.
 *
 * Read through `fetchGoogleSheetRows` (UNFORMATTED_VALUE + SERIAL_NUMBER) these
 * are numbers — `46232` and `0.5`. Read with the API's default render they are
 * the display strings `"2026-07-29"` and `"12:00"`. Both forms are accepted so
 * a caller that reads the tab differently cannot silently produce nonsense.
 */
export function masterCellToUtc(dateCell: unknown, timeCell: unknown): Date | null {
  if (typeof dateCell === "number") return serialToUtc(dateCell, timeCell);

  const dateText = cellText(dateCell);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateText)) return null;
  const timeText = cellText(timeCell);
  const time = timeText.match(/^(\d{1,2}):(\d{2})/u);
  const hours = time ? Number(time[1]) : 0;
  const minutes = time ? Number(time[2]) : 0;
  // A numeric time cell alongside a text date is a day fraction.
  const fraction = time === null ? numberValue(timeCell) : null;
  const base = Date.parse(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(base)) return null;
  const offsetMs = fraction !== null && fraction < 1
    ? Math.round(fraction * 86_400_000)
    : (hours * 60 + minutes) * 60_000;
  return new Date(base + offsetMs);
}

export function payoutRowMarker(input: {
  anchorMonth: string;
  deductionId: string;
}): string {
  const compact = input.deductionId.replace(/-/gu, "").slice(0, MARKER_DEDUCTION_CHARS);
  return `${MARKER_PREFIX} ${input.anchorMonth} ${compact}`;
}

/** Pull a marker out of a Session name cell, or null if it carries none. */
export function extractPayoutMarker(sessionName: unknown): string | null {
  const match = cellText(sessionName).match(MARKER_PATTERN);
  return match ? `${MARKER_PREFIX} ${match[1]} ${match[2].toLowerCase()}` : null;
}

const HEADER_TOKENS = ["teacher name", "session name", "date", "payout amount"];

/**
 * Locate the ledger table in a raw grid.
 *
 * Returns null when the header row is not recognisable. A tab whose shape we
 * cannot identify must never be appended to — that is how a column reorder
 * turns into deductions written under the wrong headings.
 */
export function parseMasterPayoutSheet(grid: unknown[][]): MasterPayoutTable | null {
  const headerIndex = grid.findIndex((row) => {
    const cells = (row ?? []).map((cell) => cellText(cell).toLocaleLowerCase("en-US"));
    return HEADER_TOKENS.every((token) => cells.includes(token));
  });
  if (headerIndex === -1) return null;

  // The columns must be where we think they are, not merely present.
  const header = (grid[headerIndex] ?? []).map((cell) => cellText(cell).toLocaleLowerCase("en-US"));
  if (header[MASTER_COLUMNS.teacherName] !== "teacher name"
    || header[MASTER_COLUMNS.sessionName] !== "session name"
    || header[MASTER_COLUMNS.date] !== "date"
    || header[MASTER_COLUMNS.payoutAmount] !== "payout amount") {
    return null;
  }

  const rows: MasterPayoutRow[] = [];
  for (let index = headerIndex + 1; index < grid.length; index += 1) {
    const row = grid[index] ?? [];
    const teacherName = cellText(row[MASTER_COLUMNS.teacherName]);
    if (!teacherName) continue;
    rows.push({
      rowNumber: index + 1,
      teacherName,
      sessionName: cellText(row[MASTER_COLUMNS.sessionName]),
      studentName: cellText(row[MASTER_COLUMNS.studentName]),
      startAt: masterCellToUtc(row[MASTER_COLUMNS.date], row[MASTER_COLUMNS.time]),
      payoutAmount: numberValue(row[MASTER_COLUMNS.payoutAmount]),
      rawDate: row[MASTER_COLUMNS.date] ?? "",
      rawTime: row[MASTER_COLUMNS.time] ?? "",
      marker: extractPayoutMarker(row[MASTER_COLUMNS.sessionName]),
    });
  }
  return { headerRowNumber: headerIndex + 1, rows };
}

/** Every marker present in the ledger, for the reconcile scan. */
export function collectMasterMarkers(table: MasterPayoutTable): Map<string, number> {
  const markers = new Map<string, number>();
  for (const row of table.rows) {
    if (row.marker && !markers.has(row.marker)) markers.set(row.marker, row.rowNumber);
  }
  return markers;
}

export type MasterMatchStatus = "matched" | "unmatched" | "ambiguous" | "clock_disagreement";

export interface MasterMatchResult {
  status: MasterMatchStatus;
  row: MasterPayoutRow | null;
  candidates: MasterPayoutRow[];
  /** Whole-hour offset detected when nothing matched but the day lines up. */
  offsetHours?: number;
}

export interface MasterMatchInput {
  table: MasterPayoutTable;
  /** The tutor's exact ledger identity strings — onsite and its ` Online` twin. */
  teacherNames: string[];
  scheduledStartAt: Date;
  studentNames: string[];
  toleranceMinutes?: number;
  claimedRows?: ReadonlySet<number>;
}

/**
 * Find the ledger row a deduction belongs to.
 *
 * The ledger holds every tutor, so candidates are narrowed by the tutor's own
 * identity strings first — without that, another tutor's identically-timed
 * class is a plausible match.
 *
 * The tolerance exists because a live session records its *actual* start:
 * production shows 10:26 against a class scheduled for 10:30.
 */
export function matchMasterRow(input: MasterMatchInput): MasterMatchResult {
  const toleranceMs = Math.max(0, input.toleranceMinutes ?? 15) * 60_000;
  const teachers = new Set(input.teacherNames.map((name) => name.trim().toLocaleLowerCase("en-US")));
  const wanted = new Set(input.studentNames.map(normalizeStudentName).filter(Boolean));
  const targetDay = input.scheduledStartAt.toISOString().slice(0, 10);

  const sameTutor = input.table.rows.filter((row) => {
    // A row a previous publish appended is never an anchor for another one.
    if (row.marker) return false;
    if (row.sessionName === DEDUCTION_SESSION_NAME) return false;
    return teachers.has(row.teacherName.trim().toLocaleLowerCase("en-US"));
  });

  const sameDay = sameTutor.filter((row) =>
    row.startAt && row.startAt.toISOString().slice(0, 10) === targetDay);

  const candidates = sameDay.filter((row) => {
    if (wanted.size > 0 && !wanted.has(normalizeStudentName(row.studentName))) return false;
    return Math.abs((row.startAt as Date).getTime() - input.scheduledStartAt.getTime()) <= toleranceMs;
  });

  if (candidates.length === 0) {
    // Nothing matched. Before reporting a bare "unmatched", check for the one
    // failure that would be catastrophic to write through: the same tutor and
    // the same student at a whole number of hours away. That is this class,
    // with the ledger keeping a different clock from ours — and appending
    // against a merely-nearest row would put the deduction on the wrong class.
    // The student match is what separates it from an adjacent lesson.
    const offsetHours = detectWholeHourOffset(sameTutor, input.scheduledStartAt, wanted, toleranceMs);
    if (offsetHours !== null) {
      return { status: "clock_disagreement", row: null, candidates: sameDay, offsetHours };
    }
    return { status: "unmatched", row: null, candidates: [] };
  }

  const unclaimed = input.claimedRows
    ? candidates.filter((row) => !input.claimedRows!.has(row.rowNumber))
    : candidates;
  if (unclaimed.length === 0) {
    return { status: "ambiguous", row: null, candidates };
  }
  if (unclaimed.length === 1) return { status: "matched", row: unclaimed[0], candidates };

  const byDistance = unclaimed
    .map((row) => ({
      row,
      distance: Math.abs((row.startAt as Date).getTime() - input.scheduledStartAt.getTime()),
    }))
    .toSorted((left, right) => left.distance - right.distance);
  // A strictly nearest row is still an unambiguous answer; a tie is not.
  if (byDistance[0].distance < byDistance[1].distance) {
    return { status: "matched", row: byDistance[0].row, candidates };
  }
  return { status: "ambiguous", row: null, candidates };
}

function detectWholeHourOffset(
  rows: MasterPayoutRow[],
  expected: Date,
  wantedStudents: ReadonlySet<string>,
  toleranceMs: number,
): number | null {
  for (const row of rows) {
    if (!row.startAt) continue;
    // Same student, or we have no student to compare and cannot tell an
    // offset class from a different one — in which case say nothing.
    if (wantedStudents.size === 0) return null;
    if (!wantedStudents.has(normalizeStudentName(row.studentName))) continue;
    const diffMs = row.startAt.getTime() - expected.getTime();
    const hours = diffMs / 3_600_000;
    const whole = Math.round(hours);
    if (whole === 0 || Math.abs(whole) > 14) continue;
    if (Math.abs(diffMs - whole * 3_600_000) <= toleranceMs) return whole;
  }
  return null;
}

export interface BuildMasterDeductionRowInput {
  anchor: MasterPayoutRow;
  /** Positive minor units as stored; the ledger row gets it negated. */
  amountMinor: number;
  marker: string;
}

/**
 * The row appended for one deduction.
 *
 * Teacher, date, time and student are copied from the anchor **verbatim**, not
 * reformatted. The ledger's Date and Time columns are typed, and a row whose
 * cells are strings where the column holds serials is treated by QUERY as a
 * minority type and dropped — the deduction would then be invisible both in
 * the tutor's view and in their total, with nothing reporting an error.
 */
export function buildMasterDeductionRow(
  input: BuildMasterDeductionRowInput,
): Array<string | number> {
  const row: Array<string | number> = new Array(MASTER_COLUMN_COUNT).fill("");
  row[MASTER_COLUMNS.teacherName] = input.anchor.teacherName;
  row[MASTER_COLUMNS.sessionName] = `${DEDUCTION_SESSION_NAME} · ${input.marker}`;
  row[MASTER_COLUMNS.studentName] = input.anchor.studentName;
  row[MASTER_COLUMNS.date] = input.anchor.rawDate as string | number;
  row[MASTER_COLUMNS.time] = input.anchor.rawTime as string | number;
  row[MASTER_COLUMNS.duration] = "—";
  // Numbers, not strings: the columns are numeric and USER_ENTERED is not used.
  row[MASTER_COLUMNS.credits] = 0;
  row[MASTER_COLUMNS.payoutAmount] = -Math.abs(input.amountMinor) / 100;
  return row;
}
