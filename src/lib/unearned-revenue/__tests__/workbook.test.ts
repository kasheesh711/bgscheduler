import { describe, expect, it } from "vitest";

import {
  parseUnearnedRevenueWorkbook,
  WORKBOOK_LIMITS,
} from "@/lib/unearned-revenue/workbook";

const runId = "run-fixture";
const fingerprint = "fingerprint-fixture";

function formulaTable(
  headers: string[],
  records: unknown[][],
  formulaColumns: number[],
): { values: unknown[][]; formulas: unknown[][] } {
  return {
    values: [headers, ...records],
    formulas: [headers, ...records.map((row) => row.map((value, column) => (
      formulaColumns.includes(column) ? "=FIXTURE_FORMULA" : value
    )))],
  };
}

function fixture() {
  const status = [
    ["field", "value", "notes"],
    ["workbook_schema_version", 2, ""],
    ["model_status", "PUBLISHED", ""],
    ["publication_status", "PUBLISHED", ""],
    ["published_cutoff", "2026-03-31", ""],
    ["run_id", runId, ""],
    ["source_fingerprint", fingerprint, ""],
    ["publication_revision", "7", ""],
    ["generated_at_bangkok", "2026-04-01T00:15:00+07:00", ""],
    ["canonical_model", "LEGACY_ACCOUNT_RATE", ""],
    ["candidate_model_version", "FIFO_PACKAGE_LOT_V1", ""],
    ["model_mode", "SHADOW", ""],
    ["hard_qa_status", "PASS", ""],
    ["review_conditions", "API_VARIANCE:2", ""],
  ];
  const periods = formulaTable([
    "period_end", "period_kind", "is_latest", "legacy_closing_liability_thb",
    "fifo_closing_liability_thb", "canonical_closing_liability_thb",
    "fifo_vs_legacy_difference_thb", "attributed_liability_thb",
    "residual_liability_thb", "attribution_percent", "canonical_model",
    "model_version", "student_count", "account_count", "remaining_paid_credits",
    "opening_liability_thb", "deferred_new_liability_thb", "recognized_revenue_thb",
    "identity_difference_thb", "formula_rule_ids", "output_run_id", "source_fingerprint",
  ], [[
    "2026-03-31", "MONTH_END", true, 100, 90, 100, -10, 0, 90, 0,
    "LEGACY_ACCOUNT_RATE", "FIFO_PACKAGE_LOT_V1", 1, 1, 1, 100, 0, 0, 0,
    "MODEL-COMPARE-001", runId, fingerprint,
  ]], [3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 18]);
  const students = formulaTable([
    "period_end", "period_kind", "is_latest", "student_id", "student_name", "parent_name",
    "account_count", "ledger_remaining_credits", "closing_paid_credits",
    "legacy_closing_liability_thb", "fifo_opening_liability_thb",
    "fifo_deferred_new_liability_thb", "fifo_recognized_revenue_thb",
    "fifo_closing_liability_thb", "canonical_closing_liability_thb",
    "attributed_liability_thb", "residual_liability_thb", "attribution_percent",
    "review_state", "legacy_lookup_date", "formula_rule_ids", "canonical_model",
    "model_version", "output_run_id", "source_fingerprint",
  ], [[
    "2026-03-31", "MONTH_END", true, "student-1", "Ada", "Parent", 1,
    1, 1, 100, 90, 0, 0, 90, 100, 0, 90, 0, "NEEDS_REVIEW",
    "2026-03-31", "STUDENT-PERIOD-001", "LEGACY_ACCOUNT_RATE",
    "FIFO_PACKAGE_LOT_V1", runId, fingerprint,
  ]], Array.from({ length: 11 }, (_, index) => index + 7));
  const accounts = formulaTable([
    "period_end", "period_kind", "is_latest", "account_id", "student_id", "class_id",
    "student_name", "class_name", "class_subject", "ledger_remaining_credits",
    "opening_paid_credits", "deferred_paid_credits", "recognized_paid_credits",
    "closing_paid_credits", "legacy_closing_liability_thb", "fifo_opening_liability_thb",
    "fifo_deferred_new_liability_thb", "fifo_recognized_revenue_thb",
    "fifo_closing_liability_thb", "canonical_closing_liability_thb",
    "attributed_liability_thb", "residual_liability_thb", "review_state",
    "legacy_lookup_date", "identity_difference_thb", "formula_rule_ids",
    "output_run_id", "source_fingerprint", "lot_closing_all_credits",
  ], [[
    "2026-03-31", "MONTH_END", true, "account-1", "student-1", "class-1",
    "Ada", "Math", "Mathematics", 1, 1, 0, 0, 1, 100, 90, 0, 0, 90, 100,
    0, 90, "NEEDS_REVIEW", "2026-03-31", 0, "ACCOUNT-PERIOD-001",
    runId, fingerprint, 1,
  ]], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 24, 28]);
  const lots = formulaTable([
    "period_end", "period_kind", "is_latest", "lot_id", "account_id", "student_id",
    "class_id", "student_name", "class_name", "lot_kind", "match_status", "review_state",
    "package_name", "sales_key", "transaction_date", "credit_event_key", "original_credits",
    "negative_recovery_credits", "opening_paid_credits", "deferred_paid_credits",
    "recognized_paid_credits", "closing_paid_credits", "unit_rate_thb",
    "opening_liability_thb", "deferred_new_liability_thb", "recognized_revenue_thb",
    "closing_liability_thb", "identity_difference_thb", "source_file_id", "source_sheet_id",
    "source_sheet", "source_row", "source_row_url", "candidate_sales_keys",
    "transaction_number", "package_credits", "net_payment_thb", "formula_rule_ids",
    "output_run_id", "source_fingerprint",
  ], [[
    "2026-03-31", "MONTH_END", true, "lot-1", "account-1", "student-1", "class-1",
    "Ada", "Math", "OPENING", "FROZEN_OPENING", "NEEDS_REVIEW", "", "", "", "",
    1, 0, 1, 0, 0, 1, 90, 90, 0, 0, 90, 0, "", "", "", "", "", "", "",
    1, 90, "LOT-PERIOD-001", runId, fingerprint,
  ]], [22, 23, 24, 25, 26, 27]);
  return {
    statusStart: status,
    statusEnd: structuredClone(status),
    qa: [
      ["check_id", "severity", "actual", "expected", "difference", "tolerance", "status", "notes"],
      ["QA-HARD-001", "HARD", 0, 0, 0, 0, "PASS", "fixture"],
    ],
    periods: periods.values,
    periodFormulas: periods.formulas,
    students: students.values,
    studentFormulas: students.formulas,
    accounts: accounts.values,
    accountFormulas: accounts.formulas,
    lots: lots.values,
    lotFormulas: lots.formulas,
  };
}

function v3Fixture() {
  const input = fixture();
  for (const statusRows of [input.statusStart, input.statusEnd]) {
    statusRows.find((row) => row[0] === "workbook_schema_version")![1] = 3;
    statusRows.find((row) => row[0] === "candidate_model_version")![1] = "FIFO_PACKAGE_LOT_V2";
  }
  input.periods[1][11] = "FIFO_PACKAGE_LOT_V2";
  input.students[1][22] = "FIFO_PACKAGE_LOT_V2";
  const v3LotHeaders = [
    "match_confidence", "match_rule_id", "match_evidence", "candidate_receipt_ids",
    "sales_source_file_id", "sales_source_sheet_id", "sales_source_row",
    "credit_event_source_file_id", "credit_event_source_sheet_id", "credit_event_source_row",
    "receipt_id", "receipt_type", "receipt_status", "receipt_charged_at",
    "receipt_amount_thb", "receipt_currency", "receipt_note", "receipt_student_id",
    "receipt_class_id", "receipt_source_row",
  ];
  input.lots[0].push(...v3LotHeaders);
  const v3LotValues = [
    "RESIDUAL", "MATCH-OPENING-V2", "{}", "", "", "", "", "", "", "",
    "", "", "", "", 0, "", "", "", "", "",
  ];
  input.lots[1].push(...v3LotValues);
  input.lotFormulas[1].push(...v3LotValues);
  return {
    ...input,
    receipts: [[
      "receipt_id", "receipt_type", "receipt_status", "charged_at", "receipt_date",
      "created_at", "amount_minor", "amount_thb", "currency", "note", "student_id",
      "student_name", "class_id", "classroom_name", "classroom_subject", "parent_ids",
      "parent_names", "identifiers", "payload_checksum", "source_row", "output_run_id",
      "source_fingerprint",
    ], [
      "receipt-1", "PAYMENT", "CHARGED", "2026-03-10T10:00:00+07:00", "2026-03-10",
      "2026-03-10T10:00:00+07:00", 10_000, 100, "TH", "", "student-1", "Ada",
      "class-1", "Math", "Mathematics", "", "", "invoice-1", "a".repeat(64), 2,
      runId, fingerprint,
    ]],
  };
}

describe("unearned revenue workbook contract", () => {
  it("accepts a published, formula-backed, cross-level reconciled snapshot", () => {
    const result = parseUnearnedRevenueWorkbook(fixture());

    expect(result.status).toMatchObject({
      sourceRunId: runId,
      canonicalModel: "LEGACY_ACCOUNT_RATE",
      modelMode: "SHADOW",
      cutoff: "2026-03-31",
    });
    expect(result.rowCounts).toEqual({ periods: 1, students: 1, accounts: 1, lots: 1 });
    expect(result.periods[0]).toMatchObject({ apiVarianceCount: 2, closingLiabilityThb: "100.00000000" });
  });

  it("normalizes Google date serials, including status-map values stringified during parsing", () => {
    const input = fixture();
    for (const statusRows of [input.statusStart, input.statusEnd]) {
      statusRows.find((row) => row[0] === "published_cutoff")![1] = 46_112;
    }
    input.periods[1][0] = 46_112;
    input.students[1][0] = 46_112;
    input.accounts[1][0] = 46_112;
    input.lots[1][0] = 46_112;

    expect(parseUnearnedRevenueWorkbook(input).status.cutoff).toBe("2026-03-31");
  });

  it("rejects a start/end status change during a staged tab swap", () => {
    const input = fixture();
    input.statusEnd.find((row) => row[0] === "run_id")![1] = "rotated-run";

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/changed during import.*run_id/i);
  });

  it("rejects oversized table contracts before importing any rows", () => {
    const input = fixture();
    input.students = [input.students[0], ...Array.from({ length: WORKBOOK_LIMITS.students + 1 }, () => [])];

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/exceeds 20,000 data rows/i);
  });

  it("rejects calculated amounts that are no longer backed by formulas", () => {
    const input = fixture();
    input.periodFormulas[1][5] = 100;

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/not backed by a formula/i);
  });

  it("rejects future-looking or mislabeled partial periods", () => {
    const input = fixture();
    input.periods[1][0] = "2026-03-30";
    input.students[1][0] = "2026-03-30";
    input.accounts[1][0] = "2026-03-30";
    input.lots[1][0] = "2026-03-30";
    input.statusStart.find((row) => row[0] === "published_cutoff")![1] = "2026-03-30";
    input.statusEnd.find((row) => row[0] === "published_cutoff")![1] = "2026-03-30";

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/period semantics/i);
  });

  it("rejects cross-level totals even when individual formula cells are present", () => {
    const input = fixture();
    input.accounts[1][19] = 98;

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/account\/canonical total/i);
  });

  it("accepts a V3 receipt bridge and records its bounded evidence count", () => {
    const result = parseUnearnedRevenueWorkbook(v3Fixture());

    expect(result.status.modelVersion).toBe("FIFO_PACKAGE_LOT_V2");
    expect(result.rowCounts).toMatchObject({ receipts: 1 });
  });

  it("rejects a V3 lot whose receipt trace does not resolve to the receipt evidence tab", () => {
    const input = v3Fixture();
    const receiptIdColumn = input.lots[0].indexOf("receipt_id");
    const receiptSourceRowColumn = input.lots[0].indexOf("receipt_source_row");
    input.lots[1][receiptIdColumn] = "missing-receipt";
    input.lots[1][receiptSourceRowColumn] = 2;

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/unknown receipt/i);
  });

  it("rejects a V3 receipt row whose embedded trace row is stale", () => {
    const input = v3Fixture();
    input.receipts[1][19] = 99;

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/inconsistent source_row/i);
  });

  it("rejects V3 when the workbook advertises the stale V1 algorithm", () => {
    const input = v3Fixture();
    for (const statusRows of [input.statusStart, input.statusEnd]) {
      statusRows.find((row) => row[0] === "candidate_model_version")![1] = "FIFO_PACKAGE_LOT_V1";
    }

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/must use candidate model FIFO_PACKAGE_LOT_V2/i);
  });
});
