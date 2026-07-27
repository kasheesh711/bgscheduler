import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { serializeCsv, type CsvColumn } from "@/lib/sales-dashboard/csv";

import { PostClassValidationError } from "./errors";
import {
  DEDUCTION_SESSION_NAME,
  isBlankPayoutGridRow,
  matchPayoutRow,
  PAYOUT_SHEET_COLUMNS,
  type PayoutSheetRow,
  type PayoutSheetTable,
} from "./payout-sheet";

// ── What a payout run writes, and whether it may ────────────────────────
//
// Every decision about a payout write lives here: which sheet row a deduction
// belongs under, what the inserted row says, in what order the writes go, and
// whether the run is allowed to publish at all. Nothing in this module touches
// the database, the network, or `server-only` — publishing moves money, and
// the parts that decide what moves should be testable without faking anything.

/** Cells A..H of an inserted deduction row. */
export type PayoutRowValues = Array<string | number | null>;

export interface PayoutWritePlan {
  lineId: string;
  deductionId: string;
  spreadsheetId: string;
  sheetName: string;
  sheetGid: number;
  /** 1-based row of the matched class. The deduction goes directly below it. */
  anchorRowNumber: number;
  /** 1-based row the deduction will occupy, i.e. `anchorRowNumber + 1`. */
  targetRowNumber: number;
  /** True when a previous attempt already inserted the row but never filled it. */
  reuseBlankRow: boolean;
  values: PayoutRowValues;
  marker: string;
}

/**
 * Stable per-line key. Deterministic so a retry reuses it rather than minting a
 * second identity for the same work.
 */
export function payoutLineIdempotencyKey(input: {
  runId: string;
  deductionId: string;
}): string {
  return `payout:${input.runId}:${input.deductionId}`;
}

/**
 * The stamp written into the notes column of an inserted row.
 *
 * This — not the database — is what makes a re-publish safe. A line's stored
 * `writeStatus` can be lost to a crash between the Sheets call and the database
 * write; the sheet cannot lose what is already in it. Reading the marker back
 * is therefore the only reliable answer to "did this land?".
 *
 * Consequence worth stating plainly: the notes cell on a deduction row is
 * machine-owned. Editing away a marker can cause a later publish to write the
 * row a second time.
 */
export function payoutRowMarker(input: {
  anchorMonth: string;
  deductionId: string;
}): string {
  return `BGS-PAYOUT ${input.anchorMonth} ${input.deductionId.replace(/-/gu, "").slice(0, 8)}`;
}

export type PayoutRowAction =
  | { kind: "already_written"; rowNumber: number }
  | { kind: "reuse_blank"; anchorRowNumber: number; rowNumber: number }
  | { kind: "insert"; anchorRowNumber: number; rowNumber: number }
  | { kind: "unmatched" }
  | { kind: "ambiguous"; candidates: PayoutSheetRow[] };

export interface ResolvePayoutRowActionInput {
  /** The raw grid, needed because `parsePayoutSheet` discards blank rows. */
  grid: unknown[][];
  table: PayoutSheetTable;
  marker: string;
  scheduledStartAt: Date;
  studentNames: string[];
  /** Anchors already taken by earlier lines in this same pass. */
  claimedAnchorRows?: ReadonlySet<number>;
  toleranceMinutes?: number;
}

function findMarkerRowNumber(grid: unknown[][], marker: string): number | null {
  for (let index = 0; index < grid.length; index += 1) {
    const row = grid[index] ?? [];
    for (const cell of row) {
      if (typeof cell === "string" && cell.includes(marker)) return index + 1;
    }
  }
  return null;
}

/**
 * Decide what a single deduction needs done to its tutor's sheet.
 *
 * Evaluated against a freshly read grid, in an order chosen so that an attempt
 * interrupted anywhere is recoverable:
 *
 *  1. The marker is present somewhere → the row landed on a previous attempt,
 *     even if the database never recorded it. Nothing to do.
 *  2. The row directly under the anchor is blank → a previous attempt inserted
 *     but did not fill. Reuse that row instead of inserting a second one.
 *  3. Otherwise insert.
 */
export function resolvePayoutRowAction(input: ResolvePayoutRowActionInput): PayoutRowAction {
  const alreadyWritten = findMarkerRowNumber(input.grid, input.marker);
  if (alreadyWritten !== null) return { kind: "already_written", rowNumber: alreadyWritten };

  const match = matchPayoutRow({
    table: input.table,
    scheduledStartAt: input.scheduledStartAt,
    studentNames: input.studentNames,
    toleranceMinutes: input.toleranceMinutes,
  });
  if (match.status === "unmatched") return { kind: "unmatched" };
  if (match.status === "ambiguous" || !match.row) {
    return { kind: "ambiguous", candidates: match.candidates };
  }

  const anchorRowNumber = match.row.rowNumber;
  // Two deductions resolving to one class row cannot both own it. Report the
  // second rather than stacking two deductions under the same anchor.
  if (input.claimedAnchorRows?.has(anchorRowNumber)) {
    return { kind: "ambiguous", candidates: match.candidates };
  }

  const rowNumber = anchorRowNumber + 1;
  // 1-based row `rowNumber` is grid index `rowNumber - 1`.
  if (isBlankPayoutGridRow(input.grid[rowNumber - 1])) {
    return { kind: "reuse_blank", anchorRowNumber, rowNumber };
  }
  return { kind: "insert", anchorRowNumber, rowNumber };
}

export interface BuildPayoutSheetRowValuesInput {
  /** The matched class row, raw. Its date/time cells are copied verbatim. */
  anchorRow: unknown[];
  studentName: string;
  /** Positive minor units as stored on the deduction; the sheet gets it negated. */
  amountMinor: number;
  reason: string;
  deadlineAt: Date | null;
  tutorSubmittedAt: Date | null;
  marker: string;
}

export function buildPayoutSheetRowValues(
  input: BuildPayoutSheetRowValuesInput,
): PayoutRowValues {
  const submitted = input.tutorSubmittedAt
    ? `Submitted ${formatBangkokDateTime(input.tutorSubmittedAt)}`
    : "No tutor submission observed";
  const note = [
    input.reason,
    input.deadlineAt ? `Deadline ${formatBangkokDateTime(input.deadlineAt)}` : null,
    submitted,
    input.marker,
  ].filter(Boolean).join(" · ");

  const values: PayoutRowValues = new Array(8).fill("");
  // Copied rather than reformatted: the anchor's cells are already in whatever
  // form this sheet uses (serial or text), and re-rendering them would make the
  // deduction row look foreign next to the class it belongs to.
  values[PAYOUT_SHEET_COLUMNS.date] = (input.anchorRow[PAYOUT_SHEET_COLUMNS.date] ?? "") as string | number;
  values[PAYOUT_SHEET_COLUMNS.time] = (input.anchorRow[PAYOUT_SHEET_COLUMNS.time] ?? "") as string | number;
  values[PAYOUT_SHEET_COLUMNS.duration] = "—";
  values[PAYOUT_SHEET_COLUMNS.credits] = "—";
  values[PAYOUT_SHEET_COLUMNS.sessionName] = DEDUCTION_SESSION_NAME;
  values[PAYOUT_SHEET_COLUMNS.studentName] = input.studentName;
  // A number, not a string: the write uses USER_ENTERED, which would re-parse a
  // string and could land text in a column the sheet sums.
  values[PAYOUT_SHEET_COLUMNS.payoutAmount] = -Math.abs(input.amountMinor) / 100;
  values[PAYOUT_SHEET_COLUMNS.notes] = note;
  return values;
}

/**
 * Descending by anchor row, so every insert happens below the rows still to be
 * processed.
 *
 * Two reasons, and the second is the one that bites: inserting a row shifts
 * every row beneath it, *and* the grid was read once, so an insert also makes
 * the read copy stale below that point. Working downwards keeps each remaining
 * anchor above every insert already made, so both the row numbers and the grid
 * stay accurate for the rows that still matter.
 */
export function orderPayoutWritesBottomUp(plans: PayoutWritePlan[]): PayoutWritePlan[] {
  return [...plans].toSorted((left, right) => {
    const byRow = right.anchorRowNumber - left.anchorRowNumber;
    return byRow !== 0 ? byRow : left.lineId.localeCompare(right.lineId);
  });
}

/** Group by spreadsheet AND tab: one grid read covers exactly one tab. */
export function groupPayoutPlansBySheet(
  plans: PayoutWritePlan[],
): Map<string, PayoutWritePlan[]> {
  const grouped = new Map<string, PayoutWritePlan[]>();
  for (const plan of plans) {
    const key = `${plan.spreadsheetId}::${plan.sheetName}`;
    grouped.set(key, [...(grouped.get(key) ?? []), plan]);
  }
  return grouped;
}

export interface PayoutRunCoverage {
  eligibleSessions: number;
  readySessions: number;
  unavailableSessions: number;
  formDriftSessions: number;
  identityReviewSessions: number;
  pendingReviewDeductions: number;
  approvedDeductions: number;
  unmappedTutorKeys: string[];
  nullTutorKeyLines: number;
  blockingGlobalSourceIssues: number;
}

export interface PayoutPublishAcknowledgements {
  pendingReviewDeductions?: number;
  unavailableSessions?: number;
}

/** Above this share of unreconciled sessions the run under-reports deductions. */
const UNRECONCILED_BLOCK_RATIO = 0.02;

/**
 * Refuse to publish a run whose numbers cannot be trusted.
 *
 * Two kinds of gate. A blocking global source issue is absolute: it is the same
 * condition `revalidateDeductionCandidate` refuses to act under, and moving
 * money while source health is globally unproven is indefensible. The others
 * are overridable, but only by echoing back the exact count the operator was
 * shown — a stale tab must not be able to wave through a number that has grown
 * since it was rendered.
 */
export function assertPayoutRunPublishable(
  coverage: PayoutRunCoverage,
  acknowledgements: PayoutPublishAcknowledgements = {},
): void {
  if (coverage.blockingGlobalSourceIssues > 0) {
    throw new PostClassValidationError(
      `Source health is unproven (${coverage.blockingGlobalSourceIssues} open blocking issue`
      + `${coverage.blockingGlobalSourceIssues === 1 ? "" : "s"}). Resolve them before publishing.`,
    );
  }

  if (coverage.pendingReviewDeductions > 0
    && acknowledgements.pendingReviewDeductions !== coverage.pendingReviewDeductions) {
    throw new PostClassValidationError(
      `${coverage.pendingReviewDeductions} deduction`
      + `${coverage.pendingReviewDeductions === 1 ? " is" : "s are"} still awaiting review.`
      + " Decide them, or acknowledge the exact count to publish without them.",
    );
  }

  const unreconciledRatio = coverage.eligibleSessions > 0
    ? coverage.unavailableSessions / coverage.eligibleSessions
    : 0;
  if (unreconciledRatio > UNRECONCILED_BLOCK_RATIO
    && acknowledgements.unavailableSessions !== coverage.unavailableSessions) {
    throw new PostClassValidationError(
      `${coverage.unavailableSessions} of ${coverage.eligibleSessions} sessions in this window`
      + " have no trustworthy Wise evidence, so the deduction list is incomplete."
      + " Let reconciliation finish, or acknowledge the exact count to publish anyway.",
    );
  }
}

export interface PayoutRunCsvLine {
  canonicalTutorKey: string | null;
  tutorName: string | null;
  wiseSessionId: string | null;
  className: string | null;
  studentNames: string[];
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  deadlineAt: Date | null;
  tutorSubmittedAt: Date | null;
  amountMinor: number;
  currency: string;
  financeMonth: string | null;
  reason: string | null;
  spreadsheetId: string | null;
  sheetName: string | null;
  matchedRowNumber: number | null;
  insertedRowNumber: number | null;
  matchStatus: string;
  writeStatus: string;
  writeError: string | null;
  writtenAt: Date | null;
}

export interface PayoutRunCsvHeader {
  anchorMonth: string;
  windowStart: string;
  windowEnd: string;
}

interface PayoutCsvRow extends PayoutRunCsvLine, PayoutRunCsvHeader {}

// `csvValue` renders a raw Date as a UTC ISO string, which is the wrong instant
// to hand a Thai finance recipient, so every timestamp is pre-formatted.
const bangkok = (value: Date | null): string =>
  value ? formatBangkokDateTime(value) : "";

export const PAYOUT_CSV_COLUMNS: ReadonlyArray<CsvColumn<PayoutCsvRow>> = [
  { key: "anchorMonth", header: "Payout month", value: (row) => row.anchorMonth },
  { key: "windowStart", header: "Window start", value: (row) => row.windowStart },
  { key: "windowEnd", header: "Window end", value: (row) => row.windowEnd },
  { key: "tutorKey", header: "Tutor key", value: (row) => row.canonicalTutorKey ?? "" },
  { key: "tutorName", header: "Tutor", value: (row) => row.tutorName ?? "" },
  { key: "wiseSessionId", header: "Wise session", value: (row) => row.wiseSessionId ?? "" },
  { key: "className", header: "Class", value: (row) => row.className ?? "" },
  { key: "students", header: "Students", value: (row) => row.studentNames },
  { key: "scheduledStartAt", header: "Class start (Bangkok)", value: (row) => bangkok(row.scheduledStartAt) },
  { key: "scheduledEndAt", header: "Class end (Bangkok)", value: (row) => bangkok(row.scheduledEndAt) },
  { key: "deadlineAt", header: "Feedback deadline (Bangkok)", value: (row) => bangkok(row.deadlineAt) },
  { key: "tutorSubmittedAt", header: "Tutor submitted (Bangkok)", value: (row) => bangkok(row.tutorSubmittedAt) },
  { key: "amount", header: "Deduction", value: (row) => -Math.abs(row.amountMinor) / 100 },
  { key: "currency", header: "Currency", value: (row) => row.currency },
  { key: "financeMonth", header: "Finance month", value: (row) => row.financeMonth ?? "" },
  { key: "reason", header: "Reason", value: (row) => row.reason ?? "" },
  { key: "spreadsheetId", header: "Spreadsheet", value: (row) => row.spreadsheetId ?? "" },
  { key: "sheetName", header: "Tab", value: (row) => row.sheetName ?? "" },
  { key: "matchedRowNumber", header: "Matched row", value: (row) => row.matchedRowNumber ?? "" },
  { key: "insertedRowNumber", header: "Deduction row", value: (row) => row.insertedRowNumber ?? "" },
  { key: "matchStatus", header: "Match", value: (row) => row.matchStatus },
  { key: "writeStatus", header: "Write", value: (row) => row.writeStatus },
  { key: "writeError", header: "Write error", value: (row) => row.writeError ?? "" },
  { key: "writtenAt", header: "Written at (Bangkok)", value: (row) => bangkok(row.writtenAt) },
];

/**
 * The run's summary CSV.
 *
 * Every line appears, including the ones that were skipped or had no sheet:
 * "this tutor had nothing" and "this tutor's sheet was never mapped" are
 * different facts, and a finance summary that shows only successes would let
 * the second pass as the first.
 */
export function buildPayoutRunCsv(
  header: PayoutRunCsvHeader,
  lines: PayoutRunCsvLine[],
): string {
  const rows: PayoutCsvRow[] = lines.map((line) => ({ ...header, ...line }));
  return serializeCsv(rows, PAYOUT_CSV_COLUMNS);
}
