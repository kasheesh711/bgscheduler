import {
  FIFO_PACKAGE_MODEL,
  FIFO_PACKAGE_MODEL_V1,
  FIFO_PACKAGE_MODEL_V2,
  LEGACY_ACCOUNT_MODEL,
  type UnearnedRevenueCanonicalModel,
  type UnearnedRevenueLotKind,
  type UnearnedRevenueMatchConfidence,
  type UnearnedRevenueMatchStatus,
  type UnearnedRevenuePeriodKind,
  type UnearnedRevenueReviewState,
} from "./types";

export const WORKBOOK_LIMITS = {
  status: 200,
  qa: 200,
  periods: 500,
  exactPackages: 500,
  students: 20_000,
  accounts: 20_000,
  receipts: 10_000,
  lots: 100_000,
} as const;

const FORMULA_ERRORS = ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!"];
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

export class UnearnedRevenueWorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnearnedRevenueWorkbookError";
  }
}

export interface ParsedWorkbookStatus {
  workbookSchemaVersion: number;
  sourceRunId: string;
  sourceFingerprint: string;
  sourceRevision: string;
  cutoff: string;
  generatedAtBangkok: string;
  canonicalModel: UnearnedRevenueCanonicalModel;
  modelVersion: string;
  modelMode: "CANONICAL" | "SHADOW";
  reviewConditions: string[];
  compositeVerifiedCount?: number;
  receiptCandidateCount?: number;
  reversalConflictCount?: number;
  missingReceiptEvidenceCount?: number;
  automaticExactLiabilityThb?: string;
  financeReviewedLiabilityThb?: string;
}

export interface ParsedWorkbookPeriod {
  periodEnd: string;
  periodKind: UnearnedRevenuePeriodKind;
  isLatest: boolean;
  openingLiabilityThb: string;
  deferredNewLiabilityThb: string;
  recognizedRevenueThb: string;
  closingLiabilityThb: string;
  legacyClosingLiabilityThb: string;
  fifoClosingLiabilityThb: string;
  fifoVsLegacyDifferenceThb: string;
  remainingPaidCredits: string;
  attributedLiabilityThb: string;
  residualLiabilityThb: string;
  attributionPercent: string;
  studentCount: number;
  accountCount: number;
  ambiguousCount: number;
  unattributedCount: number;
  fallbackValuedCount: number;
  negativeBalanceCount: number;
  apiVarianceCount: number;
  compositeVerifiedCount?: number;
  receiptCandidateCount?: number;
  reversalConflictCount?: number;
  missingReceiptEvidenceCount?: number;
  sourceRow: number;
}

export interface ParsedWorkbookStudent {
  periodEnd: string;
  periodKind: UnearnedRevenuePeriodKind;
  isLatest: boolean;
  studentId: string;
  studentName: string;
  parentName: string;
  accountCount: number;
  ledgerRemainingCredits: string;
  remainingPaidCredits: string;
  legacyClosingLiabilityThb: string;
  fifoOpeningLiabilityThb: string;
  fifoDeferredNewLiabilityThb: string;
  fifoRecognizedRevenueThb: string;
  fifoClosingLiabilityThb: string;
  canonicalClosingLiabilityThb: string;
  attributedLiabilityThb: string;
  residualLiabilityThb: string;
  attributionPercent: string;
  reviewState: UnearnedRevenueReviewState;
  sourceRow: number;
}

export interface ParsedWorkbookAccount {
  periodEnd: string;
  accountId: string;
  studentId: string;
  classId: string;
  studentName: string;
  className: string;
  classSubject: string;
  ledgerRemainingCredits: string;
  openingPaidCredits: string;
  deferredPaidCredits: string;
  recognizedPaidCredits: string;
  closingPaidCredits: string;
  lotClosingAllCredits: string;
  legacyClosingLiabilityThb: string;
  fifoOpeningLiabilityThb: string;
  fifoDeferredNewLiabilityThb: string;
  fifoRecognizedRevenueThb: string;
  fifoClosingLiabilityThb: string;
  canonicalClosingLiabilityThb: string;
  attributedLiabilityThb: string;
  residualLiabilityThb: string;
  reviewState: UnearnedRevenueReviewState;
  sourceRow: number;
}

export interface ParsedWorkbookLot {
  periodEnd: string;
  lotId: string;
  accountId: string;
  studentId: string;
  classId: string;
  studentName: string;
  className: string;
  lotKind: UnearnedRevenueLotKind;
  matchStatus: UnearnedRevenueMatchStatus;
  matchConfidence?: UnearnedRevenueMatchConfidence;
  matchRuleId?: string;
  matchEvidence?: Record<string, unknown>;
  reviewState: UnearnedRevenueReviewState;
  packageName: string;
  transactionNumber: string;
  salesKey: string;
  transactionDate: string | null;
  creditEventKey: string;
  originalCredits: string;
  packageCredits: string;
  negativeRecoveryCredits: string;
  openingCredits: string;
  deferredCredits: string;
  recognizedCredits: string;
  remainingCredits: string;
  unitRateThb: string;
  netPaymentThb: string;
  openingLiabilityThb: string;
  deferredNewLiabilityThb: string;
  recognizedRevenueThb: string;
  closingLiabilityThb: string;
  candidateSalesKeys: string;
  candidateReceiptIds?: string;
  sourceSpreadsheetId: string | null;
  sourceSheetId: number | null;
  sourceRow: number | null;
  creditEventSpreadsheetId?: string | null;
  creditEventSheetId?: number | null;
  creditEventRow?: number | null;
  receiptId?: string;
  receiptType?: string;
  receiptStatus?: string;
  receiptChargedAt?: string | null;
  receiptAmountThb?: string;
  receiptCurrency?: string;
  receiptNote?: string;
  receiptStudentId?: string;
  receiptClassId?: string;
  receiptSourceRow?: number | null;
  formulaRow: number;
}

export interface ParsedWorkbookExactPackage {
  periodEnd: string;
  periodKind: UnearnedRevenuePeriodKind;
  isLatest: boolean;
  packageName: string;
  openingLiabilityThb: string;
  deferredNewLiabilityThb: string;
  recognizedRevenueThb: string;
  automaticExactLiabilityThb: string;
  financeReviewedLiabilityThb: string;
  closingExactLiabilityThb: string;
  remainingCredits: string;
  studentCount: number;
  accountCount: number;
  activeLotCount: number;
  shareOfExactLiability: string;
  sourceRow: number;
}

export interface ParsedWorkbookContract {
  status: ParsedWorkbookStatus;
  periods: ParsedWorkbookPeriod[];
  students: ParsedWorkbookStudent[];
  accounts: ParsedWorkbookAccount[];
  lots: ParsedWorkbookLot[];
  exactPackages: ParsedWorkbookExactPackage[];
  rowCounts: Record<string, number>;
}

interface WorkbookParseInput {
  statusStart: unknown[][];
  statusEnd: unknown[][];
  qa: unknown[][];
  periods: unknown[][];
  periodFormulas: unknown[][];
  students: unknown[][];
  studentFormulas: unknown[][];
  accounts: unknown[][];
  accountFormulas: unknown[][];
  lots: unknown[][];
  lotFormulas: unknown[][];
  receipts?: unknown[][];
  exactPackages?: unknown[][];
  exactPackageFormulas?: unknown[][];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numberValue(value: unknown, label: string): number {
  const result = typeof value === "number" ? value : Number(text(value).replaceAll(",", ""));
  if (!Number.isFinite(result)) throw new UnearnedRevenueWorkbookError(`${label} must be numeric`);
  return result;
}

function numeric(value: unknown, label: string): string {
  return numberValue(value, label).toFixed(8);
}

function integer(value: unknown, label: string): number {
  const result = numberValue(value, label);
  if (!Number.isSafeInteger(result)) throw new UnearnedRevenueWorkbookError(`${label} must be an integer`);
  return result;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(text(value).toLowerCase());
}

export function googleSheetDate(value: unknown, label: string): string {
  const serial = typeof value === "number"
    ? value
    : /^\d+(?:\.\d+)?$/.test(text(value)) ? Number(text(value)) : null;
  if (serial !== null) {
    if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) {
      throw new UnearnedRevenueWorkbookError(`${label} is not a valid date`);
    }
    return new Date(EXCEL_EPOCH_UTC + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
  }
  const raw = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new UnearnedRevenueWorkbookError(`${label} is not a valid ISO date`);
  }
  return raw;
}

function optionalDate(value: unknown, label: string): string | null {
  return text(value) ? googleSheetDate(value, label) : null;
}

function optionalInteger(value: unknown, label: string): number | null {
  return text(value) ? integer(value, label) : null;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!text(value)) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed: unknown = JSON.parse(text(value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to a contract error with the field name.
  }
  throw new UnearnedRevenueWorkbookError(`${label} must be a JSON object`);
}

function assertNoFormulaError(rows: unknown[][], label: string): void {
  for (const row of rows) {
    for (const cell of row) {
      const value = text(cell);
      if (FORMULA_ERRORS.some((formulaError) => value.includes(formulaError))) {
        throw new UnearnedRevenueWorkbookError(`${label} contains formula error ${value}`);
      }
    }
  }
}

function table(rows: unknown[][], label: string, limit: number, required: readonly string[]) {
  if (rows.length === 0) throw new UnearnedRevenueWorkbookError(`${label} is empty`);
  if (rows.length - 1 > limit) {
    throw new UnearnedRevenueWorkbookError(`${label} exceeds ${limit.toLocaleString()} data rows`);
  }
  const headers = rows[0].map(text);
  if (new Set(headers).size !== headers.length) {
    throw new UnearnedRevenueWorkbookError(`${label} contains duplicate headers`);
  }
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new UnearnedRevenueWorkbookError(`${label} is missing headers: ${missing.join(", ")}`);
  }
  const records = rows.slice(1)
    .map((row, index) => ({ row, sourceRow: index + 2 }))
    .filter(({ row }) => row.some((cell) => text(cell)));
  return {
    headers,
    records,
    get(row: unknown[], header: string): unknown {
      return row[headers.indexOf(header)];
    },
  };
}

function statusMap(rows: unknown[][]): Map<string, string> {
  const parsed = table(rows, "Model Status", WORKBOOK_LIMITS.status, ["field", "value"]);
  return new Map(parsed.records.map(({ row }) => [text(parsed.get(row, "field")), text(parsed.get(row, "value"))]));
}

const STATUS_CONSISTENCY_FIELDS = [
  "workbook_schema_version",
  "model_status",
  "publication_status",
  "published_cutoff",
  "run_id",
  "source_fingerprint",
  "publication_revision",
  "generated_at_bangkok",
  "canonical_model",
  "candidate_model_version",
  "model_mode",
  "hard_qa_status",
] as const;

function requiredStatus(status: Map<string, string>, field: string): string {
  const value = status.get(field) ?? "";
  if (!value) throw new UnearnedRevenueWorkbookError(`Model Status is missing ${field}`);
  return value;
}

function parseStatus(startRows: unknown[][], endRows: unknown[][]): ParsedWorkbookStatus {
  const start = statusMap(startRows);
  const end = statusMap(endRows);
  const observedFields = new Set([...start.keys(), ...end.keys()]);
  for (const field of observedFields) {
    if ((start.get(field) ?? "") !== (end.get(field) ?? "")) {
      throw new UnearnedRevenueWorkbookError(`Model Status changed during import (${field})`);
    }
  }
  for (const field of STATUS_CONSISTENCY_FIELDS) {
    if (requiredStatus(start, field) !== requiredStatus(end, field)) {
      throw new UnearnedRevenueWorkbookError(`Model Status changed during import (${field})`);
    }
  }
  if (requiredStatus(start, "model_status") !== "PUBLISHED"
    || requiredStatus(start, "publication_status") !== "PUBLISHED"
    || requiredStatus(start, "hard_qa_status") !== "PASS") {
    throw new UnearnedRevenueWorkbookError("Workbook is not in a QA-passed PUBLISHED state");
  }
  const schemaVersion = integer(requiredStatus(start, "workbook_schema_version"), "workbook_schema_version");
  if (![2, 3, 4].includes(schemaVersion)) {
    throw new UnearnedRevenueWorkbookError(`Unsupported workbook schema version ${schemaVersion}`);
  }
  const canonicalRaw = requiredStatus(start, "canonical_model");
  if (canonicalRaw !== LEGACY_ACCOUNT_MODEL
    && canonicalRaw !== FIFO_PACKAGE_MODEL_V1
    && canonicalRaw !== FIFO_PACKAGE_MODEL_V2
    && canonicalRaw !== FIFO_PACKAGE_MODEL) {
    throw new UnearnedRevenueWorkbookError(`Unsupported canonical model ${canonicalRaw}`);
  }
  const modelMode = requiredStatus(start, "model_mode");
  if (modelMode !== "CANONICAL" && modelMode !== "SHADOW") {
    throw new UnearnedRevenueWorkbookError(`Unsupported model mode ${modelMode}`);
  }
  const modelVersion = requiredStatus(start, "candidate_model_version");
  if (schemaVersion === 3 && modelVersion !== FIFO_PACKAGE_MODEL_V2) {
    throw new UnearnedRevenueWorkbookError(
      `Workbook schema V3 must use candidate model ${FIFO_PACKAGE_MODEL_V2}`,
    );
  }
  if (schemaVersion === 4 && modelVersion !== FIFO_PACKAGE_MODEL) {
    throw new UnearnedRevenueWorkbookError(
      `Workbook schema V4 must use candidate model ${FIFO_PACKAGE_MODEL}`,
    );
  }
  if (canonicalRaw !== LEGACY_ACCOUNT_MODEL && modelVersion !== canonicalRaw) {
    throw new UnearnedRevenueWorkbookError("Canonical FIFO version does not match the runtime model version");
  }
  return {
    workbookSchemaVersion: schemaVersion,
    sourceRunId: requiredStatus(start, "run_id"),
    sourceFingerprint: requiredStatus(start, "source_fingerprint"),
    sourceRevision: requiredStatus(start, "publication_revision"),
    cutoff: googleSheetDate(requiredStatus(start, "published_cutoff"), "published_cutoff"),
    generatedAtBangkok: requiredStatus(start, "generated_at_bangkok"),
    canonicalModel: canonicalRaw as UnearnedRevenueCanonicalModel,
    modelVersion,
    modelMode,
    reviewConditions: (start.get("review_conditions") ?? "")
      .split(";").map((item) => item.trim()).filter((item) => item && item !== "NONE"),
    compositeVerifiedCount: Number(start.get("composite_verified_event_count") ?? 0) || 0,
    receiptCandidateCount: Number(start.get("receipt_candidate_event_count") ?? 0) || 0,
    reversalConflictCount: Number(start.get("reversal_conflict_count") ?? 0) || 0,
    missingReceiptEvidenceCount: Number(start.get("missing_receipt_evidence_count") ?? 0) || 0,
    automaticExactLiabilityThb: numeric(
      start.get("automatic_exact_liability_thb") ?? 0,
      "automatic_exact_liability_thb",
    ),
    financeReviewedLiabilityThb: numeric(
      start.get("finance_reviewed_liability_thb") ?? 0,
      "finance_reviewed_liability_thb",
    ),
  };
}

function assertQa(qaRows: unknown[][]): void {
  const qa = table(qaRows, "QA Checks", WORKBOOK_LIMITS.qa, ["check_id", "severity", "status"]);
  const hardRows = qa.records.filter(({ row }) => text(qa.get(row, "severity")) === "HARD");
  if (hardRows.length === 0) throw new UnearnedRevenueWorkbookError("QA Checks contains no hard checks");
  const failures = hardRows
    .filter(({ row }) => text(qa.get(row, "status")) !== "PASS")
    .map(({ row }) => text(qa.get(row, "check_id")));
  if (failures.length > 0) throw new UnearnedRevenueWorkbookError(`Hard workbook QA failed: ${failures.join(", ")}`);
}

function formulaCell(formulaRows: unknown[][], sourceRow: number, columnIndex: number, label: string): void {
  const value = text(formulaRows[sourceRow - 1]?.[columnIndex]);
  if (!value.startsWith("=")) {
    throw new UnearnedRevenueWorkbookError(`${label} row ${sourceRow} is not backed by a formula`);
  }
}

function assertLineage(
  actualRun: unknown,
  actualFingerprint: unknown,
  status: ParsedWorkbookStatus,
  label: string,
  row: number,
): void {
  if (text(actualRun) !== status.sourceRunId || text(actualFingerprint) !== status.sourceFingerprint) {
    throw new UnearnedRevenueWorkbookError(`${label} row ${row} belongs to a different output run`);
  }
}

function periodKind(value: unknown, label: string): UnearnedRevenuePeriodKind {
  const result = text(value);
  if (result !== "MONTH_END" && result !== "LATEST") {
    throw new UnearnedRevenueWorkbookError(`${label} has invalid period_kind`);
  }
  return result;
}

function reviewState(value: unknown, label: string): UnearnedRevenueReviewState {
  const result = text(value);
  if (!["NO_REVIEW", "NEEDS_REVIEW", "REVIEWED", "REVIEWED_RESIDUAL"].includes(result)) {
    throw new UnearnedRevenueWorkbookError(`${label} has invalid review_state`);
  }
  return result as UnearnedRevenueReviewState;
}

function lotKind(value: unknown, label: string): UnearnedRevenueLotKind {
  const result = text(value);
  if (!["OPENING", "PAID_PACKAGE", "COMPLIMENTARY", "COMPOSITE_CANDIDATE", "AMBIGUOUS", "UNATTRIBUTED"].includes(result)) {
    throw new UnearnedRevenueWorkbookError(`${label} has invalid lot_kind`);
  }
  return result as UnearnedRevenueLotKind;
}

function matchStatus(value: unknown, label: string): UnearnedRevenueMatchStatus {
  const result = text(value);
  if (!["FROZEN_OPENING", "EXACT_TRANSACTION", "UNIQUE_HEURISTIC", "RECEIPT_IDENTIFIER_CHAIN", "COMPOSITE_VERIFIED", "COMPOSITE_CANDIDATE", "OVERRIDE", "COMPLIMENTARY_MATCH", "AMBIGUOUS", "UNATTRIBUTED"].includes(result)) {
    throw new UnearnedRevenueWorkbookError(`${label} has invalid match_status`);
  }
  return result as UnearnedRevenueMatchStatus;
}

function matchConfidence(value: unknown, label: string): UnearnedRevenueMatchConfidence {
  const result = text(value);
  if (!["COMPOSITE_VERIFIED", "FINANCE_REVIEWED", "EXACT", "CANDIDATE", "RESIDUAL", "COMPLIMENTARY"].includes(result)) {
    throw new UnearnedRevenueWorkbookError(`${label} has invalid match_confidence`);
  }
  return result as UnearnedRevenueMatchConfidence;
}

const AUTOMATIC_EXACT_MATCH_STATUSES = new Set<UnearnedRevenueMatchStatus>([
  "EXACT_TRANSACTION",
  "RECEIPT_IDENTIFIER_CHAIN",
  "COMPOSITE_VERIFIED",
]);
const EXACT_MATCH_STATUSES = new Set<UnearnedRevenueMatchStatus>([
  ...AUTOMATIC_EXACT_MATCH_STATUSES,
  "OVERRIDE",
]);

function difference(left: string, right: string): number {
  return Math.abs(Number(left) - Number(right));
}

function monthEnd(value: string): string {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new UnearnedRevenueWorkbookError(`${label} contains duplicate keys`);
  }
}

function reviewCount(reviewConditions: string[], prefix: string): number {
  const item = reviewConditions.find((condition) => condition === prefix || condition.startsWith(`${prefix}:`));
  if (!item) return 0;
  const count = Number(item.split(":")[1]);
  return Number.isFinite(count) ? count : 1;
}

export function parseUnearnedRevenueWorkbook(input: WorkbookParseInput): ParsedWorkbookContract {
  for (const [label, rows] of Object.entries(input)) {
    if (Array.isArray(rows)) assertNoFormulaError(rows, label);
  }
  const status = parseStatus(input.statusStart, input.statusEnd);
  assertQa(input.qa);

  if (status.workbookSchemaVersion >= 3 && !input.receipts) {
    throw new UnearnedRevenueWorkbookError("Workbook schema V3/V4 is missing SRC_Wise_Receipt data");
  }
  const receiptRows = input.receipts ?? [[
    "receipt_id", "receipt_type", "receipt_status", "charged_at", "receipt_date",
    "created_at", "amount_minor", "amount_thb", "currency", "note", "student_id",
    "student_name", "class_id", "classroom_name", "classroom_subject", "parent_ids",
    "parent_names", "identifiers", "payload_checksum", "source_row", "output_run_id",
    "source_fingerprint",
  ]];
  const receiptTable = table(receiptRows, "SRC_Wise_Receipt", WORKBOOK_LIMITS.receipts, [
    "receipt_id", "receipt_type", "receipt_status", "charged_at", "receipt_date",
    "amount_thb", "currency", "note", "student_id", "class_id", "payload_checksum", "source_row",
    "output_run_id", "source_fingerprint",
  ]);
  const receiptEvidenceById = new Map<string, {
    sourceRow: number;
    type: string;
    status: string;
    chargedAt: string;
    amountThb: string;
    currency: string;
    note: string;
    studentId: string;
    classId: string;
  }>();
  for (const { row, sourceRow } of receiptTable.records) {
    assertLineage(
      receiptTable.get(row, "output_run_id"),
      receiptTable.get(row, "source_fingerprint"),
      status,
      "SRC_Wise_Receipt",
      sourceRow,
    );
    const receiptId = text(receiptTable.get(row, "receipt_id"));
    if (!receiptId) throw new UnearnedRevenueWorkbookError(`SRC_Wise_Receipt row ${sourceRow} has no receipt ID`);
    if (receiptEvidenceById.has(receiptId)) {
      throw new UnearnedRevenueWorkbookError(`SRC_Wise_Receipt contains duplicate receipt ID ${receiptId}`);
    }
    const declaredSourceRow = integer(receiptTable.get(row, "source_row"), `SRC_Wise_Receipt row ${sourceRow} source_row`);
    if (declaredSourceRow !== sourceRow) {
      throw new UnearnedRevenueWorkbookError(`SRC_Wise_Receipt row ${sourceRow} has an inconsistent source_row`);
    }
    const checksum = text(receiptTable.get(row, "payload_checksum"));
    if (!/^[a-f0-9]{64}$/i.test(checksum)) {
      throw new UnearnedRevenueWorkbookError(`SRC_Wise_Receipt row ${sourceRow} has an invalid payload checksum`);
    }
    const amountThb = numeric(
      receiptTable.get(row, "amount_thb"),
      `SRC_Wise_Receipt row ${sourceRow} amount_thb`,
    );
    const chargedAt = text(receiptTable.get(row, "charged_at"));
    if (chargedAt && Number.isNaN(new Date(chargedAt).getTime())) {
      throw new UnearnedRevenueWorkbookError(`SRC_Wise_Receipt row ${sourceRow} charged_at is invalid`);
    }
    receiptEvidenceById.set(receiptId, {
      sourceRow,
      type: text(receiptTable.get(row, "receipt_type")),
      status: text(receiptTable.get(row, "receipt_status")),
      chargedAt,
      amountThb,
      currency: text(receiptTable.get(row, "currency")),
      note: text(receiptTable.get(row, "note")),
      studentId: text(receiptTable.get(row, "student_id")),
      classId: text(receiptTable.get(row, "class_id")),
    });
  }

  const periodTable = table(input.periods, "Model Comparison", WORKBOOK_LIMITS.periods, [
    "period_end", "period_kind", "is_latest", "legacy_closing_liability_thb",
    "fifo_closing_liability_thb", "canonical_closing_liability_thb",
    "fifo_vs_legacy_difference_thb", "attributed_liability_thb", "residual_liability_thb",
    "attribution_percent", "canonical_model", "model_version", "student_count", "account_count",
    "remaining_paid_credits", "opening_liability_thb", "deferred_new_liability_thb",
    "recognized_revenue_thb", "identity_difference_thb", "output_run_id", "source_fingerprint",
  ]);
  const periods: ParsedWorkbookPeriod[] = periodTable.records.map(({ row, sourceRow }) => {
    for (const column of [3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 18]) {
      formulaCell(input.periodFormulas, sourceRow, column, "Model Comparison");
    }
    assertLineage(periodTable.get(row, "output_run_id"), periodTable.get(row, "source_fingerprint"), status, "Model Comparison", sourceRow);
    if (text(periodTable.get(row, "canonical_model")) !== status.canonicalModel
      || text(periodTable.get(row, "model_version")) !== status.modelVersion) {
      throw new UnearnedRevenueWorkbookError(`Model Comparison row ${sourceRow} has inconsistent model metadata`);
    }
    const identity = numberValue(periodTable.get(row, "identity_difference_thb"), `Model Comparison row ${sourceRow} identity`);
    if (Math.abs(identity) > 1) throw new UnearnedRevenueWorkbookError(`Model Comparison row ${sourceRow} does not roll forward`);
    return {
      periodEnd: googleSheetDate(periodTable.get(row, "period_end"), `Model Comparison row ${sourceRow} period_end`),
      periodKind: periodKind(periodTable.get(row, "period_kind"), `Model Comparison row ${sourceRow}`),
      isLatest: booleanValue(periodTable.get(row, "is_latest")),
      openingLiabilityThb: numeric(periodTable.get(row, "opening_liability_thb"), "opening_liability_thb"),
      deferredNewLiabilityThb: numeric(periodTable.get(row, "deferred_new_liability_thb"), "deferred_new_liability_thb"),
      recognizedRevenueThb: numeric(periodTable.get(row, "recognized_revenue_thb"), "recognized_revenue_thb"),
      closingLiabilityThb: numeric(periodTable.get(row, "canonical_closing_liability_thb"), "canonical_closing_liability_thb"),
      legacyClosingLiabilityThb: numeric(periodTable.get(row, "legacy_closing_liability_thb"), "legacy_closing_liability_thb"),
      fifoClosingLiabilityThb: numeric(periodTable.get(row, "fifo_closing_liability_thb"), "fifo_closing_liability_thb"),
      fifoVsLegacyDifferenceThb: numeric(periodTable.get(row, "fifo_vs_legacy_difference_thb"), "fifo_vs_legacy_difference_thb"),
      remainingPaidCredits: numeric(periodTable.get(row, "remaining_paid_credits"), "remaining_paid_credits"),
      attributedLiabilityThb: numeric(periodTable.get(row, "attributed_liability_thb"), "attributed_liability_thb"),
      residualLiabilityThb: numeric(periodTable.get(row, "residual_liability_thb"), "residual_liability_thb"),
      attributionPercent: numeric(periodTable.get(row, "attribution_percent"), "attribution_percent"),
      studentCount: integer(periodTable.get(row, "student_count"), "student_count"),
      accountCount: integer(periodTable.get(row, "account_count"), "account_count"),
      ambiguousCount: 0,
      unattributedCount: 0,
      fallbackValuedCount: 0,
      negativeBalanceCount: 0,
      apiVarianceCount: reviewCount(status.reviewConditions, "API_VARIANCE"),
      compositeVerifiedCount: 0,
      receiptCandidateCount: 0,
      reversalConflictCount: reviewCount(status.reviewConditions, "RECEIPT_REVERSAL_CONFLICT"),
      missingReceiptEvidenceCount: reviewCount(status.reviewConditions, "MISSING_RECEIPT_EVIDENCE"),
      sourceRow,
    };
  });

  const studentTable = table(input.students, "CALC_Student_Period", WORKBOOK_LIMITS.students, [
    "period_end", "period_kind", "is_latest", "student_id", "student_name", "parent_name",
    "account_count", "ledger_remaining_credits", "closing_paid_credits",
    "legacy_closing_liability_thb", "fifo_opening_liability_thb",
    "fifo_deferred_new_liability_thb", "fifo_recognized_revenue_thb",
    "fifo_closing_liability_thb", "canonical_closing_liability_thb",
    "attributed_liability_thb", "residual_liability_thb", "attribution_percent",
    "review_state", "canonical_model", "model_version", "output_run_id", "source_fingerprint",
  ]);
  const students: ParsedWorkbookStudent[] = studentTable.records.map(({ row, sourceRow }) => {
    for (let column = 7; column <= 17; column += 1) {
      formulaCell(input.studentFormulas, sourceRow, column, "CALC_Student_Period");
    }
    assertLineage(studentTable.get(row, "output_run_id"), studentTable.get(row, "source_fingerprint"), status, "CALC_Student_Period", sourceRow);
    if (text(studentTable.get(row, "canonical_model")) !== status.canonicalModel
      || text(studentTable.get(row, "model_version")) !== status.modelVersion) {
      throw new UnearnedRevenueWorkbookError(`Student row ${sourceRow} has inconsistent model metadata`);
    }
    if (!text(studentTable.get(row, "student_id"))) throw new UnearnedRevenueWorkbookError(`Student row ${sourceRow} has no stable student ID`);
    return {
      periodEnd: googleSheetDate(studentTable.get(row, "period_end"), `Student row ${sourceRow} period_end`),
      periodKind: periodKind(studentTable.get(row, "period_kind"), `Student row ${sourceRow}`),
      isLatest: booleanValue(studentTable.get(row, "is_latest")),
      studentId: text(studentTable.get(row, "student_id")),
      studentName: text(studentTable.get(row, "student_name")),
      parentName: text(studentTable.get(row, "parent_name")),
      accountCount: integer(studentTable.get(row, "account_count"), "account_count"),
      ledgerRemainingCredits: numeric(studentTable.get(row, "ledger_remaining_credits"), "ledger_remaining_credits"),
      remainingPaidCredits: numeric(studentTable.get(row, "closing_paid_credits"), "closing_paid_credits"),
      legacyClosingLiabilityThb: numeric(studentTable.get(row, "legacy_closing_liability_thb"), "legacy_closing_liability_thb"),
      fifoOpeningLiabilityThb: numeric(studentTable.get(row, "fifo_opening_liability_thb"), "fifo_opening_liability_thb"),
      fifoDeferredNewLiabilityThb: numeric(studentTable.get(row, "fifo_deferred_new_liability_thb"), "fifo_deferred_new_liability_thb"),
      fifoRecognizedRevenueThb: numeric(studentTable.get(row, "fifo_recognized_revenue_thb"), "fifo_recognized_revenue_thb"),
      fifoClosingLiabilityThb: numeric(studentTable.get(row, "fifo_closing_liability_thb"), "fifo_closing_liability_thb"),
      canonicalClosingLiabilityThb: numeric(studentTable.get(row, "canonical_closing_liability_thb"), "canonical_closing_liability_thb"),
      attributedLiabilityThb: numeric(studentTable.get(row, "attributed_liability_thb"), "attributed_liability_thb"),
      residualLiabilityThb: numeric(studentTable.get(row, "residual_liability_thb"), "residual_liability_thb"),
      attributionPercent: numeric(studentTable.get(row, "attribution_percent"), "attribution_percent"),
      reviewState: reviewState(studentTable.get(row, "review_state"), `Student row ${sourceRow}`),
      sourceRow,
    };
  });

  const accountTable = table(input.accounts, "CALC_Account_Period", WORKBOOK_LIMITS.accounts, [
    "period_end", "account_id", "student_id", "class_id", "student_name", "class_name", "class_subject",
    "ledger_remaining_credits", "opening_paid_credits", "deferred_paid_credits", "recognized_paid_credits",
    "closing_paid_credits", "legacy_closing_liability_thb", "fifo_opening_liability_thb",
    "fifo_deferred_new_liability_thb", "fifo_recognized_revenue_thb", "fifo_closing_liability_thb",
    "canonical_closing_liability_thb", "attributed_liability_thb", "residual_liability_thb",
    "review_state", "identity_difference_thb", "output_run_id", "source_fingerprint", "lot_closing_all_credits",
  ]);
  const accounts: ParsedWorkbookAccount[] = accountTable.records.map(({ row, sourceRow }) => {
    for (const column of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 24, 28]) {
      formulaCell(input.accountFormulas, sourceRow, column, "CALC_Account_Period");
    }
    assertLineage(accountTable.get(row, "output_run_id"), accountTable.get(row, "source_fingerprint"), status, "CALC_Account_Period", sourceRow);
    if (!text(accountTable.get(row, "account_id")) || !text(accountTable.get(row, "student_id"))) {
      throw new UnearnedRevenueWorkbookError(`Account row ${sourceRow} is missing its stable account/student key`);
    }
    const identity = numberValue(accountTable.get(row, "identity_difference_thb"), `Account row ${sourceRow} identity`);
    if (Math.abs(identity) > 1) throw new UnearnedRevenueWorkbookError(`Account row ${sourceRow} does not roll forward`);
    const ledger = numeric(accountTable.get(row, "ledger_remaining_credits"), "ledger_remaining_credits");
    const allLotCredits = numeric(accountTable.get(row, "lot_closing_all_credits"), "lot_closing_all_credits");
    if (difference(allLotCredits, Math.max(0, Number(ledger)).toFixed(8)) > 0.001) {
      throw new UnearnedRevenueWorkbookError(`Account row ${sourceRow} does not reconcile to ledger credits`);
    }
    return {
      periodEnd: googleSheetDate(accountTable.get(row, "period_end"), `Account row ${sourceRow} period_end`),
      accountId: text(accountTable.get(row, "account_id")),
      studentId: text(accountTable.get(row, "student_id")),
      classId: text(accountTable.get(row, "class_id")),
      studentName: text(accountTable.get(row, "student_name")),
      className: text(accountTable.get(row, "class_name")),
      classSubject: text(accountTable.get(row, "class_subject")),
      ledgerRemainingCredits: ledger,
      openingPaidCredits: numeric(accountTable.get(row, "opening_paid_credits"), "opening_paid_credits"),
      deferredPaidCredits: numeric(accountTable.get(row, "deferred_paid_credits"), "deferred_paid_credits"),
      recognizedPaidCredits: numeric(accountTable.get(row, "recognized_paid_credits"), "recognized_paid_credits"),
      closingPaidCredits: numeric(accountTable.get(row, "closing_paid_credits"), "closing_paid_credits"),
      lotClosingAllCredits: allLotCredits,
      legacyClosingLiabilityThb: numeric(accountTable.get(row, "legacy_closing_liability_thb"), "legacy_closing_liability_thb"),
      fifoOpeningLiabilityThb: numeric(accountTable.get(row, "fifo_opening_liability_thb"), "fifo_opening_liability_thb"),
      fifoDeferredNewLiabilityThb: numeric(accountTable.get(row, "fifo_deferred_new_liability_thb"), "fifo_deferred_new_liability_thb"),
      fifoRecognizedRevenueThb: numeric(accountTable.get(row, "fifo_recognized_revenue_thb"), "fifo_recognized_revenue_thb"),
      fifoClosingLiabilityThb: numeric(accountTable.get(row, "fifo_closing_liability_thb"), "fifo_closing_liability_thb"),
      canonicalClosingLiabilityThb: numeric(accountTable.get(row, "canonical_closing_liability_thb"), "canonical_closing_liability_thb"),
      attributedLiabilityThb: numeric(accountTable.get(row, "attributed_liability_thb"), "attributed_liability_thb"),
      residualLiabilityThb: numeric(accountTable.get(row, "residual_liability_thb"), "residual_liability_thb"),
      reviewState: reviewState(accountTable.get(row, "review_state"), `Account row ${sourceRow}`),
      sourceRow,
    };
  });

  const lotRequired = [
    "period_end", "lot_id", "account_id", "student_id", "class_id", "student_name", "class_name",
    "lot_kind", "match_status", "review_state", "package_name", "sales_key", "transaction_date",
    "credit_event_key", "original_credits", "negative_recovery_credits", "opening_paid_credits",
    "deferred_paid_credits", "recognized_paid_credits", "closing_paid_credits", "unit_rate_thb",
    "opening_liability_thb", "deferred_new_liability_thb", "recognized_revenue_thb",
    "closing_liability_thb", "identity_difference_thb", "source_file_id", "source_sheet_id", "source_row",
    "candidate_sales_keys", "transaction_number", "package_credits", "net_payment_thb",
    "output_run_id", "source_fingerprint",
  ];
  if (status.workbookSchemaVersion >= 3) {
    lotRequired.push(
      "match_confidence", "match_rule_id", "match_evidence", "candidate_receipt_ids",
      "sales_source_file_id", "sales_source_sheet_id", "sales_source_row",
      "credit_event_source_file_id", "credit_event_source_sheet_id", "credit_event_source_row",
      "receipt_id", "receipt_type", "receipt_status", "receipt_charged_at",
      "receipt_amount_thb", "receipt_currency", "receipt_note", "receipt_student_id",
      "receipt_class_id", "receipt_source_row",
    );
  }
  if (status.workbookSchemaVersion >= 4) {
    lotRequired.push(
      "formula_rule_ids", "payment_date", "matching_date", "matching_date_source",
      "sales_nickname_key", "wise_nickname_key", "nickname_match_state",
    );
  }
  const lotTable = table(input.lots, "CALC_Package_Lot_Period", WORKBOOK_LIMITS.lots, lotRequired);
  const lots: ParsedWorkbookLot[] = lotTable.records.map(({ row, sourceRow }) => {
    for (let column = 22; column <= 27; column += 1) {
      formulaCell(input.lotFormulas, sourceRow, column, "CALC_Package_Lot_Period");
    }
    assertLineage(lotTable.get(row, "output_run_id"), lotTable.get(row, "source_fingerprint"), status, "CALC_Package_Lot_Period", sourceRow);
    if (!text(lotTable.get(row, "lot_id"))
      || !text(lotTable.get(row, "account_id"))
      || !text(lotTable.get(row, "student_id"))) {
      throw new UnearnedRevenueWorkbookError(`Lot row ${sourceRow} is missing its stable hierarchy key`);
    }
    const identity = numberValue(lotTable.get(row, "identity_difference_thb"), `Lot row ${sourceRow} identity`);
    if (Math.abs(identity) > 1) throw new UnearnedRevenueWorkbookError(`Lot row ${sourceRow} does not roll forward`);
    const v3 = status.workbookSchemaVersion >= 3;
    const sourceSpreadsheet = text(lotTable.get(row, v3 ? "sales_source_file_id" : "source_file_id"));
    const sourceSheetRaw = lotTable.get(row, v3 ? "sales_source_sheet_id" : "source_sheet_id");
    const sourceRowRaw = lotTable.get(row, v3 ? "sales_source_row" : "source_row");
    const creditEventSpreadsheet = text(lotTable.get(row, "credit_event_source_file_id"));
    const receiptChargedAtRaw = text(lotTable.get(row, "receipt_charged_at"));
    if (receiptChargedAtRaw && Number.isNaN(new Date(receiptChargedAtRaw).getTime())) {
      throw new UnearnedRevenueWorkbookError(`Lot row ${sourceRow} receipt_charged_at is invalid`);
    }
    const parsedMatchStatus = matchStatus(
      lotTable.get(row, "match_status"),
      `Lot row ${sourceRow}`,
    );
    const parsedMatchEvidence = jsonObject(
      lotTable.get(row, "match_evidence"),
      `Lot row ${sourceRow} match_evidence`,
    );
    const salesKey = text(lotTable.get(row, "sales_key"));
    const packageName = text(lotTable.get(row, "package_name"));
    const rawNicknameState = text(lotTable.get(row, "nickname_match_state"));
    const rawSalesNickname = text(lotTable.get(row, "sales_nickname_key"));
    const rawWiseNickname = text(lotTable.get(row, "wise_nickname_key"));
    if (status.workbookSchemaVersion >= 4 && EXACT_MATCH_STATUSES.has(parsedMatchStatus)) {
      if (!packageName || !salesKey || !sourceSpreadsheet || sourceSheetRaw === ""
        || sourceRowRaw === "" || !text(lotTable.get(row, "formula_rule_ids"))) {
        throw new UnearnedRevenueWorkbookError(
          `Exact-package lot row ${sourceRow} is missing its package, sales, or formula trace`,
        );
      }
      if (AUTOMATIC_EXACT_MATCH_STATUSES.has(parsedMatchStatus)) {
        if (rawNicknameState !== "MATCH"
          || parsedMatchEvidence.nickname_match_state !== "MATCH"
          || rawSalesNickname !== text(parsedMatchEvidence.sales_nickname_key)
          || rawWiseNickname !== text(parsedMatchEvidence.wise_nickname_key)
          || !text(parsedMatchEvidence.sales_nickname_key)
          || !text(parsedMatchEvidence.wise_nickname_key)) {
          throw new UnearnedRevenueWorkbookError(
            `Automatic exact-package lot row ${sourceRow} lacks required identity evidence`,
          );
        }
      } else if (!text(parsedMatchEvidence.decision_id)
        || !text(parsedMatchEvidence.reviewer_email)) {
        throw new UnearnedRevenueWorkbookError(
          `Finance-reviewed exact-package lot row ${sourceRow} lacks override evidence`,
        );
      }
    }
    return {
      periodEnd: googleSheetDate(lotTable.get(row, "period_end"), `Lot row ${sourceRow} period_end`),
      lotId: text(lotTable.get(row, "lot_id")),
      accountId: text(lotTable.get(row, "account_id")),
      studentId: text(lotTable.get(row, "student_id")),
      classId: text(lotTable.get(row, "class_id")),
      studentName: text(lotTable.get(row, "student_name")),
      className: text(lotTable.get(row, "class_name")),
      lotKind: lotKind(lotTable.get(row, "lot_kind"), `Lot row ${sourceRow}`),
      matchStatus: parsedMatchStatus,
      matchConfidence: matchConfidence(
        text(lotTable.get(row, "match_confidence")) || (
          text(lotTable.get(row, "match_status")) === "OVERRIDE" ? "FINANCE_REVIEWED"
            : text(lotTable.get(row, "match_status")) === "EXACT_TRANSACTION" ? "EXACT"
              : ["AMBIGUOUS", "UNATTRIBUTED", "FROZEN_OPENING"].includes(text(lotTable.get(row, "match_status"))) ? "RESIDUAL"
                : "CANDIDATE"
        ),
        `Lot row ${sourceRow}`,
      ),
      matchRuleId: text(lotTable.get(row, "match_rule_id")),
      matchEvidence: parsedMatchEvidence,
      reviewState: reviewState(lotTable.get(row, "review_state"), `Lot row ${sourceRow}`),
      packageName,
      transactionNumber: text(lotTable.get(row, "transaction_number")),
      salesKey,
      transactionDate: optionalDate(lotTable.get(row, "transaction_date"), `Lot row ${sourceRow} transaction_date`),
      creditEventKey: text(lotTable.get(row, "credit_event_key")),
      originalCredits: numeric(lotTable.get(row, "original_credits"), "original_credits"),
      packageCredits: numeric(lotTable.get(row, "package_credits"), "package_credits"),
      negativeRecoveryCredits: numeric(lotTable.get(row, "negative_recovery_credits"), "negative_recovery_credits"),
      openingCredits: numeric(lotTable.get(row, "opening_paid_credits"), "opening_paid_credits"),
      deferredCredits: numeric(lotTable.get(row, "deferred_paid_credits"), "deferred_paid_credits"),
      recognizedCredits: numeric(lotTable.get(row, "recognized_paid_credits"), "recognized_paid_credits"),
      remainingCredits: numeric(lotTable.get(row, "closing_paid_credits"), "closing_paid_credits"),
      unitRateThb: numeric(lotTable.get(row, "unit_rate_thb"), "unit_rate_thb"),
      netPaymentThb: numeric(lotTable.get(row, "net_payment_thb"), "net_payment_thb"),
      openingLiabilityThb: numeric(lotTable.get(row, "opening_liability_thb"), "opening_liability_thb"),
      deferredNewLiabilityThb: numeric(lotTable.get(row, "deferred_new_liability_thb"), "deferred_new_liability_thb"),
      recognizedRevenueThb: numeric(lotTable.get(row, "recognized_revenue_thb"), "recognized_revenue_thb"),
      closingLiabilityThb: numeric(lotTable.get(row, "closing_liability_thb"), "closing_liability_thb"),
      candidateSalesKeys: text(lotTable.get(row, "candidate_sales_keys")),
      candidateReceiptIds: text(lotTable.get(row, "candidate_receipt_ids")),
      sourceSpreadsheetId: sourceSpreadsheet || null,
      sourceSheetId: optionalInteger(sourceSheetRaw, "sales_source_sheet_id"),
      sourceRow: optionalInteger(sourceRowRaw, "sales_source_row"),
      creditEventSpreadsheetId: creditEventSpreadsheet || null,
      creditEventSheetId: optionalInteger(lotTable.get(row, "credit_event_source_sheet_id"), "credit_event_source_sheet_id"),
      creditEventRow: optionalInteger(lotTable.get(row, "credit_event_source_row"), "credit_event_source_row"),
      receiptId: text(lotTable.get(row, "receipt_id")),
      receiptType: text(lotTable.get(row, "receipt_type")),
      receiptStatus: text(lotTable.get(row, "receipt_status")),
      receiptChargedAt: receiptChargedAtRaw || null,
      receiptAmountThb: numeric(lotTable.get(row, "receipt_amount_thb") || 0, "receipt_amount_thb"),
      receiptCurrency: text(lotTable.get(row, "receipt_currency")),
      receiptNote: text(lotTable.get(row, "receipt_note")),
      receiptStudentId: text(lotTable.get(row, "receipt_student_id")),
      receiptClassId: text(lotTable.get(row, "receipt_class_id")),
      receiptSourceRow: optionalInteger(lotTable.get(row, "receipt_source_row"), "receipt_source_row"),
      formulaRow: sourceRow,
    };
  });

  let exactPackages: ParsedWorkbookExactPackage[] = [];
  if (status.workbookSchemaVersion >= 4) {
    if (!input.exactPackages || !input.exactPackageFormulas) {
      throw new UnearnedRevenueWorkbookError(
        "Workbook schema V4 is missing CALC_Exact_Package_Overview data",
      );
    }
    const exactPackageTable = table(
      input.exactPackages,
      "CALC_Exact_Package_Overview",
      WORKBOOK_LIMITS.exactPackages,
      [
        "period_end", "period_kind", "is_latest", "package_name",
        "opening_liability_thb", "deferred_new_liability_thb",
        "recognized_revenue_thb", "automatic_exact_liability_thb",
        "finance_reviewed_liability_thb", "closing_exact_liability_thb",
        "remaining_credits", "student_count", "account_count", "active_lot_count",
        "share_of_exact_liability", "identity_difference_thb", "formula_rule_ids",
        "output_run_id", "source_fingerprint",
      ],
    );
    exactPackages = exactPackageTable.records.map(({ row, sourceRow }) => {
      for (let column = 4; column <= 15; column += 1) {
        formulaCell(
          input.exactPackageFormulas!,
          sourceRow,
          column,
          "CALC_Exact_Package_Overview",
        );
      }
      assertLineage(
        exactPackageTable.get(row, "output_run_id"),
        exactPackageTable.get(row, "source_fingerprint"),
        status,
        "CALC_Exact_Package_Overview",
        sourceRow,
      );
      const packageName = text(exactPackageTable.get(row, "package_name"));
      if (!packageName || !text(exactPackageTable.get(row, "formula_rule_ids"))) {
        throw new UnearnedRevenueWorkbookError(
          `Exact package row ${sourceRow} is missing its literal package name or formula rule`,
        );
      }
      const opening = numeric(
        exactPackageTable.get(row, "opening_liability_thb"),
        "opening_liability_thb",
      );
      const deferred = numeric(
        exactPackageTable.get(row, "deferred_new_liability_thb"),
        "deferred_new_liability_thb",
      );
      const recognized = numeric(
        exactPackageTable.get(row, "recognized_revenue_thb"),
        "recognized_revenue_thb",
      );
      const automatic = numeric(
        exactPackageTable.get(row, "automatic_exact_liability_thb"),
        "automatic_exact_liability_thb",
      );
      const reviewed = numeric(
        exactPackageTable.get(row, "finance_reviewed_liability_thb"),
        "finance_reviewed_liability_thb",
      );
      const closing = numeric(
        exactPackageTable.get(row, "closing_exact_liability_thb"),
        "closing_exact_liability_thb",
      );
      if (difference(
        (Number(opening) + Number(deferred) - Number(recognized)).toFixed(8),
        closing,
      ) > 1) {
        throw new UnearnedRevenueWorkbookError(
          `Exact package row ${sourceRow} does not roll forward`,
        );
      }
      if (difference((Number(automatic) + Number(reviewed)).toFixed(8), closing) > 1) {
        throw new UnearnedRevenueWorkbookError(
          `Exact package row ${sourceRow} evidence classes do not equal closing liability`,
        );
      }
      return {
        periodEnd: googleSheetDate(
          exactPackageTable.get(row, "period_end"),
          `Exact package row ${sourceRow} period_end`,
        ),
        periodKind: periodKind(
          exactPackageTable.get(row, "period_kind"),
          `Exact package row ${sourceRow}`,
        ),
        isLatest: booleanValue(exactPackageTable.get(row, "is_latest")),
        packageName,
        openingLiabilityThb: opening,
        deferredNewLiabilityThb: deferred,
        recognizedRevenueThb: recognized,
        automaticExactLiabilityThb: automatic,
        financeReviewedLiabilityThb: reviewed,
        closingExactLiabilityThb: closing,
        remainingCredits: numeric(
          exactPackageTable.get(row, "remaining_credits"),
          "remaining_credits",
        ),
        studentCount: integer(exactPackageTable.get(row, "student_count"), "student_count"),
        accountCount: integer(exactPackageTable.get(row, "account_count"), "account_count"),
        activeLotCount: integer(exactPackageTable.get(row, "active_lot_count"), "active_lot_count"),
        shareOfExactLiability: numeric(
          exactPackageTable.get(row, "share_of_exact_liability"),
          "share_of_exact_liability",
        ),
        sourceRow,
      };
    });
  }

  const latestPeriods = periods.filter((period) => period.isLatest);
  if (latestPeriods.length !== 1 || latestPeriods[0].periodEnd !== status.cutoff) {
    throw new UnearnedRevenueWorkbookError("Exactly one latest period must equal the published cutoff");
  }
  if (periods.some((period) => period.periodEnd < "2026-03-01")) {
    throw new UnearnedRevenueWorkbookError("Reporting history cannot precede March 2026");
  }
  if (periods.some((period) => period.periodEnd > status.cutoff)) {
    throw new UnearnedRevenueWorkbookError("Workbook contains a reporting period after the published cutoff");
  }
  for (const period of periods) {
    const expectedKind = period.periodEnd === monthEnd(period.periodEnd) ? "MONTH_END" : "LATEST";
    if (period.periodKind !== expectedKind) {
      throw new UnearnedRevenueWorkbookError(`${period.periodEnd} has inconsistent period semantics`);
    }
    if (period.isLatest !== (period.periodEnd === status.cutoff)) {
      throw new UnearnedRevenueWorkbookError(`${period.periodEnd} has inconsistent latest-period status`);
    }
  }

  assertUnique(periods.map((row) => row.periodEnd), "Model Comparison");
  assertUnique(students.map((row) => `${row.periodEnd}\u0000${row.studentId}`), "CALC_Student_Period");
  assertUnique(accounts.map((row) => `${row.periodEnd}\u0000${row.accountId}`), "CALC_Account_Period");
  assertUnique(lots.map((row) => `${row.periodEnd}\u0000${row.lotId}`), "CALC_Package_Lot_Period");
  assertUnique(
    exactPackages.map((row) => `${row.periodEnd}\u0000${row.packageName}`),
    "CALC_Exact_Package_Overview",
  );

  const periodByDate = new Map(periods.map((period) => [period.periodEnd, period]));
  for (const student of students) {
    const period = periodByDate.get(student.periodEnd);
    if (!period || student.periodKind !== period.periodKind || student.isLatest !== period.isLatest) {
      throw new UnearnedRevenueWorkbookError(`Student ${student.studentId} references an inconsistent reporting period`);
    }
  }
  const studentKeys = new Set(students.map((row) => `${row.periodEnd}\u0000${row.studentId}`));
  const accountKeys = new Set(accounts.map((row) => `${row.periodEnd}\u0000${row.accountId}`));
  for (const account of accounts) {
    if (!periodByDate.has(account.periodEnd)
      || !studentKeys.has(`${account.periodEnd}\u0000${account.studentId}`)) {
      throw new UnearnedRevenueWorkbookError(`Account ${account.accountId} has no matching period/student row`);
    }
  }
  for (const lot of lots) {
    if (!periodByDate.has(lot.periodEnd)
      || !studentKeys.has(`${lot.periodEnd}\u0000${lot.studentId}`)
      || !accountKeys.has(`${lot.periodEnd}\u0000${lot.accountId}`)) {
      throw new UnearnedRevenueWorkbookError(`Lot ${lot.lotId} has no matching period/student/account row`);
    }
    if (lot.receiptId) {
      const receiptEvidence = receiptEvidenceById.get(lot.receiptId);
      if (!receiptEvidence) {
        throw new UnearnedRevenueWorkbookError(`Lot ${lot.lotId} references unknown receipt ${lot.receiptId}`);
      }
      if (lot.receiptSourceRow !== receiptEvidence.sourceRow) {
        throw new UnearnedRevenueWorkbookError(`Lot ${lot.lotId} has an inconsistent receipt trace row`);
      }
      const lotChargedAt = lot.receiptChargedAt ? new Date(lot.receiptChargedAt).getTime() : null;
      const evidenceChargedAt = receiptEvidence.chargedAt
        ? new Date(receiptEvidence.chargedAt).getTime()
        : null;
      if (
        lot.receiptType !== receiptEvidence.type
        || lot.receiptStatus !== receiptEvidence.status
        || lotChargedAt !== evidenceChargedAt
        || difference(lot.receiptAmountThb ?? "0", receiptEvidence.amountThb) > 0.00000001
        || lot.receiptCurrency !== receiptEvidence.currency
        || lot.receiptNote !== receiptEvidence.note
        || lot.receiptStudentId !== receiptEvidence.studentId
        || lot.receiptClassId !== receiptEvidence.classId
      ) {
        throw new UnearnedRevenueWorkbookError(`Lot ${lot.lotId} has receipt metadata inconsistent with SRC_Wise_Receipt`);
      }
    } else if (lot.receiptSourceRow !== null) {
      throw new UnearnedRevenueWorkbookError(`Lot ${lot.lotId} has a receipt trace row without a receipt ID`);
    }
  }
  for (const packageRow of exactPackages) {
    const period = periodByDate.get(packageRow.periodEnd);
    if (!period || packageRow.periodKind !== period.periodKind
      || packageRow.isLatest !== period.isLatest) {
      throw new UnearnedRevenueWorkbookError(
        `Package ${packageRow.packageName} references an inconsistent reporting period`,
      );
    }
  }

  for (const period of periods) {
    const periodStudents = students.filter((row) => row.periodEnd === period.periodEnd);
    const periodAccounts = accounts.filter((row) => row.periodEnd === period.periodEnd);
    const periodLots = lots.filter((row) => row.periodEnd === period.periodEnd);
    const sum = <T>(rows: T[], select: (row: T) => string) => rows.reduce((total, row) => total + Number(select(row)), 0);
    const assertClose = (actual: number, expected: number, label: string, tolerance = 1) => {
      if (Math.abs(actual - expected) > tolerance) {
        throw new UnearnedRevenueWorkbookError(`${period.periodEnd} ${label} differs by ${actual - expected}`);
      }
    };
    assertClose(sum(periodStudents, (row) => row.canonicalClosingLiabilityThb), Number(period.closingLiabilityThb), "student/canonical total");
    assertClose(sum(periodStudents, (row) => row.legacyClosingLiabilityThb), Number(period.legacyClosingLiabilityThb), "student/legacy total");
    assertClose(sum(periodStudents, (row) => row.fifoClosingLiabilityThb), Number(period.fifoClosingLiabilityThb), "student/FIFO total");
    assertClose(sum(periodAccounts, (row) => row.canonicalClosingLiabilityThb), Number(period.closingLiabilityThb), "account/canonical total");
    assertClose(sum(periodAccounts, (row) => row.legacyClosingLiabilityThb), Number(period.legacyClosingLiabilityThb), "account/legacy total");
    assertClose(sum(periodAccounts, (row) => row.fifoClosingLiabilityThb), Number(period.fifoClosingLiabilityThb), "account/FIFO total");
    assertClose(sum(periodLots, (row) => row.closingLiabilityThb), Number(period.fifoClosingLiabilityThb), "lot/FIFO total");
    const periodPackages = exactPackages.filter((row) => row.periodEnd === period.periodEnd);
    if (status.workbookSchemaVersion >= 4) {
      const exactPackageTotal = sum(periodPackages, (row) => row.closingExactLiabilityThb);
      const automaticTotal = sum(periodPackages, (row) => row.automaticExactLiabilityThb);
      const reviewedTotal = sum(periodPackages, (row) => row.financeReviewedLiabilityThb);
      assertClose(exactPackageTotal, Number(period.attributedLiabilityThb), "package/exact total");
      assertClose(automaticTotal + reviewedTotal, exactPackageTotal, "package evidence-class total");
      assertClose(
        exactPackageTotal + Number(period.residualLiabilityThb),
        Number(period.fifoClosingLiabilityThb),
        "exact plus residual/FIFO total",
      );
      if (period.isLatest) {
        assertClose(
          automaticTotal,
          Number(status.automaticExactLiabilityThb ?? 0),
          "package/status automatic exact total",
        );
        assertClose(
          reviewedTotal,
          Number(status.financeReviewedLiabilityThb ?? 0),
          "package/status Finance-reviewed total",
        );
      }
    }
    assertClose(Number(period.openingLiabilityThb) + Number(period.deferredNewLiabilityThb) - Number(period.recognizedRevenueThb), Number(period.closingLiabilityThb), "finance roll-forward");
    period.ambiguousCount = periodLots.filter((row) => row.matchStatus === "AMBIGUOUS" && Number(row.closingLiabilityThb) > 0).length;
    period.unattributedCount = periodLots.filter((row) => row.matchStatus === "UNATTRIBUTED" && Number(row.closingLiabilityThb) > 0).length;
    period.fallbackValuedCount = periodLots.filter((row) => ["AMBIGUOUS", "UNATTRIBUTED", "COMPOSITE_CANDIDATE"].includes(row.lotKind) && Number(row.closingLiabilityThb) > 0).length;
    period.negativeBalanceCount = periodAccounts.filter((row) => Number(row.ledgerRemainingCredits) < -0.001).length;
    period.compositeVerifiedCount = periodLots.filter((row) => row.matchStatus === "COMPOSITE_VERIFIED").length;
    period.receiptCandidateCount = periodLots.filter((row) => row.matchStatus === "COMPOSITE_CANDIDATE").length;
    if (period.isLatest) {
      period.compositeVerifiedCount = Math.max(period.compositeVerifiedCount ?? 0, status.compositeVerifiedCount ?? 0);
      period.receiptCandidateCount = Math.max(period.receiptCandidateCount ?? 0, status.receiptCandidateCount ?? 0);
      period.reversalConflictCount = status.reversalConflictCount ?? 0;
      period.missingReceiptEvidenceCount = status.missingReceiptEvidenceCount ?? 0;
    }
  }

  return {
    status,
    periods,
    students,
    accounts,
    lots,
    exactPackages,
    rowCounts: {
      periods: periods.length,
      students: students.length,
      accounts: accounts.length,
      ...(status.workbookSchemaVersion >= 3
        ? { receipts: receiptTable.records.length }
        : {}),
      lots: lots.length,
      ...(status.workbookSchemaVersion >= 4
        ? { exactPackages: exactPackages.length }
        : {}),
    },
  };
}
