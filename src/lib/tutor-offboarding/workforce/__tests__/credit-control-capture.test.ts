import { describe, expect, it } from "vitest";
import { buildCreditControlWorkforceEvidence } from "../credit-control-capture";
import type { CreditControlCaptureInput } from "../credit-control-capture";

function fixture(): CreditControlCaptureInput {
  return {
    snapshotId: "cc-1", observedAt: new Date("2026-10-01T04:00:00Z"),
    from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z"),
    sessions: ["s1", "s2", "s3", "s4"].map(_id => ({
      _id, classId: { _id: "c1", classType: "GROUP" }, title: "Physics",
      scheduledStartTime: new Date("2026-09-02T03:00:00Z"), scheduledEndTime: new Date("2026-09-02T04:00:00Z"),
      students: ["st1", "st1"], meetingStatus: "ENDED", teacherId: "t1", purpose: "REGULAR",
    })),
    pairs: [{ wiseClassId: "c1", wiseStudentId: "st1", creditsObservedAt: new Date("2026-10-01T02:00:00Z"), history: [
      { raw: { _id: "s1", type: "SESSION", credit: 1, _workforceRawCreditEvidence: true } },
      { raw: { _id: "s2", type: "SESSION", credit: 0, _workforceRawCreditEvidence: true } },
      { raw: { _id: "s3", type: "SESSION", _workforceRawCreditEvidence: true } },
      { raw: { _id: "s4", type: "SESSION", credit: 0 } },
    ] }],
  };
}
describe("Credit Control durable source adapter", () => {
  it("normalizes each exact session ledger row, preserves cached timestamps and refuses inferred zero", () => {
    const result = buildCreditControlWorkforceEvidence(fixture());
    expect(result.credits.map(row => row.netCredits)).toEqual([1, 0, null, null]);
    expect(result.credits.every(row => row.observedAt === "2026-10-01T02:00:00.000Z")).toBe(true);
    expect(result.credits.every(row => row.normalCredits === 1)).toBe(true);
    expect(result.sessions.every(row => row.participantCompleteness === "partial")).toBe(true);
    expect(result.sessions[0].bookingClassificationSource?.purpose).toBe("REGULAR");
    expect(result).toMatchObject({ complete: false, completeness: "partial" });
    expect(result.evidence.sourceCoverage[0]).toMatchObject({ completeness: "partial", source: "credit_control_observation" });
  });
  it("retains missing pair evidence as unknown rather than using a balance or another student's row", () => {
    const input = fixture();
    input.pairs[0].wiseStudentId = "other-student";
    expect(buildCreditControlWorkforceEvidence(input).credits.every(row => row.netCredits === null)).toBe(true);
  });
});
