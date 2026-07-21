import { describe, expect, it } from "vitest";
import {
  assessAiSuspect,
  characterTrigramCosineSimilarity,
  normalizeForSimilarity,
  redactKnownNames,
} from "../similarity";

describe("post-class feedback similarity", () => {
  it("redacts known names with stable placeholders", () => {
    expect(redactKnownNames("Mali worked with Kevin. Mali improved.", {
      studentNames: ["Mali"],
      tutorNames: ["Kevin"],
    })).toBe("[STUDENT_1] worked with [TUTOR]. [STUDENT_1] improved.");
    expect(redactKnownNames("Planning helped Ann.", { studentNames: ["Ann"] }))
      .toBe("Planning helped [STUDENT_1].");
  });

  it("redacts known full-name components and Wise tutor variants", () => {
    expect(redactKnownNames("Amy worked with Kevin today.", {
      studentNames: ["Amy Smith"],
      tutorNames: ["Kevin Hsieh - Online"],
    })).toBe("[STUDENT_1] worked with [TUTOR] today.");
    expect(redactKnownNames("Amy Smith and Amy Jones", {
      studentNames: ["Amy Smith", "Amy Jones"],
    })).toBe("[STUDENT_2] and [STUDENT_1]");
  });

  it("normalizes different student names before comparing feedback", () => {
    const left = normalizeForSimilarity({
      topics: "Mali studied fractions",
      performance: "Mali accurately compared fractions",
      improvement: "Mali should practise denominators",
      homework: "",
    }, { studentNames: ["Mali"] });
    const right = normalizeForSimilarity({
      topics: "Nina studied fractions",
      performance: "Nina accurately compared fractions",
      improvement: "Nina should practise denominators",
      homework: "",
    }, { studentNames: ["Nina"] });
    expect(characterTrigramCosineSimilarity(left, right)).toBe(1);
  });

  it("triggers deterministic review reasons at exact boundaries", () => {
    const fields = {
      topics: "T".repeat(49),
      performance: "P".repeat(125),
      improvement: "I".repeat(126),
      homework: "",
    };
    const result = assessAiSuspect(fields);
    expect(result.reasons).toContain("short_required_field");
    expect(result.reasons).toContain("borderline_total_length");
  });

  it("flags feedback at or above 85% similarity to prior feedback", () => {
    const fields = {
      topics: "We studied linear equations and substitution in several examples.",
      performance: "The student solved the examples accurately and explained each step.",
      improvement: "Next, practise word problems because this will improve equation setup.",
      homework: "",
    };
    const result = assessAiSuspect(fields, {
      priorFeedback: [{ key: "prior", fields }],
    });
    expect(result.highestPriorSimilarity).toBe(1);
    expect(result.matchingPriorKey).toBe("prior");
    expect(result.reasons).toContain("similar_prior_feedback");
  });
});
