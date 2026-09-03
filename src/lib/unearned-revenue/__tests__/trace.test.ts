import { describe, expect, it } from "vitest";

import { buildGoogleSheetTraceUrl, makeTraceAnchor } from "@/lib/unearned-revenue/trace";

describe("unearned revenue Google trace links", () => {
  it("uses immutable spreadsheet and current numeric sheet IDs with an A1 anchor", () => {
    expect(buildGoogleSheetTraceUrl("sheet/id", 123456, "AA42")).toBe(
      "https://docs.google.com/spreadsheets/d/sheet%2Fid/edit#gid=123456&range=AA42",
    );
    expect(makeTraceAnchor({ spreadsheetId: "abc", sheetId: 9, row: 17, a1: "A17:AZ17" }))
      .toMatchObject({ row: 17, url: expect.stringContaining("#gid=9&range=A17%3AAZ17") });
  });
});
