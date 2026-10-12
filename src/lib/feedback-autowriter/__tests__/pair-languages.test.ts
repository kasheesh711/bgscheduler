import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import type { Database } from "@/lib/db";
import {
  buildPairLanguages,
  classifyPairLanguage,
  loadPairLanguages,
  type PairLessonRow,
} from "../pair-languages";

const CLASS_A = "6a0000000000000000000001";
const CLASS_B = "6a0000000000000000000002";

function lesson(overrides: Partial<PairLessonRow> = {}): PairLessonRow {
  return {
    wiseClassId: CLASS_A,
    tutorKey: "Kevin",
    className: "Maths Y9",
    source: "soniox",
    thaiShare: "0.01",
    endedAt: new Date("2026-10-01T10:00:00Z"),
    ...overrides,
  };
}

/** A db whose every `select()` chain settles with the next queued result (rejecting when it is an Error). */
function fakeDb(results: Array<unknown[] | Error>): Database {
  const queue = [...results];
  return {
    select: () => {
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const next = queue.shift();
          return next instanceof Error ? Promise.reject(next).then(resolve, reject) : Promise.resolve(next).then(resolve, reject);
        },
      };
      return chain;
    },
  } as unknown as Database;
}

describe("classifyPairLanguage", () => {
  it("is unknown without transcripts", () => {
    expect(classifyPairLanguage([])).toBe("unknown");
  });
  it("is english when every share is under 0.03", () => {
    expect(classifyPairLanguage([0, 0.01, 0.029])).toBe("english");
  });
  it("is not english at exactly 0.03", () => {
    expect(classifyPairLanguage([0.03])).toBe("bilingual");
  });
  it("is thai when the median is at least 0.30", () => {
    expect(classifyPairLanguage([0.1, 0.3, 0.5])).toBe("thai");
    expect(classifyPairLanguage([0.29, 0.31])).toBe("thai");
  });
  it("is bilingual when one share reaches 0.03 and the median stays under 0.30", () => {
    expect(classifyPairLanguage([0.0, 0.02, 0.2])).toBe("bilingual");
  });
});

describe("buildPairLanguages", () => {
  it("groups by class and tutor, counts zoom lessons apart and merges overrides", () => {
    const rows = buildPairLanguages([
      lesson({ thaiShare: "0.01", className: "Old name", endedAt: new Date("2026-09-01T10:00:00Z") }),
      lesson({ thaiShare: 0.02, className: "Maths Y9", endedAt: new Date("2026-10-01T10:00:00Z") }),
      lesson({ thaiShare: null, className: null, endedAt: new Date("2026-10-05T10:00:00Z") }),
      lesson({ source: "zoom", thaiShare: "0", className: null, endedAt: new Date("2026-10-08T10:00:00Z") }),
      lesson({ thaiShare: "not a number" }),
      lesson({ tutorKey: "Anna", wiseClassId: CLASS_B, className: "Physics", thaiShare: "0.5" }),
    ], [
      { wiseClassId: CLASS_A, tutorKey: "Kevin", language: "thai" },
      { wiseClassId: CLASS_B, tutorKey: "Zed", language: "english" },
    ]);
    expect(rows.map((row) => [row.tutorKey, row.wiseClassId])).toEqual([["Anna", CLASS_B], ["Kevin", CLASS_A], ["Zed", CLASS_B]]);
    const kevin = rows[1];
    expect(kevin).toMatchObject({
      className: "Maths Y9", lessons: 2, zoomLessons: 1, medianThaiShare: 0.015, maxThaiShare: 0.02,
      lastLessonAt: "2026-10-08T10:00:00.000Z", auto: "english", override: "thai", effective: "thai",
    });
    expect(rows[0]).toMatchObject({ auto: "thai", override: null, effective: "thai", lessons: 1, zoomLessons: 0 });
    expect(rows[2]).toMatchObject({
      lessons: 0, zoomLessons: 0, className: null, medianThaiShare: null, maxThaiShare: null, lastLessonAt: null,
      auto: "unknown", override: "english", effective: "english",
    });
  });
  it("sorts by tutor, then by class name falling back to the class id", () => {
    const rows = buildPairLanguages([
      lesson({ wiseClassId: CLASS_B, className: "Biology" }),
      lesson({ wiseClassId: CLASS_A, className: null }),
    ], []);
    expect(rows.map((row) => row.wiseClassId)).toEqual([CLASS_A, CLASS_B]);
  });
});

describe("loadPairLanguages", () => {
  const now = new Date("2026-10-12T00:00:00Z");

  it("returns the pairs with their overrides and the thresholds", async () => {
    const result = await loadPairLanguages(fakeDb([
      [lesson({ thaiShare: "0.4" })],
      [{ wiseClassId: CLASS_A, tutorKey: "Kevin", language: "bilingual" }],
    ]), now);
    expect(result).toMatchObject({ overridesAvailable: true, lookbackDays: 90, englishMaxThaiShare: 0.03, thaiMinMedianShare: 0.3 });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ auto: "thai", override: "bilingual", effective: "bilingual" });
  });
  it("still loads before migration 0116 (the override table missing)", async () => {
    const missing = Object.assign(new Error("Failed query"), { cause: { code: "42P01" } });
    const result = await loadPairLanguages(fakeDb([[lesson()], missing]), now);
    expect(result.overridesAvailable).toBe(false);
    expect(result.pairs.every((pair) => pair.override === null)).toBe(true);
    expect(result.pairs[0].effective).toBe("english");
  });
  it("rethrows any other override error", async () => {
    const broken = Object.assign(new Error("Failed query"), { cause: { code: "XX000" } });
    await expect(loadPairLanguages(fakeDb([[lesson()], broken]), now)).rejects.toBe(broken);
  });
});
