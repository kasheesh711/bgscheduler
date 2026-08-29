import { createHash } from "node:crypto";

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
  generation?: number;
}): string {
  const base = `payout:${input.runId}:${input.deductionId}`;
  return (input.generation ?? 1) > 1 ? `${base}:g${input.generation}` : base;
}

/**
 * Stable business identity for a deduction's ledger line. `generation` covers
 * reinstatement (INC-260829 re-charge): a deduction whose original written row
 * was deliberately removed from the ledger may earn one fresh row, and that
 * row needs an identity the unique indexes accept. Generation 1 stays
 * byte-identical to the historical format.
 */
export function payoutDeductionSourceIdentity(deductionId: string, generation = 1): string {
  return generation > 1 ? `deduction:${deductionId}:g${generation}` : `deduction:${deductionId}`;
}

export function payoutAdjustmentSourceIdentity(adjustmentId: string): string {
  return `adjustment:${adjustmentId}`;
}

export function payoutAdjustmentIdempotencyKey(input: {
  deductionId: string;
  kind: "waiver" | "reversal";
  actionIdentity: string;
}): string {
  return `payout-adjustment:${input.kind}:${input.deductionId}:${input.actionIdentity}`;
}

export interface PayoutRunCoverage {
  /** Proven eligible sessions plus non-ready sessions whose eligibility is unproven. */
  eligibleSessions: number;
  /** Proven eligible sessions with trustworthy ready source evidence. */
  readySessions: number;
  /** Every in-window session whose source status is not `ready`, even if eligibility is unproven. */
  nonReadySessions: number;
  unavailableSessions: number;
  formDriftSessions: number;
  identityReviewSessions: number;
  pendingReviewDeductions: number;
  /** Approved deductions whose current eligibility/source proof is no longer trustworthy. */
  unprovenApprovedDeductions: number;
  approvedDeductions: number;
  unmappedTutorKeys: string[];
  nullTutorKeyLines: number;
  blockingGlobalSourceIssues: number;
}

export interface PayoutPublishAcknowledgements {
  confirmed: true;
  pendingReviewDeductions: number;
  nonReadySessions: number;
  /** Required for every operator-confirmed publication. */
  reason: string;
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
  acknowledgements: Partial<PayoutPublishAcknowledgements> = {},
): void {
  if (coverage.blockingGlobalSourceIssues > 0) {
    throw new PostClassValidationError(
      `Source health is unproven (${coverage.blockingGlobalSourceIssues} open blocking issue`
      + `${coverage.blockingGlobalSourceIssues === 1 ? "" : "s"}). Resolve them before publishing.`,
    );
  }

  if (coverage.unprovenApprovedDeductions > 0) {
    throw new PostClassValidationError(
      `${coverage.unprovenApprovedDeductions} approved deduction`
      + `${coverage.unprovenApprovedDeductions === 1 ? " no longer has" : "s no longer have"}`
      + " proven eligible, ready source evidence. Reconcile or review them before publishing.",
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
    ? coverage.nonReadySessions / coverage.eligibleSessions
    : 0;
  if (unreconciledRatio > UNRECONCILED_BLOCK_RATIO
    && acknowledgements.nonReadySessions !== coverage.nonReadySessions) {
    throw new PostClassValidationError(
      `${coverage.nonReadySessions} of ${coverage.eligibleSessions} sessions in this window`
      + " have no trustworthy Wise evidence, so the deduction list is incomplete."
      + " Let reconciliation finish, or acknowledge the exact count to publish anyway.",
    );
  }

  const acknowledgedIncompleteSet = acknowledgements.pendingReviewDeductions !== undefined
    || acknowledgements.nonReadySessions !== undefined;
  if (acknowledgedIncompleteSet && !acknowledgements.reason?.trim()) {
    throw new PostClassValidationError(
      "A reason is required when publishing with pending reviews or non-ready source data.",
    );
  }
}

export interface PayoutPreviewFingerprint {
  /** Enforcement policy version whose assessments produced this obligation set. */
  policyVersion: number;
  anchorMonth: string;
  windowStart: string;
  windowEnd: string;
  tutorFilter: string | null;
  runVersion: number | null;
  runStatus: string | null;
  coverage: PayoutRunCoverage;
  obligations: Array<{
    sourceIdentity: string;
    rowSignature: string;
    sessionId: string;
    wiseSessionId: string;
    amountMinor: number;
    currency: string;
    canonicalTutorKey: string | null;
    tutorName: string | null;
    className: string | null;
    studentNames: string[];
    scheduledStartAt: string;
    scheduledEndAt: string;
    deadlineAt: string;
    tutorSubmittedAt: string | null;
    financeMonth: string | null;
    reason: string;
    mappingIdentity: string | null;
  }>;
  adjustments: Array<{
    sourceIdentity: string;
    rowSignature: string;
    amountMinor: number;
    status: string;
  }>;
}

/**
 * Deterministic optimistic-concurrency token for a read-only preview.
 *
 * Publish recomputes the same source snapshot under the finance lock before it
 * creates a run or acquires a lease. Any approval, source-health, adjustment,
 * mapping, or prior-run change therefore makes a stale preview fail closed.
 */
export function payoutPreviewToken(input: PayoutPreviewFingerprint): string {
  const canonical = {
    ...input,
    coverage: {
      ...input.coverage,
      unmappedTutorKeys: [...input.coverage.unmappedTutorKeys].toSorted(),
    },
    obligations: input.obligations
      .map((obligation) => ({
        ...obligation,
        studentNames: [...obligation.studentNames].toSorted(),
      }))
      .toSorted((left, right) =>
        left.sourceIdentity.localeCompare(right.sourceIdentity)),
    adjustments: [...input.adjustments].toSorted((left, right) =>
      left.sourceIdentity.localeCompare(right.sourceIdentity)),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return `payout-preview:v1:${digest}`;
}

/**
 * Fingerprint only the finance/source obligation set held across an external
 * publish. Run lifecycle fields and adjustment write outcomes are expected to
 * change during that pass, so they are normalized while every input which can
 * add, remove, match, or price a row remains covered by the same canonicalizer.
 */
export function payoutSourceFingerprint(input: PayoutPreviewFingerprint): string {
  return payoutPreviewToken({
    ...input,
    runVersion: null,
    runStatus: null,
    coverage: {
      ...input.coverage,
      // A verified row remains a material source obligation after finance
      // moves its deduction from approved to processed/waived/reversed.
      approvedDeductions: input.obligations.length,
    },
    adjustments: input.adjustments.map((adjustment) => ({
      ...adjustment,
      status: "obligation",
    })),
  }).replace("payout-preview:v1:", "payout-source:v1:");
}

export interface PayoutRunCsvLine {
  lineKind?: "deduction" | "correction";
  sourceIdentity?: string | null;
  rowSignature?: string | null;
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
  { key: "lineKind", header: "Line kind", value: (row) => row.lineKind ?? "deduction" },
  { key: "sourceIdentity", header: "Source identity", value: (row) => row.sourceIdentity ?? "" },
  { key: "rowSignature", header: "Row signature", value: (row) => row.rowSignature ?? "" },
  { key: "tutorKey", header: "Tutor key", value: (row) => row.canonicalTutorKey ?? "" },
  { key: "tutorName", header: "Tutor", value: (row) => row.tutorName ?? "" },
  { key: "wiseSessionId", header: "Wise session", value: (row) => row.wiseSessionId ?? "" },
  { key: "className", header: "Class", value: (row) => row.className ?? "" },
  { key: "students", header: "Students", value: (row) => row.studentNames },
  { key: "scheduledStartAt", header: "Class start (Bangkok)", value: (row) => bangkok(row.scheduledStartAt) },
  { key: "scheduledEndAt", header: "Class end (Bangkok)", value: (row) => bangkok(row.scheduledEndAt) },
  { key: "deadlineAt", header: "Feedback deadline (Bangkok)", value: (row) => bangkok(row.deadlineAt) },
  { key: "tutorSubmittedAt", header: "Tutor submitted (Bangkok)", value: (row) => bangkok(row.tutorSubmittedAt) },
  { key: "amount", header: "Signed amount", value: (row) => row.amountMinor / 100 },
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
