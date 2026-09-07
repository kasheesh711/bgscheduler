import { gzipSync, gunzipSync } from "node:zlib";
import { parseValuesPublication, sha256 } from "../publication";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("@/lib/sales-dashboard/google-oauth", () => ({}));
import { publishBundle } from "../publisher/publish";
import type { ReportBundle } from "../publisher/layout";

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

function v4Fixture() {
  const input = v3Fixture();
  for (const statusRows of [input.statusStart, input.statusEnd]) {
    statusRows.find((row) => row[0] === "workbook_schema_version")![1] = 4;
    statusRows.find((row) => row[0] === "candidate_model_version")![1] = "FIFO_PACKAGE_LOT_V3";
    statusRows.push(["automatic_exact_liability_thb", 90, ""]);
    statusRows.push(["finance_reviewed_liability_thb", 0, ""]);
  }
  input.periods[1][7] = 90;
  input.periods[1][8] = 0;
  input.periods[1][9] = 100;
  input.periods[1][11] = "FIFO_PACKAGE_LOT_V3";
  input.students[1][15] = 90;
  input.students[1][16] = 0;
  input.students[1][17] = 100;
  input.students[1][22] = "FIFO_PACKAGE_LOT_V3";
  input.accounts[1][20] = 90;
  input.accounts[1][21] = 0;

  const setLot = (header: string, value: unknown) => {
    const column = input.lots[0].indexOf(header);
    input.lots[1][column] = value;
    input.lotFormulas[1][column] = value;
  };
  setLot("lot_kind", "PAID_PACKAGE");
  setLot("match_status", "EXACT_TRANSACTION");
  setLot("review_state", "NO_REVIEW");
  setLot("package_name", "40-hr (free extra 1 hr)");
  setLot("sales_key", "AA2605-117");
  setLot("transaction_date", "2026-03-10");
  setLot("credit_event_key", "event-1");
  setLot("source_file_id", "sales-workbook");
  setLot("source_sheet_id", 701);
  setLot("source_row", 117);
  setLot("transaction_number", "AA2605-117");
  setLot("match_confidence", "EXACT");
  setLot("match_rule_id", "MATCH-DIRECT-TRANSACTION-ID-V3");
  setLot("match_evidence", JSON.stringify({
    nickname_match_state: "MATCH",
    sales_nickname_key: "zeiyach",
    wise_nickname_key: "zeiyach",
    matching_date_source: "PAYMENT_DATE",
  }));
  setLot("sales_source_file_id", "sales-workbook");
  setLot("sales_source_sheet_id", 701);
  setLot("sales_source_row", 117);
  for (const [header, value] of [
    ["payment_date", "2026-03-10"],
    ["matching_date", "2026-03-10"],
    ["matching_date_source", "PAYMENT_DATE"],
    ["sales_nickname_key", "zeiyach"],
    ["wise_nickname_key", "zeiyach"],
    ["nickname_match_state", "MATCH"],
  ] as const) {
    input.lots[0].push(header);
    input.lots[1].push(value);
    input.lotFormulas[1].push(value);
  }

  const exact = formulaTable([
    "period_end", "period_kind", "is_latest", "package_name",
    "opening_liability_thb", "deferred_new_liability_thb", "recognized_revenue_thb",
    "automatic_exact_liability_thb", "finance_reviewed_liability_thb",
    "closing_exact_liability_thb", "remaining_credits", "student_count",
    "account_count", "active_lot_count", "share_of_exact_liability",
    "identity_difference_thb", "formula_rule_ids", "output_run_id", "source_fingerprint",
  ], [[
    "2026-03-31", "MONTH_END", true, "40-hr (free extra 1 hr)",
    90, 0, 0, 90, 0, 90, 1, 1, 1, 1, 100, 0,
    "EXACT-PACKAGE-001", runId, fingerprint,
  ]], Array.from({ length: 12 }, (_, index) => index + 4));
  return {
    ...input,
    exactPackages: exact.values,
    exactPackageFormulas: exact.formulas,
  };
}

function fifoV4Fixture({ unchecked = false }: { unchecked?: boolean } = {}) {
  const input = v4Fixture();
  for (const statusRows of [input.statusStart, input.statusEnd]) {
    statusRows.find((row) => row[0] === "candidate_model_version")![1] = "FIFO_PACKAGE_LOT_V4";
  }
  input.periods[1][11] = "FIFO_PACKAGE_LOT_V4";
  input.students[1][22] = "FIFO_PACKAGE_LOT_V4";

  const setLot = (header: string, value: unknown) => {
    const column = input.lots[0].indexOf(header);
    input.lots[1][column] = value;
    input.lotFormulas[1][column] = value;
  };
  if (!unchecked) {
    setLot("match_rule_id", "MATCH-DIRECT-TRANSACTION-ID-V4");
    setLot("match_evidence", JSON.stringify({
      nickname_match_state: "MATCH",
      sales_nickname_key: "zeiyach",
      wise_nickname_key: "zeiyach",
      matching_date_source: "PAYMENT_DATE",
      recorded_in_wise: true,
    }));
    return input;
  }

  input.receipts[1][6] = 9_000;
  input.receipts[1][7] = 90;
  input.receipts[1][8] = "THB";
  setLot("match_status", "COMPOSITE_VERIFIED");
  setLot("match_confidence", "COMPOSITE_VERIFIED");
  setLot("match_rule_id", "MATCH-COMPOSITE-VERIFIED-V4");
  setLot("match_evidence", JSON.stringify({
    amount_difference_thb: 0,
    class_id_match: true,
    credit_difference: 0,
    eligible_event_edge_count: 1,
    eligible_receipt_edge_count: 1,
    eligible_sale_edge_count: 1,
    independent_wise_proof: true,
    matching_date_source: "PAYMENT_DATE",
    nickname_match_state: "MATCH",
    program_match: true,
    receipt_event_date_difference_days: 0,
    recorded_in_wise: false,
    recorded_in_wise_policy: "ADVISORY_WISE_PROVEN",
    sales_nickname_key: "zeiyach",
    sales_receipt_date_difference_days: 0,
    student_id_match: true,
    wise_nickname_key: "zeiyach",
  }));
  setLot("receipt_id", "receipt-1");
  setLot("receipt_type", "PAYMENT");
  setLot("receipt_status", "CHARGED");
  setLot("receipt_charged_at", "2026-03-10T10:00:00+07:00");
  setLot("receipt_amount_thb", 90);
  setLot("receipt_currency", "THB");
  setLot("receipt_note", "");
  setLot("receipt_student_id", "student-1");
  setLot("receipt_class_id", "class-1");
  setLot("receipt_source_row", 2);
  return input;
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

  it("rejects a change to any published status value during a schema-V4 read", () => {
    const input = v4Fixture();
    input.statusEnd.find((row) => row[0] === "automatic_exact_liability_thb")![1] = 89;

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(
      /changed during import.*automatic_exact_liability_thb/i,
    );
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

  it("accepts a V4 exact-package overview backed by V3 identity evidence", () => {
    const result = parseUnearnedRevenueWorkbook(v4Fixture());

    expect(result.status).toMatchObject({
      workbookSchemaVersion: 4,
      modelVersion: "FIFO_PACKAGE_LOT_V3",
      automaticExactLiabilityThb: "90.00000000",
    });
    expect(result.rowCounts).toMatchObject({ receipts: 1, exactPackages: 1 });
    expect(result.exactPackages[0]).toMatchObject({
      packageName: "40-hr (free extra 1 hr)",
      closingExactLiabilityThb: "90.00000000",
    });
  });

  it("accepts schema V4 with the current FIFO V4 runtime", () => {
    const result = parseUnearnedRevenueWorkbook(fifoV4Fixture());

    expect(result.status.modelVersion).toBe("FIFO_PACKAGE_LOT_V4");
  });

  it("accepts an unchecked V4 lot only with complete composite WISE proof", () => {
    const result = parseUnearnedRevenueWorkbook(fifoV4Fixture({ unchecked: true }));

    expect(result.lots[0]).toMatchObject({
      matchStatus: "COMPOSITE_VERIFIED",
      matchRuleId: "MATCH-COMPOSITE-VERIFIED-V4",
      receiptId: "receipt-1",
      matchEvidence: {
        independent_wise_proof: true,
        recorded_in_wise: false,
        recorded_in_wise_policy: "ADVISORY_WISE_PROVEN",
      },
    });
  });

  it("rejects malformed unchecked V4 exact-package evidence", () => {
    const cases: Array<[string, (input: ReturnType<typeof fifoV4Fixture>) => void]> = [
      ["policy", (input) => {
        const column = input.lots[0].indexOf("match_evidence");
        const evidence = JSON.parse(String(input.lots[1][column]));
        delete evidence.recorded_in_wise_policy;
        input.lots[1][column] = JSON.stringify(evidence);
      }],
      ["rule", (input) => {
        input.lots[1][input.lots[0].indexOf("match_rule_id")] = "MATCH-DIRECT-TRANSACTION-ID-V4";
      }],
      ["graph uniqueness", (input) => {
        const column = input.lots[0].indexOf("match_evidence");
        const evidence = JSON.parse(String(input.lots[1][column]));
        evidence.eligible_receipt_edge_count = 2;
        input.lots[1][column] = JSON.stringify(evidence);
      }],
      ["receipt status", (input) => {
        input.lots[1][input.lots[0].indexOf("receipt_status")] = "REFUNDED";
      }],
      ["amount", (input) => {
        input.lots[1][input.lots[0].indexOf("receipt_amount_thb")] = 80;
      }],
      ["student", (input) => {
        input.lots[1][input.lots[0].indexOf("receipt_student_id")] = "other-student";
      }],
    ];

    for (const [label, mutate] of cases) {
      const input = fifoV4Fixture({ unchecked: true });
      mutate(input);
      expect(
        () => parseUnearnedRevenueWorkbook(input),
        label,
      ).toThrow(/lacks complete independent WISE proof/i);
    }
  });

  it("rejects a V4 automatic package lot without matching nickname evidence", () => {
    const input = v4Fixture();
    const matchEvidenceColumn = input.lots[0].indexOf("match_evidence");
    input.lots[1][matchEvidenceColumn] = JSON.stringify({
      nickname_match_state: "MISMATCH",
      sales_nickname_key: "baikaona",
      wise_nickname_key: "zeiyach",
    });

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/lacks required identity evidence/i);
  });

  it("rejects a V4 exact-package amount that is no longer formula-backed", () => {
    const input = v4Fixture();
    input.exactPackageFormulas[1][9] = 90;

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/not backed by a formula/i);
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

  it("rejects V4 when the workbook advertises the stale V2 algorithm", () => {
    const input = v4Fixture();
    for (const statusRows of [input.statusStart, input.statusEnd]) {
      statusRows.find((row) => row[0] === "candidate_model_version")![1] = "FIFO_PACKAGE_LOT_V2";
    }

    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/must use candidate model FIFO_PACKAGE_LOT_V3 or FIFO_PACKAGE_LOT_V4/i);
  });
});

// V5 uses the same accounting/evidence contract while authenticating computed
// values with an immutable manifest instead of requiring live Sheets formulas.
function valuesFixture() {
  const input = fifoV4Fixture();
  const tables = JSON.parse(JSON.stringify({
    "Model Status": input.statusStart, "QA Checks": input.qa, "Model Comparison": input.periods,
    "CALC_Student_Period": input.students, "CALC_Account_Period": input.accounts,
    "CALC_Package_Lot_Period": input.lots, "CALC_Exact_Package_Overview": input.exactPackages,
    "SRC_Wise_Receipt": input.receipts,
  }).replaceAll(fingerprint, "a".repeat(64))) as Record<string, unknown[][]>;
  tables["Model Status"].find(row => row[0] === "workbook_schema_version")![1] = 5;
  tables["Model Status"].push(["evidence_format", "VALIDATED_VALUES", ""]);
  const checks = ["QA-MODEL-001", "QA-MODEL-002", "QA-LOT-001", "QA-LOT-002", "QA-LOT-003", "QA-LOT-004", "QA-LOT-005", "QA-LOT-006", "QA-DAILY-CREDITS", "QA-DAILY-PERIODS", "QA-DAILY-STUDENTS"];
  tables["QA Checks"].push(...checks.map(id => [id, "HARD", 0, 0, 0, 1, "PASS", "fixture"]));
  const bytes = gzipSync(JSON.stringify({ tables, traces: { "Model Comparison:2": { kind: "published", url: "https://docs.google.com/spreadsheets/d/report-id-123/edit#gid=1&range=A6" } } }));
  const file = { fileId: "values-file-123", sha256: sha256(bytes), bytes: bytes.length };
  const manifest = {
    schemaVersion: 5 as const, runId, cutoff: "2026-03-31", sourceFingerprint: "a".repeat(64), revision: "7",
    generatedAtBangkok: "2026-04-01T00:15:00+07:00", canonicalModel: "LEGACY_ACCOUNT_RATE", modelVersion: "FIFO_PACKAGE_LOT_V4" as const,
    contract: file, audit: file, folderId: "folder-id-123", rollbackSpreadsheetId: "rollback-id-123",
    rowCounts: Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.length - 1])),
    qa: { hardStatus: "PASS" as const, dailyCount: 31, creditTolerance: 0.001 as const, moneyTolerance: 1 as const, checks },
    months: [{ month: "2026-03", from: "2026-03-01", to: "2026-03-31", spreadsheetId: "report-id-123", cells: 1000, sha256: "b".repeat(64), overviewSheetId: 1, studentSheetId: 2, packageSheetId: 3 }],
  };
  return { manifest, contractBytes: bytes, statusStart: tables["Model Status"], statusEnd: structuredClone(tables["Model Status"]) };
}

describe("V5 validated values publication", () => {
  it("imports values without formula tabs and keeps published evidence links", () => {
    const result = parseValuesPublication(valuesFixture());
    expect(Number(result.contract.periods[0].closingLiabilityThb)).toBe(100);
    expect(result.metadata.traces["Model Comparison:2"].kind).toBe("published");
  });
  it("rejects altered checksums", () => {
    const input = valuesFixture(); input.contractBytes[10] ^= 1;
    expect(() => parseValuesPublication(input)).toThrow(/checksum/);
  });
  it("rejects changed publication markers during import", () => {
    const input = valuesFixture(); input.statusEnd.find(row => row[0] === "run_id")![1] = "other-run";
    expect(() => parseValuesPublication(input)).toThrow(/mismatch/);
  });
  it("rejects incomplete daily archive coverage", () => {
    const input = valuesFixture(); input.manifest.months[0].from = "2026-03-02";
    expect(() => parseValuesPublication(input)).toThrow(/coverage/);
  });
  it("rejects inconsistent row counts and missing mandatory QA", () => {
    const input = valuesFixture(); input.manifest.rowCounts["CALC_Student_Period"]++;
    expect(() => parseValuesPublication(input)).toThrow(/row count/);
    const missing = valuesFixture(); missing.manifest.qa.checks = [];
    expect(() => parseValuesPublication(missing)).toThrow();
  });
  it("rejects values in the legacy parser without verified manifest provenance", () => {
    const input = fifoV4Fixture();
    input.statusStart.find(row => row[0] === "workbook_schema_version")![1] = 5;
    input.statusEnd.find(row => row[0] === "workbook_schema_version")![1] = 5;
    expect(() => parseUnearnedRevenueWorkbook(input)).toThrow(/verified|validated/i);
  });
});

function publicationHarness() {
  const fixture = valuesFixture();
  const tables = JSON.parse(gunzipSync(fixture.contractBytes).toString()).tables;
  const status = Object.fromEntries(tables["Model Status"].slice(1).map((row: unknown[]) => [row[0], row[1]]));
  const previousStatus = { run_id: "last-good", published_cutoff: "2026-03-01", publication_revision: "1", source_fingerprint: "c".repeat(64) };
  const finance = Array.from({ length: 31 }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, liability_thb: 100, student_count: 1 }));
  const students = finance.map(row => ({ ...row, student_id: "student-1", student_name: "Ada" }));
  const packages = finance.flatMap(row => [90, 10].map((amount, i) => ({ ...row, liability_thb: amount, student_id: "student-1", student_name: "Ada", account_id: "account-1", class_name: "Math", lot_id: i ? "valuation-1" : "lot-1", package_name: i ? "ส่วนต่างวิธีประเมิน" : "ยอดยกมา", kind: i ? "VALUATION_ADJUSTMENT" : "OPENING", purchase_date: null, transaction_number: "", remaining_credits: i ? null : 1, source_url: "", credit_url: "" })));
  const bundle: ReportBundle = { schemaVersion: 5, status, tables, reports: { finance, months: { "2026-03": { finance, students, packages } }, qa: [] }, audit: { sources: { manifest: [] }, opening_baselines_to_write: [] }, controlValuesHash: sha256("[]"), previousStatus };
  let liveRows: unknown[][] = [["field", "value"], ...Object.entries(previousStatus)];
  let committed = false;
  let afterCommitTimeout = false;
  let beforeCommitFailure = false;
  const files = new Map<string, Buffer>();
  const legacy = [{ properties: { sheetId: 797927364, title: "Package Control", hidden: false, gridProperties: { rowCount: 20_000, columnCount: 19 } } }, { properties: { sheetId: 2000001001, title: "Model Status", hidden: true, gridProperties: { rowCount: 200, columnCount: 3 } } }];
  const google = {
    email: "owner@example.com", pendingAudience: [], share: vi.fn().mockResolvedValue(undefined), ensureFolder: vi.fn().mockResolvedValue("folder-id-123"),
    values: vi.fn(async (_id: string, range: string) => range.includes("Package Control") ? [] : liveRows),
    metadata: vi.fn(async (id: string) => ({ spreadsheetId: id, sheets: committed ? [...legacy.map(s => ({ properties: { ...s.properties, hidden: true } })), ...[2000011001, 2000011002, 2000011003].map(sheetId => ({ properties: { sheetId, hidden: false, gridProperties: { rowCount: 100, columnCount: 12 } } }))] : legacy })),
    createWorkbook: vi.fn().mockResolvedValue("monthly-report-123"), writeTabs: vi.fn().mockResolvedValue(undefined), verifyTabs: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn(async (_folder: string, _name: string, bytes: Buffer) => { const id = `file-id-${files.size}-123`; files.set(id, bytes); return { id }; }),
    bytes: vi.fn(async (id: string) => { const result = files.get(id); if (!result) throw new Error("Archive inaccessible"); return result; }),
    batch: vi.fn(async (_id: string, requests: Array<Record<string, any>>) => {
      if (!requests.some(r => r.copyPaste)) return;
      if (beforeCommitFailure) throw new Error("Atomic commit rejected before mutation");
      const marker = requests.find(r => r.updateCells?.range?.sheetId === 2000001001)!.updateCells;
      liveRows = marker.rows.map((row: { values: Array<{ userEnteredValue?: Record<string, unknown> }> }) => row.values.map(cell => Object.values(cell.userEnteredValue ?? {})[0] ?? ""));
      committed = true;
      if (afterCommitTimeout) throw new Error("Network timeout after committed batch");
    }),
  };
  return { bundle, google, files, setBeforeFailure: () => { beforeCommitFailure = true; }, setAfterTimeout: () => { afterCommitTimeout = true; } };
}

describe("V5 publication retry and failure boundaries", () => {
  it("recognizes an uncertain successful commit and deduplicates the next run", async () => {
    const h = publicationHarness(); h.setAfterTimeout();
    const dir = mkdtempSync(join(tmpdir(), "unearned-test-"));
    try {
      const input = { google: h.google as never, bundle: h.bundle, bundleHash: "bundle", spreadsheetId: "main-report-123", rollbackId: "rollback-id-123", statePath: join(dir, "state.json"), commit: true };
      expect((await publishBundle(input)).status).toBe("published");
      expect((await publishBundle(input)).status).toBe("unchanged");
      expect(h.google.batch.mock.calls.filter(([, requests]) => requests.some(r => r.copyPaste))).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true }); }
  });
  it("retains the previous publication if the atomic request is rejected", async () => {
    const h = publicationHarness(); h.setBeforeFailure();
    const dir = mkdtempSync(join(tmpdir(), "unearned-test-"));
    try {
      await expect(publishBundle({ google: h.google as never, bundle: h.bundle, bundleHash: "bundle", spreadsheetId: "main-report-123", rollbackId: "rollback-id-123", statePath: join(dir, "state.json"), commit: true })).rejects.toThrow(/rejected/);
      expect(await h.google.values("main-report-123", "Model Status")).toContainEqual(["run_id", "last-good"]);
    } finally { rmSync(dir, { recursive: true }); }
  });
  it("blocks publication when an uploaded archive cannot be read back", async () => {
    const h = publicationHarness(); h.google.bytes.mockRejectedValue(new Error("Archive inaccessible"));
    const dir = mkdtempSync(join(tmpdir(), "unearned-test-"));
    try {
      await expect(publishBundle({ google: h.google as never, bundle: h.bundle, bundleHash: "bundle", spreadsheetId: "main-report-123", rollbackId: "rollback-id-123", statePath: join(dir, "state.json"), commit: true })).rejects.toThrow(/inaccessible/);
      expect(h.google.batch).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true }); }
  });
});
