import { describe, expect, it } from "vitest";
import { initialWorkflowStatus } from "../data";
import { normalizeTutorLookupKey } from "../matching";

describe("leave request matching helpers", () => {
  it("normalizes tutor names for Wise identity lookup", () => {
    expect(normalizeTutorLookupKey(" Kevin (Kev) Y. Hsieh Online ")).toBe("kevin kev y hsieh");
    expect(normalizeTutorLookupKey("Paojuu / Paoju")).toBe("paojuu paoju");
  });

  it("routes unresolved or ambiguous rows to needs review", () => {
    expect(initialWorkflowStatus({
      normalizationStatus: "needs_review",
      matchConfidence: "name",
      sourceSheetStatus: null,
    })).toBe("needs_review");
    expect(initialWorkflowStatus({
      normalizationStatus: "ok",
      matchConfidence: "unmatched",
      sourceSheetStatus: null,
    })).toBe("needs_review");
  });

  it("keeps staff-facing sheet statuses as workflow hints only", () => {
    expect(initialWorkflowStatus({
      normalizationStatus: "ok",
      matchConfidence: "email",
      sourceSheetStatus: "Completed in sheet",
    })).toBe("done");
    expect(initialWorkflowStatus({
      normalizationStatus: "ok",
      matchConfidence: "email",
      sourceSheetStatus: "Please ignore",
    })).toBe("ignored");
  });
});
