import { describe, expect, it } from "vitest";
import { hasCompetitorIntelligenceAccess } from "@/lib/competitor-intelligence/access-policy";

describe("competitor intelligence access", () => {
  it("allows full-access admins", () => {
    expect(hasCompetitorIntelligenceAccess(null, "admin")).toBe(true);
  });

  it("allows restricted management or marketing users with the page prefix", () => {
    expect(hasCompetitorIntelligenceAccess(["/competitor-intelligence"], "admin")).toBe(true);
  });

  it("denies restricted admins without the page prefix", () => {
    expect(hasCompetitorIntelligenceAccess(["/sales-dashboard"], "admin")).toBe(false);
  });

  it("denies teacher-role sessions", () => {
    expect(hasCompetitorIntelligenceAccess(null, "teacher")).toBe(false);
  });
});
