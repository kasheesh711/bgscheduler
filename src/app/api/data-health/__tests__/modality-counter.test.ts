import { describe, it, expect } from "vitest";
// Import from the dedicated helper module rather than `../route` — the route
// module transitively imports `next-auth`, whose ESM subpath `next/server`
// cannot be resolved by Vitest's bare Node resolver. `route.ts` re-exports the
// same `selectModalityIssues` as a thin wrapper so acceptance greps on the
// route module still pass; this test targets the canonical implementation.
import { selectModalityIssues } from "../modality-counter";

describe("selectModalityIssues (MOD-03 / D-10)", () => {
  const base = { entityName: "Test Tutor", message: "example" };

  it("includes both `modality` and `conflict_model` issues under a single counter", () => {
    const issues = [
      { ...base, type: "modality" },
      { ...base, type: "conflict_model" },
      { ...base, type: "tag" },
    ];
    const result = selectModalityIssues(issues);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.issueType).sort()).toEqual(["conflict_model", "modality"]);
  });

  it("returns empty list when no modality or conflict_model issues exist", () => {
    const issues = [
      { ...base, type: "tag" },
      { ...base, type: "alias" },
      { ...base, type: "completeness" },
    ];
    expect(selectModalityIssues(issues)).toHaveLength(0);
  });

  it("counts conflict_model issues even when zero `modality` issues exist (session-only scenario)", () => {
    const issues = [
      { ...base, type: "conflict_model" },
      { ...base, type: "conflict_model" },
    ];
    const result = selectModalityIssues(issues);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.issueType === "conflict_model")).toBe(true);
  });

  it("preserves entityName and message in the projected shape", () => {
    const issues = [
      { type: "modality", entityName: "Kevin H.", message: "Cannot determine modality" },
    ];
    const [first] = selectModalityIssues(issues);
    expect(first.entityName).toBe("Kevin H.");
    expect(first.message).toBe("Cannot determine modality");
    expect(first.issueType).toBe("modality");
  });

  it("coerces null entityName to empty string", () => {
    const issues = [{ type: "conflict_model", entityName: null, message: "msg" }];
    const [first] = selectModalityIssues(issues);
    expect(first.entityName).toBe("");
  });
});
