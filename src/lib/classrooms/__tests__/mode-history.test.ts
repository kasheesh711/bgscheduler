import { describe, expect, it } from "vitest";
import { compareStudentEvidence, studentModeEvidence, type ModeObservation } from "../mode-history";
import { observationsFromWise } from "../mode-history-data";

const now = new Date("2026-09-18T00:00:00Z");
const row = (changes: Partial<ModeObservation> = {}): ModeObservation => ({ wiseSessionId: "lesson", studentId: "student", rosterKey: "exact-roster",
  mode: "onsite", scheduledStartAt: "2026-08-01T02:00:00Z", scheduledEndAt: "2026-08-01T03:00:00Z",
  observedAt: "2026-07-31T00:00:00Z", attended: false, cancelled: false, ...changes });
const online = row({ mode: "online", observedAt: "2026-08-02T00:00:00Z", attended: true });
const evidence = (rows: ModeObservation[]) => studentModeEvidence(rows, ["student"], now).get("student")!;

describe("student modality evidence", () => {
  it("counts a same-ID transition once despite duplicate sync observations", () => {
    const result = evidence([row(), row(), online, { ...online, observedAt: "2026-08-03T00:00:00Z" }]);
    expect(result).toMatchObject({ tier: "verified_switches", verifiedSwitches: 1, observedOnsiteLessons: 1,
      onlineAttended: 1, attendedLessons: 1, adjustedFrequency: 0.25, firstLessonAt: online.scheduledStartAt });
  });
  it("labels online-only observations as attendance fallback, never a switch", () => {
    expect(evidence([online])).toMatchObject({ tier: "online_attendance", verifiedSwitches: 0, adjustedFrequency: 0.25 });
  });
  it("does not connect cancellations, recreated sessions, changed rosters or rescheduled occurrences", () => {
    expect(evidence([row({ cancelled: true }), { ...online, wiseSessionId: "new-id" }]).verifiedSwitches).toBe(0);
    expect(evidence([row(), { ...online, rosterKey: "changed" }]).verifiedSwitches).toBe(0);
    expect(evidence([row(), { ...online, scheduledStartAt: "2026-08-02T02:00:00Z" }]).verifiedSwitches).toBe(0);
    expect(evidence([row(), { ...online, cancelled: true }]).tier).toBe("unknown");
    expect(evidence([row(), { ...online, attended: false }]).tier).toBe("unknown");
  });
  it("ignores future observations and lessons beyond the 180-day window", () => {
    expect(evidence([row({ attended: true, observedAt: "2026-09-19T00:00:00Z" })]).tier).toBe("unknown");
    expect(evidence([row({ attended: true, scheduledStartAt: "2026-03-01T00:00:00Z", scheduledEndAt: "2026-03-01T01:00:00Z" })]).tier).toBe("unknown");
    expect(evidence([row({ attended: true })]).tier).toBe("onsite_only");
  });
  it("attendance-only bootstrap evidence cannot fabricate a transition or erase stronger evidence", () => {
    const fallback = { ...online, rosterKey: "attendance-only:hash", observedAt: "2026-08-04T00:00:00Z" };
    expect(evidence([row(), fallback])).toMatchObject({ tier: "online_attendance", verifiedSwitches: 0 });
    expect(evidence([row(), online, fallback])).toMatchObject({ tier: "verified_switches", verifiedSwitches: 1 });
    expect(evidence([row(), online, { ...fallback, observedAt: online.observedAt }])).toMatchObject({ tier: "verified_switches", verifiedSwitches: 1 });
    expect(evidence([row(), { ...online, attended: false }, online])).toMatchObject({ tier: "verified_switches", verifiedSwitches: 1 });
  });
  it("ranks evidence tiers before adjusted frequency, then volume and recency", () => {
    const verified = evidence([row(), online]);
    const frequentOnline = evidence(Array.from({ length: 10 }, (_, i) => ({ ...online, wiseSessionId: `s${i}` })));
    expect(compareStudentEvidence(verified, frequentOnline)).toBeLessThan(0);
    expect(compareStudentEvidence(frequentOnline, evidence([online]))).toBeLessThan(0);
    expect(compareStudentEvidence(evidence([row({ attended: true })]), evidence([]))).toBeLessThan(0);
    expect(compareStudentEvidence({ ...verified, adjustedFrequency: 0.4 }, verified)).toBeLessThan(0);
    expect(compareStudentEvidence({ ...verified, observedOnsiteLessons: 3 }, verified)).toBeLessThan(0);
    expect(compareStudentEvidence({ ...verified, lastOnlineAt: "2026-09-01" }, verified)).toBeLessThan(0);
  });
  it("requires explicit rosters and positive per-student attendance; names and class credits do not count", () => {
    const session = { _id: "id", type: "SCHEDULED", meetingStatus: "ENDED", scheduledStartTime: online.scheduledStartAt,
      scheduledEndTime: online.scheduledEndAt, students: ["s"], participants: [{ _id: "s", creditApplied: 1 }, { _id: "t", role: "teacher", creditsConsumed: 1 }] };
    expect(observationsFromWise([session], now)).toMatchObject([{ studentId: "s", attended: true, mode: "online" }]);
    expect(observationsFromWise([{ ...session, students: undefined }], now)).toEqual([]);
    expect(observationsFromWise([{ ...session, studentCount: 2 }], now)).toEqual([]);
    expect(observationsFromWise([{ ...session, participants: [], creditsConsumed: 5 }], now)[0].attended).toBe(false);
  });
});
