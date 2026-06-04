import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const candidateUtils = require("../../../../extensions/line-oa-resolver/candidate-utils.js") as {
  collapseVisualRows: (hits: Array<Record<string, unknown>>, options?: { limit?: number }) => Array<Record<string, unknown>>;
  rectIsInSearchColumn: (rect: Record<string, number>, inputRect: Record<string, number>) => boolean;
  classifyRepeatedSameChat: (
    recentCaptures: Array<Record<string, unknown>>,
    nextCapture: Record<string, unknown>,
    options?: { windowSize?: number },
  ) => { suspect: boolean; recent: Array<Record<string, unknown>>; lineUserId: string | null };
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

  it("does not flag repeated same LINE account for sibling rows", () => {
    const recent = [
      {
        lineUserId: "U-family",
        studentKey: "teddy::parent",
        searchCode: "Teddy.Di",
        searchCodes: ["Teddy.Di", "Luella.Di", "Oliver.Di"],
        parentName: "Diskul Family",
      },
      {
        lineUserId: "U-family",
        studentKey: "luella::parent",
        searchCode: "Luella.Di",
        searchCodes: ["Teddy.Di", "Luella.Di", "Oliver.Di"],
        parentName: "Diskul Family",
      },
    ];

    expect(candidateUtils.classifyRepeatedSameChat(recent, {
      lineUserId: "U-family",
      studentKey: "oliver::parent",
      searchCode: "Oliver.Di",
      searchCodes: ["Teddy.Di", "Luella.Di", "Oliver.Di"],
      parentName: "Diskul Family",
    })).toMatchObject({ suspect: false });
  });

  it("flags repeated same LINE account for unrelated rows", () => {
    const recent = [
      {
        lineUserId: "U-stuck",
        studentKey: "student-a::parent-a",
        searchCode: "A.One",
        searchCodes: ["A.One"],
        parentName: "Parent A",
      },
      {
        lineUserId: "U-stuck",
        studentKey: "student-b::parent-b",
        searchCode: "B.Two",
        searchCodes: ["B.Two"],
        parentName: "Parent B",
      },
    ];

    expect(candidateUtils.classifyRepeatedSameChat(recent, {
      lineUserId: "U-stuck",
      studentKey: "student-c::parent-c",
      searchCode: "C.Three",
      searchCodes: ["C.Three"],
      parentName: "Parent C",
    })).toMatchObject({ suspect: true });
  });
});
