import { describe, expect, it } from "vitest";
import type { PaperLevel } from "../model";
import { canTeachUpTo, checkPaperMarks, checkRubric, computeSheet, paperNeedsCheck, rubricNeedsCheck, rubricTotals, RUBRIC_ITEMS, type MockRubric, type PaperQuestion } from "../marking-sheet";

const q = (id: string, level: PaperLevel, marks: number | null, max = 10, patch: Partial<PaperQuestion> = {}): PaperQuestion => ({
  id, level, marks, max, reason: "Seen", attempted: true, readable: marks !== null, ...patch,
});
const rules = (entries: [PaperLevel, number][]) => new Map(entries);

describe("computeSheet", () => {
  it("adds marks per level, with pass or not passed from the rule, and takes no result from the AI", () => {
    const sheet = computeSheet(
      { questions: [q("1", "Key Stage 3", 9), q("2", "Key Stage 3", 9), q("3", "IGCSE / GCSE", 3)] },
      rules([["Key Stage 3", 50], ["IGCSE / GCSE", 50]]),
    );
    expect(sheet.levels[0]).toEqual({ level: "Key Stage 3", scored: 18, max: 20, percent: 90, passPercent: 50, result: "passed" });
    expect(sheet.levels[1]).toMatchObject({ scored: 3, max: 10, percent: 30, result: "not_passed" });
    expect(sheet).toMatchObject({ total: 21, max: 30, result: "passed", canTeachUpTo: "Key Stage 3" });
  });
  it("treats a score exactly at the pass mark as a pass", () => {
    expect(computeSheet({ questions: [q("1", "AP", 5)] }, rules([["AP", 50]])).levels[4].result).toBe("passed");
  });
  it("says a level was not done when no question was tried, or none exists", () => {
    const sheet = computeSheet({ questions: [q("1", "IB SL / HL", 0, 10, { attempted: false })] }, rules([["IB SL / HL", 50]]));
    expect(sheet.levels[3].result).toBe("not_done");
    expect(sheet.levels[0].result).toBe("not_done");
    expect(sheet.result).toBe("not_passed");
  });
  it("does not guess a result with no pass mark, and keeps the marks", () => {
    const sheet = computeSheet({ questions: [q("1", "AP", 9)] }, rules([]));
    expect(sheet.levels[4]).toMatchObject({ scored: 9, passPercent: null, result: "pass_mark_missing" });
    expect(sheet).toMatchObject({ result: "pass_mark_missing", canTeachUpTo: "Pass mark missing for AP" });
  });
  it("names the level with no pass mark beside the highest level passed", () => {
    const sheet = computeSheet({ questions: [q("1", "IGCSE / GCSE", 9), q("2", "AS / A-Level", 9)] }, rules([["IGCSE / GCSE", 50]]));
    expect(sheet.canTeachUpTo).toBe("IGCSE / GCSE; pass mark missing for AS / A-Level");
  });
  it("compares the exact percentage, not the rounded one", () => {
    const sheet = computeSheet({ questions: [q("1", "AP", 2, 3)] }, rules([["AP", 66.7]]));
    expect(sheet.levels[4]).toMatchObject({ percent: 66.7, result: "not_passed" });
  });
  it("counts an unreadable answer as no marks", () => {
    const sheet = computeSheet({ questions: [q("1", "AP", null), q("2", "AP", 8)] }, rules([["AP", 50]]));
    expect(sheet.levels[4]).toMatchObject({ scored: 8, max: 20, percent: 40, result: "not_passed" });
  });
});

describe("canTeachUpTo", () => {
  it("shows the highest level passed, and ignores a failed lower level", () => {
    expect(canTeachUpTo(["AS / A-Level"])).toBe("AS / A-Level");
    expect(canTeachUpTo(["Key Stage 3", "IGCSE / GCSE"])).toBe("IGCSE / GCSE");
  });
  it("names each peer top level that was passed", () => {
    expect(canTeachUpTo(["AS / A-Level", "AP", "Key Stage 3"])).toBe("AS / A-Level, AP");
  });
  it("uses Other only when nothing higher passed, and None when nothing did", () => {
    expect(canTeachUpTo(["Other"])).toBe("Other");
    expect(canTeachUpTo(["Other", "Key Stage 3"])).toBe("Key Stage 3");
    expect(canTeachUpTo([])).toBe("None");
  });
});

describe("checkPaperMarks", () => {
  const marks = (questions: PaperQuestion[]) => ({ questions, comment: "", missingPages: null });
  it("passes good marks", () => {
    expect(checkPaperMarks(marks([q("1", "AP", 5), q("2", "AP", null)]))).toEqual([]);
  });
  it("refuses a mark above its maximum, below zero, a repeat, no maximum, and no questions", () => {
    expect(checkPaperMarks(marks([q("1", "AP", 11)]))[0]).toMatch(/11 marks of 10/);
    expect(checkPaperMarks(marks([q("1", "AP", -1)]))).toHaveLength(1);
    expect(checkPaperMarks(marks([q("1", "AP", 1), q("1", "AP", 1)]))[0]).toMatch(/twice/);
    expect(checkPaperMarks(marks([q("1", "AP", 0, 0)]))[0]).toMatch(/no maximum/);
    expect(checkPaperMarks(marks([]))[0]).toMatch(/No questions/);
  });
  it("refuses a blank mark on an answer the AI says it could read", () => {
    expect(checkPaperMarks(marks([q("1", "AP", null, 10, { readable: true })]))[0]).toMatch(/could be read/);
  });
});

describe("paperNeedsCheck", () => {
  it("is set only by an unreadable answer or a missing page", () => {
    expect(paperNeedsCheck({ questions: [q("1", "AP", 5)], comment: "", missingPages: null })).toBe(false);
    expect(paperNeedsCheck({ questions: [q("1", "AP", null)], comment: "", missingPages: null })).toBe(true);
    expect(paperNeedsCheck({ questions: [q("1", "AP", 5)], comment: "", missingPages: "Page 3" })).toBe(true);
  });
});

describe("rubric", () => {
  const rubric = (patch: Partial<MockRubric["items"]> = {}): MockRubric => ({
    items: { ...Object.fromEntries(RUBRIC_ITEMS.map((id) => [id, 10])), ...patch } as MockRubric["items"],
    comments: "",
  });
  it("has 10 items in 4 parts, worth 100", () => {
    expect(RUBRIC_ITEMS).toHaveLength(10);
    expect(rubricTotals(rubric())).toMatchObject({ total: 100, complete: true });
    expect(rubricTotals(rubric()).parts.map((p) => p.max)).toEqual([30, 30, 20, 20]);
  });
  it("adds parts, and a blank item scores nothing and needs a check", () => {
    const totals = rubricTotals(rubric({ accuracy: 7, pace: null }));
    expect(totals.parts[0].scored).toBe(27);
    expect(totals.parts[1].scored).toBe(20);
    expect(totals).toMatchObject({ total: 87, complete: false });
    expect(rubricNeedsCheck(rubric({ pace: null }))).toBe(true);
  });
  it("accepts a score between the printed bands, and refuses one off the scale", () => {
    expect(checkRubric(rubric({ accuracy: 8 }))).toEqual([]);
    expect(checkRubric(rubric({ accuracy: 0 }))).toHaveLength(1);
    expect(checkRubric(rubric({ accuracy: 11 }))).toHaveLength(1);
    expect(checkRubric(rubric({ accuracy: 7.5 }))).toHaveLength(1);
    expect(checkRubric({ items: { ...rubric().items, accuracy: undefined as never }, comments: "" })[0]).toMatch(/accuracy/);
  });
});
