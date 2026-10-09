import { describe, expect, it } from "vitest";
import type { AuditIssue } from "../audit-schema";
import {
  MAX_MINIMAL_FIX_WORD_SHARE,
  applyMinimalFixes,
  changedWordShare,
  lengthRatio,
  occurrences,
} from "../minimal-fix";
import { PIM_FIELDS } from "./nightly-fixtures";

/** Synthetic lesson text only. */
type Fixable = Pick<AuditIssue, "id" | "field" | "minimalFix">;

const issue = (id: string, field: Fixable["field"], minimalFix: Fixable["minimalFix"]): Fixable => ({ id, field, minimalFix });
const del = (from: string) => ({ action: "delete_span" as const, from, to: null });
const replace = (from: string, to: string | null) => ({ action: "replace_span" as const, from, to });

describe("occurrences", () => {
  it("finds every start, overlapping ones included", () => {
    expect(occurrences("aaa", "aa")).toEqual([0, 1]);
    expect(occurrences("abc", "x")).toEqual([]);
    expect(occurrences("abc", "")).toEqual([]);
  });
});

describe("applyMinimalFixes", () => {
  it("deletes a sentence without leaving a doubled space", () => {
    const result = applyMinimalFixes(PIM_FIELDS, [issue("i1", "performance", del("She hesitated on the second word problem, but once we drew a bar model she set up the subtraction correctly and checked her answer."))]);
    expect(result).toMatchObject({ ok: true, applied: 1 });
    if (!result.ok) return;
    expect(result.fields.performance).toBe("Pim found the lowest common multiple for most questions without help and rewrote each fraction carefully.");
    expect(result.fields.topics).toBe(PIM_FIELDS.topics);
  });

  it("closes the gap before punctuation and between words", () => {
    const fields = { ...PIM_FIELDS, performance: "Pim worked carefully , and she finished every question on her own today." };
    const comma = applyMinimalFixes(fields, [issue("i1", "performance", del("and she finished every question on her own"))]);
    expect(comma.ok && comma.fields.performance).toBe("Pim worked carefully , today.");
    const words = applyMinimalFixes({ ...PIM_FIELDS, performance: "Pim worked very carefully today." }, [issue("i1", "performance", del("very"))]);
    expect(words.ok && words.fields.performance).toBe("Pim worked carefully today.");
    const stop = applyMinimalFixes({ ...PIM_FIELDS, performance: "Pim checked each answer twice." }, [issue("i1", "performance", del(" twice"))]);
    expect(stop.ok && stop.fields.performance).toBe("Pim checked each answer.");
  });

  it("removes a list line whose whole content was deleted", () => {
    const fields = { ...PIM_FIELDS, improvement: "1. Simplify every answer fully.\n2. Finish the mock paper by Friday.\n3. Draw a bar model for two-step problems." };
    const result = applyMinimalFixes(fields, [issue("i1", "improvement", del("Finish the mock paper by Friday."))]);
    expect(result.ok && result.fields.improvement).toBe("1. Simplify every answer fully.\n3. Draw a bar model for two-step problems.");
  });

  it("replaces a span with the audit's replacement and clears a field", () => {
    const fields = { ...PIM_FIELDS, homework: "Finish worksheet 4 by Monday." };
    const result = applyMinimalFixes(fields, [
      issue("i1", "performance", replace("without help", "with a little help")),
      issue("i2", "homework", { action: "clear_field", from: "Finish worksheet 4 by Monday.", to: null }),
    ]);
    expect(result).toMatchObject({ ok: true, applied: 2 });
    if (!result.ok) return;
    expect(result.fields.performance).toContain("most questions with a little help and rewrote");
    expect(result.fields.homework).toBe("");
  });

  it("applies the fixes in order, against the text the earlier ones left", () => {
    const fields = { ...PIM_FIELDS, performance: "Pim solved the first problem. Pim solved the second problem quickly." };
    const ordered = applyMinimalFixes(fields, [
      issue("i1", "performance", replace("the second problem quickly", "the second problem")),
      issue("i2", "performance", del(" Pim solved the second problem.")),
    ]);
    expect(ordered.ok && ordered.fields.performance).toBe("Pim solved the first problem.");
  });

  it("refuses a fix whose span is gone or ambiguous, and an issue without a fix", () => {
    expect(applyMinimalFixes(PIM_FIELDS, [issue("i3", "topics", del("a sentence that is not there"))])).toEqual({ ok: false, reason: "fix_no_match:i3" });
    const twice = { ...PIM_FIELDS, performance: "She tried. She tried again and got it." };
    expect(applyMinimalFixes(twice, [issue("i4", "performance", del("She tried"))])).toEqual({ ok: false, reason: "fix_ambiguous:i4" });
    expect(applyMinimalFixes(PIM_FIELDS, [issue("i5", "topics", null)])).toEqual({ ok: false, reason: "no_minimal_fix:i5" });
    // Exact match only: a differently cased span is not the posted text.
    expect(applyMinimalFixes(PIM_FIELDS, [issue("i6", "topics", del("TODAY we worked"))])).toEqual({ ok: false, reason: "fix_no_match:i6" });
    // A span the first fix removed is gone for the second.
    expect(applyMinimalFixes(PIM_FIELDS, [
      issue("i7", "performance", del("rewrote each fraction carefully")),
      issue("i8", "performance", replace("rewrote each fraction carefully", "rewrote them")),
    ])).toEqual({ ok: false, reason: "fix_no_match:i8" });
    expect(applyMinimalFixes(PIM_FIELDS, [issue("i9", "topics", replace("Today", null as unknown as string))])).toEqual({ ok: false, reason: "fix_without_replacement:i9" });
  });

  it("applies two issues' identical fix once", () => {
    const result = applyMinimalFixes(PIM_FIELDS, [
      issue("i1", "performance", del(" and rewrote each fraction carefully")),
      issue("i2", "performance", del(" and rewrote each fraction carefully")),
    ]);
    expect(result).toMatchObject({ ok: true, applied: 1 });
  });

  it("refuses more than a quarter of the words changed", () => {
    const result = applyMinimalFixes(PIM_FIELDS, [
      issue("i1", "improvement", { action: "clear_field", from: PIM_FIELDS.improvement, to: null }),
      issue("i2", "performance", del(PIM_FIELDS.performance.slice(0, 120))),
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/^too_many_words_changed:\d+%$/u);
  });

  it("refuses a fix that changes nothing", () => {
    expect(applyMinimalFixes(PIM_FIELDS, [issue("i1", "topics", replace("Today", "Today"))])).toEqual({ ok: false, reason: "no_change" });
  });
});

describe("changedWordShare and lengthRatio", () => {
  it("counts a replaced word once and a deleted word once", () => {
    const base = { topics: "one two three four", performance: "", improvement: "", homework: "" };
    expect(changedWordShare(base, { ...base, topics: "one two five four" })).toBe(0.25);
    expect(changedWordShare(base, { ...base, topics: "one two four" })).toBe(0.25);
    expect(changedWordShare(base, base)).toBe(0);
    expect(MAX_MINIMAL_FIX_WORD_SHARE).toBe(0.25);
  });

  it("compares the combined length of all four fields", () => {
    const base = { topics: "abcde", performance: "abcde", improvement: "", homework: "" };
    expect(lengthRatio(base, { ...base, performance: "" })).toBe(0.5);
    expect(lengthRatio(base, { ...base, improvement: "abcdeabcde" })).toBe(2);
  });
});
