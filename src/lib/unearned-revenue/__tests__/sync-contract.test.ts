import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertStableSheetIds } from "@/lib/unearned-revenue/sync";

function tabs(offset = 0) {
  return new Map([
    "Model Status", "QA Checks", "Model Comparison", "CALC_Student_Period",
    "CALC_Account_Period", "CALC_Package_Lot_Period",
  ].map((title, index) => [title, {
    title,
    sheetId: index + 1 + offset,
    rowCount: 100,
    columnCount: 40,
  }]));
}

function v3Tabs() {
  const result = tabs();
  result.set("SRC_Wise_Receipt", {
    title: "SRC_Wise_Receipt",
    sheetId: 77,
    rowCount: 100,
    columnCount: 22,
  });
  return result;
}

describe("unearned revenue staged sheet contract", () => {
  it("accepts stable numeric sheet IDs and rejects a rotating staged tab", () => {
    expect(() => assertStableSheetIds(tabs(), tabs())).not.toThrow();
    const after = tabs();
    after.set("CALC_Student_Period", { ...after.get("CALC_Student_Period")!, sheetId: 999 });
    expect(() => assertStableSheetIds(tabs(), after)).toThrow(/tab changed during import/i);
  });

  it("rejects receipt-evidence tab insertion, removal, or ID rotation during an import", () => {
    expect(() => assertStableSheetIds(v3Tabs(), v3Tabs())).not.toThrow();
    const rotated = v3Tabs();
    rotated.set("SRC_Wise_Receipt", { ...rotated.get("SRC_Wise_Receipt")!, sheetId: 78 });
    expect(() => assertStableSheetIds(v3Tabs(), rotated)).toThrow(/SRC_Wise_Receipt/i);
    expect(() => assertStableSheetIds(tabs(), v3Tabs())).toThrow(/SRC_Wise_Receipt/i);
  });
});
