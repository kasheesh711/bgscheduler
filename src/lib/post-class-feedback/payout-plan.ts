import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { serializeCsv, type CsvColumn } from "@/lib/sales-dashboard/csv";

import { PostClassValidationError } from "./errors";
// ── Whether a payout run may publish, and what it reports ───────────────
//
// The publish gate, the per-line idempotency key, and the summary CSV. Nothing
// here touches the database, the network, or `server-only` — publishing moves
// money, and the parts that decide whether it may should be testable without
// faking anything.
//
// Which ledger row a deduction attaches to, and what the appended row says,
// live in `payout-master.ts`.

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
