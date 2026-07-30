import { describe, expect, it } from "vitest";

import {
  buildPayoutCompositeFormula,
  inspectPayoutWorkbookDateState,
  parsePayoutWorkbookInventoryTsv,
  payoutGoogleDateSerial,
  payoutWorkbookRollWindows,
  payoutWorkbookTutorCell,
  payoutWorkbookTutorMatchesKey,
  planPayoutFormulaRepoint,
  resolvePayoutWorkbookTutorKeys,
  substitutePayoutSourceRange,
} from "../payout-workbook-operations";

describe("payout workbook operations", () => {
  it("builds a composite formula with escaped sheet names", () => {
    expect(buildPayoutCompositeFormula({
      sourceSheetName: "Begifted Payouts Detailed",
      deductionsSheetName: "Finance's Deductions",
    })).toBe(
      "=QUERY({'Begifted Payouts Detailed'!A2:H;"
      + "'Finance''s Deductions'!A2:H},\"where Col1 is not null\",0)",
    );
  });

  it("changes only the exact imported source range", () => {
    const formula = '=QUERY(IMPORTRANGE("id","Begifted Payouts Detailed!A:H"),'
      + '"select * where Col1 = \'Kevin\' and Col4 >= date \'"&TEXT(B4,"yyyy-mm-dd")&"\'",1)';
    const result = substitutePayoutSourceRange({
      formula,
      masterSpreadsheetId: "id",
      sourceSheetName: "Begifted Payouts Detailed",
      compositeSheetName: "Payouts With Deductions",
    });
    expect(result.after).toBe(formula.replace(
      "Begifted Payouts Detailed!A:H",
      "Payouts With Deductions!A:H",
    ));
    expect(result.after).toContain("TEXT(B4");
  });

  it("rejects absent and repeated source variants", () => {
    expect(() => substitutePayoutSourceRange({
      formula: "=SUM(H9:H)",
      masterSpreadsheetId: "id",
      sourceSheetName: "Raw",
      compositeSheetName: "Composite",
    })).toThrow(/found 0/u);
    expect(() => substitutePayoutSourceRange({
      formula: '=VSTACK(IMPORTRANGE("id","Raw!A:H"),IMPORTRANGE("id","Raw!A:H"))',
      masterSpreadsheetId: "id",
      sourceSheetName: "Raw",
      compositeSheetName: "Composite",
    })).toThrow(/found 2/u);
    expect(() => substitutePayoutSourceRange({
      formula: '=IMPORTRANGE("id","Old Raw!A:H")',
      masterSpreadsheetId: "id",
      sourceSheetName: "Raw",
      compositeSheetName: "Composite",
    })).toThrow(/found 0/u);
  });

  it("treats an already-repointed formula as an idempotent no-op", () => {
    const formula = '=QUERY(IMPORTRANGE("id","Composite!A:H"),"select *",1)';
    expect(planPayoutFormulaRepoint({
      formula,
      masterSpreadsheetId: "id",
      sourceSheetName: "Raw",
      compositeSheetName: "Composite",
    })).toMatchObject({ after: formula, alreadyRepointed: true });
  });

  it("uses numeric date serials and outgoing-anchor roll semantics", () => {
    expect(payoutGoogleDateSerial("1899-12-30")).toBe(0);
    expect(payoutGoogleDateSerial("2026-07-26")).toBe(46229);
    expect(payoutWorkbookRollWindows("2026-07")).toEqual({
      outgoing: {
        anchorMonth: "2026-07",
        windowStart: "2026-06-26",
        windowEnd: "2026-07-25",
      },
      incoming: {
        anchorMonth: "2026-08",
        windowStart: "2026-07-26",
        windowEnd: "2026-08-25",
      },
      outgoingDateSerials: [46199, 46228],
      incomingDateSerials: [46229, 46259],
    });
  });

  it("accepts only literal, consistently formatted outgoing or incoming dates", () => {
    const windows = payoutWorkbookRollWindows("2026-07");
    const cell = (value: number) => [{
      effectiveValue: value,
      userEnteredValue: value,
      formulaValue: null,
      numberFormatType: "DATE",
      error: null,
    }];
    expect(inspectPayoutWorkbookDateState(
      windows.outgoingDateSerials.map(cell),
      windows,
    )).toEqual({
      state: "outgoing",
      serials: windows.outgoingDateSerials,
    });
    expect(inspectPayoutWorkbookDateState(
      windows.incomingDateSerials.map(cell),
      windows,
    )).toEqual({
      state: "incoming",
      serials: windows.incomingDateSerials,
    });
  });

  it("rejects formulas, mixed windows, third states, and damaged date formatting", () => {
    const windows = payoutWorkbookRollWindows("2026-07");
    const cells = (
      start: number,
      end: number,
      overrides: Record<string, unknown> = {},
    ) => [start, end].map((value) => [{
      effectiveValue: value,
      userEnteredValue: value,
      formulaValue: null,
      numberFormatType: "DATE",
      error: null,
      ...overrides,
    }]);
    expect(() => inspectPayoutWorkbookDateState(
      cells(windows.outgoingDateSerials[0], windows.incomingDateSerials[1]),
      windows,
    )).toThrow(/neither the outgoing nor incoming/u);
    expect(() => inspectPayoutWorkbookDateState(cells(1, 2), windows))
      .toThrow(/neither the outgoing nor incoming/u);
    expect(() => inspectPayoutWorkbookDateState(
      cells(...windows.outgoingDateSerials, { formulaValue: "=TODAY()" }),
      windows,
    )).toThrow(/not a formula/u);
    expect(() => inspectPayoutWorkbookDateState(
      cells(...windows.outgoingDateSerials, { numberFormatType: "NUMBER" }),
      windows,
    )).toThrow(/DATE or DATE_TIME/u);
  });

  it("parses recursive inventory and maps identity from TUTOR, never filename", () => {
    const rows = parsePayoutWorkbookInventoryTsv(
      "Archive/Wrong filename\t12345678901234567890\n"
      + "Current/Also wrong\tabcdefghijklmnopqrstuv\n"
      + "duplicate\t12345678901234567890\n",
    );
    expect(rows).toEqual([
      { path: "Archive/Wrong filename", spreadsheetId: "12345678901234567890" },
      { path: "Current/Also wrong", spreadsheetId: "abcdefghijklmnopqrstuv" },
      { path: "duplicate", spreadsheetId: "12345678901234567890" },
    ]);
    expect(payoutWorkbookTutorCell([
      ["START DATE", 1],
      ["TUTOR", "Kevin"],
    ])).toBe("Kevin");
    expect(payoutWorkbookTutorMatchesKey("Kevin (Kev) Y. Hsieh", "Kevin")).toBe(true);
    expect(payoutWorkbookTutorMatchesKey("Someone Else", "Kevin")).toBe(false);
  });

  it("resolves compound and reviewed tutor identities without nickname collisions", () => {
    const keys = [
      "Fluke",
      "Fluke-Supha",
      "Nacha (Poi)",
      "Paoju",
      "Paojuu",
      "Pat",
      "Pat-Patt",
      "Prae",
      "Prae-Tarn",
      "Win",
      "Win-Bordin",
    ];

    expect(resolvePayoutWorkbookTutorKeys(
      "Suphawisit (Fluke-Supha) Boonla",
      keys,
    )).toEqual(["Fluke-Supha"]);
    expect(resolvePayoutWorkbookTutorKeys(
      "Nacha (Poi) Srinakarin",
      keys,
    )).toEqual(["Nacha (Poi)"]);
    expect(resolvePayoutWorkbookTutorKeys(
      "Prohrak (Paoju) Kruengthomya",
      keys,
    )).toEqual(["Paojuu"]);
    expect(resolvePayoutWorkbookTutorKeys(
      "Prohrak (Paoju) Kruengthomya",
      ["Paoju"],
    )).toEqual([]);
    expect(resolvePayoutWorkbookTutorKeys(
      "Pattera (Pat-Patt) Sutanthavibul",
      keys,
    )).toEqual(["Pat-Patt"]);
    expect(resolvePayoutWorkbookTutorKeys(
      "Teeratarn (Prae-Tarn) Vipattipumiprathet",
      keys,
    )).toEqual(["Prae-Tarn"]);
    expect(resolvePayoutWorkbookTutorKeys(
      "Bordin (Win-Bordin) Tanasubchusri",
      keys,
    )).toEqual(["Win-Bordin"]);
  });

  it("rejects malformed inventory records instead of silently dropping them", () => {
    expect(() => parsePayoutWorkbookInventoryTsv(
      "valid/path\t12345678901234567890\nmalformed line\n",
    )).toThrow(/line 2/u);
  });
});
