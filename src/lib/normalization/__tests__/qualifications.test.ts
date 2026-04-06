import { describe, it, expect } from "vitest";
import { normalizeTag, normalizeTeacherTags } from "../qualifications";
import type { WiseTag } from "@/lib/wise/types";

describe("normalizeTag", () => {
  it("parses Math International tag", () => {
    const tag: WiseTag = { _id: "1", name: "Math (Int.) Y2-8" };
    const result = normalizeTag(tag);
    expect(result).toEqual({
      subject: "Math",
      curriculum: "International",
      level: "Y2-8",
      sourceTag: "Math (Int.) Y2-8",
    });
  });

  it("parses Thai curriculum tag", () => {
    const tag: WiseTag = { _id: "2", name: "Math (Thai) Y2-8" };
    const result = normalizeTag(tag);
    expect(result?.curriculum).toBe("Thai");
  });

  it("parses ExamPrep tag with exam type", () => {
    const tag: WiseTag = { _id: "3", name: "Math (ExamPrep) SAT" };
    const result = normalizeTag(tag);
    expect(result).toEqual({
      subject: "Math",
      curriculum: "ExamPrep",
      level: "SAT",
      examPrep: "SAT",
      sourceTag: "Math (ExamPrep) SAT",
    });
  });

  it("parses EFL tag", () => {
    const tag: WiseTag = { _id: "4", name: "EFL (Int.) Y2-8" };
    const result = normalizeTag(tag);
    expect(result?.subject).toBe("EFL");
  });

  it("returns null for unparseable tag", () => {
    const tag: WiseTag = { _id: "5", name: "SomeRandomTag" };
    expect(normalizeTag(tag)).toBeNull();
  });
});

describe("normalizeTeacherTags", () => {
  it("collects qualifications and issues", () => {
    const tags: WiseTag[] = [
      { _id: "1", name: "Math (Int.) Y2-8" },
      { _id: "2", name: "UnknownTag" },
    ];

    const result = normalizeTeacherTags(tags, "t1", "Teacher 1");
    expect(result.qualifications).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe("tag");
  });
});
