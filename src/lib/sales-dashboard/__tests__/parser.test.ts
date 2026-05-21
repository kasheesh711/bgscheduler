import { describe, expect, it } from "vitest";
import {
  extractSpreadsheetId,
  parseAdditionalSalesRows,
  parseNormalSalesRows,
} from "@/lib/sales-dashboard/parser";

const context = {
  sourceMonth: "2026-01-01",
  sourceLabel: "2026-01 Jan",
  today: new Date("2026-05-31T17:00:00.000Z"),
};

describe("sales dashboard sheet parser", () => {
  it("extracts spreadsheet IDs from Google URLs and raw IDs", () => {
    expect(extractSpreadsheetId("https://docs.google.com/spreadsheets/d/1abc_DEF-234/edit#gid=0")).toBe("1abc_DEF-234");
    expect(extractSpreadsheetId("1abcdefghijklmnopqrstuvwxyz")).toBe("1abcdefghijklmnopqrstuvwxyz");
    expect(() => extractSpreadsheetId("https://example.com/not-a-sheet")).toThrow(/Invalid Google Sheet/);
  });

  it("parses old Thai normal sales format and derives analytics fields", () => {
    const rows = [
      [],
      [],
      [
        "วันที่ชำระเงิน",
        "ผู้ขาย",
        "Student's Nickname",
        "Program",
        "Package",
        "No. of Student",
        "ยอดชำระสุทธิ",
        "Valid Until",
      ],
      ["05/01/2026", "Petch", "Minnie", "School Curriculum", "Trial", "1", "฿1,500", "19/01/2026"],
      ["10/01/2026", "Petch", "Minnie", "School Curriculum", "20-hr", "1", "20000", "01/03/2026"],
      ["10/04/2026", "Petch", "Minnie", "School Curriculum", "30-hr (free extra 1 hr)", "1", "30000", "01/05/2026"],
      ["", "Petch", "Missing Date", "School Curriculum", "20-hr", "1", "20000", "01/05/2026"],
    ];

    const parsed = parseNormalSalesRows(rows, context);

    expect(parsed).toHaveLength(3);
    expect(parsed.map((row) => row.enrollmentType)).toEqual(["Trial", "New Student", "Renewal"]);
    expect(parsed[0]).toMatchObject({
      studentNickname: "Minnie",
      paymentDate: "2026-01-05",
      paymentAmount: 1500,
      programWiseName: "Y2-8 / G1-7 (Int.)",
      packageHoursClean: "Trial",
      churnStatus: "—",
    });
    expect(parsed[2]).toMatchObject({
      packageHoursClean: "30-hr",
      churnStatus: "Churned",
    });
  });

  it("parses new English format, filters unpaid rows, and preserves prefilled enrollment type", () => {
    const rows = [
      [],
      [],
      [
        "Payment Date",
        "Already Paid?",
        "Sales Person",
        "Student's Nickname",
        "Program",
        "Package",
        "No. of Student",
        "Total Price",
        "Valid Until",
        "Enrollment Type",
      ],
      ["2026-02-01", false, "Palm", "Unpaid", "SAT", "20-hr", 1, 20000, "2026-04-01", "new"],
      ["2026-02-02", "TRUE", "Palm", "Paid", "SAT", "30-hr (free extra 1 hr)", 1, "฿30,000", "2026-04-15", "new"],
      ["2026-02-03", "yes", "Palm", "Renewed", "SAT", "20-hr", 1, 22000, "2026-05-01", "renewal"],
    ];

    const parsed = parseNormalSalesRows(rows, context);

    expect(parsed.map((row) => row.studentNickname)).toEqual(["Paid", "Renewed"]);
    expect(parsed[0]).toMatchObject({
      enrollmentType: "New Student",
      programWiseName: "SAT",
      packageHoursClean: "30-hr",
      paymentAmount: 30000,
    });
    expect(parsed[1].enrollmentType).toBe("Renewal");
  });

  it("parses additional sales rows and skips rows without payment dates", () => {
    const rows = [
      [],
      [],
      ["วันที่ชำระเงิน", "Student's Nickname", "Sales Type", "Package", "ยอดชำระสุทธิ"],
      ["2026-01-11", "Minnie", "Materials", "Workbook", "2500"],
      ["", "No Pay", "Materials", "Workbook", "2500"],
    ];

    const parsed = parseAdditionalSalesRows(rows, context);

    expect(parsed).toEqual([
      expect.objectContaining({
        studentNickname: "Minnie",
        salesType: "Materials",
        packageName: "Workbook",
        paymentAmount: 2500,
        paymentDate: "2026-01-11",
      }),
    ]);
  });
});
