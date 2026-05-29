import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const candidateUtils = require("../../../../extensions/line-oa-resolver/candidate-utils.js") as {
  collapseVisualRows: (hits: Array<Record<string, unknown>>, options?: { limit?: number }) => Array<Record<string, unknown>>;
  rectIsInSearchColumn: (rect: Record<string, number>, inputRect: Record<string, number>) => boolean;
};

function rect(top: number, left = 0, width = 360, height = 80) {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

describe("LINE OA resolver extension candidate utilities", () => {
  it("collapses nested matching elements into one visual chat row", () => {
    const rows = candidateUtils.collapseVisualRows([
      { text: "𝓟☑️ Kin/Parin.Pu\nเช็คตารางครู Tito ก่อนนะคะ", rect: rect(120), lineChatUrl: null },
      { text: "Kin/Parin.Pu", rect: rect(138, 96, 180, 24), lineChatUrl: null },
      { text: "Parin.Pu", rect: rect(164, 96, 120, 22), lineChatUrl: null },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rawDomHitCount: 3,
    });
  });

  it("keeps two distinct visible chat rows as separate candidates", () => {
    const rows = candidateUtils.collapseVisualRows([
      { text: "Mom Maida/Nasda.Su", rect: rect(120), lineChatUrl: null },
      { text: "Dad Maida/Nasda.Su", rect: rect(228), lineChatUrl: null },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.text)).toEqual([
      "Mom Maida/Nasda.Su",
      "Dad Maida/Nasda.Su",
    ]);
  });

  it("filters page chrome outside the LINE search column", () => {
    const inputRect = rect(24, 24, 320, 36);

    expect(candidateUtils.rectIsInSearchColumn(rect(96, 32, 360, 80), inputRect)).toBe(true);
    expect(candidateUtils.rectIsInSearchColumn(rect(96, 880, 360, 80), inputRect)).toBe(false);
  });
});
