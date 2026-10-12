import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { captureCandidateDecision } from "../capture-candidates";
const deadline = new Date("2026-10-12T16:59:59.999Z");
const session = { deadlineAt: deadline, deductionStatus: "none" };
const evidence = {
  sessionEligible: true, sessionSourceStatus: "ready", formMappingValid: true, hasBlockingGlobalSourceIssue: false,
  fieldFailures: ["combined_characters:0/300"], timingReviewRequired: false, assessmentDeadlineAt: deadline.toISOString(),
  assessment: { sourceReady: false, sourceStatus: "ready", enforcementMode: "live", objectiveViolation: false, rawOnTime: false, adjustedCompliant: false, policyApplies: true },
};
describe("deduction-only capture selection", () => {
  it("prepares absent feedback before it becomes a deadline violation", () => {
    expect(captureCandidateDecision(session, evidence)).toEqual({ capture: true, unresolved: false });
  });
  it("includes insufficient feedback under the same content rule", () => {
    expect(captureCandidateDecision(session, { ...evidence, fieldFailures: ["combined_characters:148/300"] }).capture).toBe(true);
  });
  it("excludes compliant feedback, even when some optional field checks fail", () => {
    expect(captureCandidateDecision(session, { ...evidence, fieldFailures: [], assessment: { ...evidence.assessment, rawOnTime: true, adjustedCompliant: true } }).capture).toBe(false);
  });
  it.each(["waived", "reversed"])("excludes %s decisions", deductionStatus => {
    expect(captureCandidateDecision({ ...session, deductionStatus }, evidence).capture).toBe(false);
  });
  it("retains an actual deadline violation", () => {
    expect(captureCandidateDecision(session, { ...evidence, assessment: { ...evidence.assessment, sourceReady: true, objectiveViolation: true } }).capture).toBe(true);
  });
  it("holds source failures, unknown actors, and changed deadlines", () => {
    for (const item of [undefined, { ...evidence, sessionSourceStatus: "unavailable" }, { ...evidence, timingReviewRequired: true }, { ...evidence, assessmentDeadlineAt: "2026-10-13T16:59:59.999Z" }]) {
      expect(captureCandidateDecision(session, item)).toEqual({ capture: false, unresolved: true });
    }
  });
  it("excludes exemptions and shadow enforcement", () => {
    expect(captureCandidateDecision(session, { ...evidence, assessment: { ...evidence.assessment, enforcementMode: "shadow" } }).capture).toBe(false);
    expect(captureCandidateDecision(session, { ...evidence, enforcementPaused: true }).capture).toBe(false);
    expect(captureCandidateDecision(session, { ...evidence, deductionExemption: { reason: "missed_or_no_show", source: "feedback", field: "topics", evidence: "Student absent" } }).capture).toBe(false);
  });
});
