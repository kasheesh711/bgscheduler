import { describe, expect, it } from "vitest";
import { buildTurnoverMonths, buildWorkforcePersonStates } from "../turnover";
import type { WorkforceEvidence, WorkforcePerson, WorkforceQuery, WorkforceSession } from "../types";

const now = new Date("2026-10-01T09:00:00Z");
const query: WorkforceQuery = { from: "2026-09-01", to: "2026-09-30", viewMonth: "2026-09", role: "all", modality: "all" };
function person(key: string, changes: Partial<WorkforcePerson> = {}): WorkforcePerson {
  return { canonicalKey: key, displayName: key, role: "tutor", rosterState: "active", joinedAt: "2026-01-01T00:00:00Z", accounts: [], firstObservedAt: null, lastObservedAt: null, identityCompleteness: "complete", reasonCodes: [], ...changes };
}
function session(key: string, changes: Partial<WorkforceSession> = {}): WorkforceSession {
  return { wiseSessionId: key, wiseClassId: "c", classTitle: "Math", startAt: "2026-09-20T02:00:00Z", endAt: "2026-09-20T03:00:00Z", scheduledMinutes: 60, canonicalTutorKeys: [key], historicalBookedStudentIds: ["student"], participantCompleteness: "complete", completeness: "complete", meetingStatus: "ENDED", attendanceStatus: null, modality: "onsite", subject: "Math", curriculum: null, level: null, directTeachingEvidence: { minutes: 60, source: "fixture", evidenceId: key }, reasonCodes: [], ...changes };
}
function evidence(people: WorkforcePerson[], sessions: WorkforceSession[] = []): WorkforceEvidence {
  const coverage = { requestedFrom: "2026-03-01", requestedTo: "2026-10-01", returnedFrom: "2026-03-01", returnedTo: "2026-10-01", observedAt: now.toISOString(), pagesRequested: 1, pagesReturned: 1, recordsReturned: sessions.length, truncated: false, completeness: "complete" as const, issueCodes: [] };
  return { people, sessions, observations: [], tutorFacts: [], historicalBookedParticipants: [], studentCredits: [], subjectMappings: [], terminationMarks: sessions.map(s => ({ canonicalKey: s.canonicalTutorKeys[0], effectiveAt: null, markedAt: now.toISOString(), status: "complete", sourceId: s.wiseSessionId })), sourceCoverage: [{ ...coverage, source: "wise_history" }, { ...coverage, source: "wise_future_snapshot" }, { ...coverage, source: "termination_sheet" }] };
}
describe("monthly reconstructed Wise roster", () => {
  it("uses opening roster: three departures among sixty is five percent", () => {
    const people = Array.from({ length: 60 }, (_, i) => person(String(i)));
    people.push(person("new1", { joinedAt: "2026-09-05T00:00:00Z" }), person("new2", { joinedAt: "2026-09-10T00:00:00Z" }));
    const row = buildTurnoverMonths(evidence(people, [session("0"), session("1"), session("2")]), query, now)[0];
    expect(row.openingRosterCount.value).toBe(60);
    expect(row.departuresCount.value).toBe(3);
    expect(row.joinsCount.value).toBe(2);
    expect(row.closingRosterCount.value).toBe(59);
    expect(row.turnoverPercent.value).toBe(5);
  });
  it("counts linked accounts once using their earliest join", () => {
    const account = { wiseTeacherId: "t", wiseUserId: "u", joinedAt: "2026-08-01T00:00:00Z", relation: "TEACHER", modality: "online" as const };
    const rows = buildTurnoverMonths(evidence([person("one", { joinedAt: "2026-09-05T00:00:00Z", accounts: [account] }), person("one")]), query, now);
    expect(rows[0].openingRosterCount.value).toBe(1);
    expect(rows[0].joinsCount.value).toBe(0);
  });
  it("keeps marked tutors with future classes pending even for an older report", () => {
    const data = evidence([person("n")], [session("n"), session("future", { canonicalTutorKeys: ["n"], startAt: "2026-10-20T02:00:00Z", endAt: "2026-10-20T03:00:00Z", meetingStatus: "FUTURE", directTeachingEvidence: null })]);
    const row = buildTurnoverMonths(data, query, now)[0];
    expect(row.departuresCount.value).toBe(0);
    expect(buildWorkforcePersonStates(data, now)[0].pendingDeparture).toBe(true);
  });
  it("uses current future membership when an old booking has been removed", () => {
    const data = evidence([person("p")], [session("p"), session("removed", { canonicalTutorKeys: ["p"], startAt: "2026-10-20T02:00:00Z", endAt: "2026-10-20T03:00:00Z", meetingStatus: "FUTURE", reasonCodes: ["absent_from_current_future_snapshot"] })]);
    const state = buildWorkforcePersonStates(data, now)[0];
    expect(state.pendingDeparture).toBe(false);
    expect(state.departedAt).toBe("2026-09-20T03:00:00.000Z");
    expect(data.sessions).toHaveLength(2);
  });
  it("does not extend the last day with cancellations or student no-shows", () => {
    const data = evidence([person("p")], [session("p"), session("cancel", { canonicalTutorKeys: ["p"], startAt: "2026-10-02T02:00:00Z", endAt: "2026-10-02T03:00:00Z", meetingStatus: "CANCELLED" }), session("absent", { canonicalTutorKeys: ["p"], startAt: "2026-09-30T02:00:00Z", endAt: "2026-09-30T03:00:00Z", attendanceStatus: "STUDENT_NO_SHOW" })]);
    expect(buildWorkforcePersonStates(data, now)[0].departedAt).toBe("2026-09-20T03:00:00.000Z");
  });
  it("leaves an uncertain later class visible instead of choosing an earlier final day", () => {
    const data = evidence([person("p")], [session("p"), session("unknown", { canonicalTutorKeys: ["p"], startAt: "2026-09-30T02:00:00Z", endAt: "2026-09-30T03:00:00Z", directTeachingEvidence: null })]);
    const state = buildWorkforcePersonStates(data, now)[0];
    expect(state.departedAt).toBeNull();
    expect(state.reasonCodes).toContain("DEPARTURE_DATE_UNCONFIRMED");
    expect(buildTurnoverMonths(data, query, now)[0].turnoverPercent.value).toBeNull();
  });
  it("uses Bangkok month boundaries and retains a join and exit in the same month", () => {
    const data = evidence([person("p", { joinedAt: "2026-08-31T18:00:00Z" })], [session("p", { startAt: "2026-09-30T16:00:00Z", endAt: "2026-09-30T16:59:00Z" })]);
    const row = buildTurnoverMonths(data, query, now)[0];
    expect(row.openingRosterCount.value).toBe(0);
    expect(row.joinsCount.value).toBe(1);
    expect(row.departuresCount.value).toBe(1);
    expect(row.turnoverPercent.value).toBeNull();
  });
  it("includes teaching admins awaiting first class but excludes unsupported admin roles", () => {
    const account = { wiseTeacherId: "a", wiseUserId: "a", joinedAt: null, relation: "ADMIN", modality: null };
    const data = evidence([person("teacher-admin", { role: null, accounts: [account] }), person("office-admin", { role: null, accounts: [{ ...account, wiseTeacherId: "b" }] })]);
    data.observations.push({ id: "o", canonicalKey: "teacher-admin", observedAt: now.toISOString(), source: "fixture", role: null, accounts: [account], qualifications: [{ subject: "Math", curriculum: null, level: null, modality: null }], offeredWindows: [], leaves: [], availabilityCompleteness: "complete", qualificationCompleteness: "complete", completeness: "complete", reasonCodes: [] });
    const states = buildWorkforcePersonStates(data, now);
    expect(states.find(s => s.canonicalKey === "teacher-admin")?.role).toBe("teaching_admin");
    expect(states.find(s => s.canonicalKey === "office-admin")?.role).toBeNull();
    expect(buildTurnoverMonths(data, { ...query, role: "teaching_admin" }, now)[0].openingRosterCount.value).toBe(1);
  });
  it("reports missing join dates without a made-up turnover rate", () => {
    const row = buildTurnoverMonths(evidence([person("p", { joinedAt: null })]), query, now)[0];
    expect(row.openingRosterCount.completeness).toBe("partial");
    expect(row.turnoverPercent.value).toBeNull();
    expect(row.openingRosterCount.reasonCodes).toContain("JOIN_DATE_UNKNOWN");
  });
  it("requires history after the candidate and a fresh future snapshot", () => {
    const data = evidence([person("p")], [session("p")]);
    data.sourceCoverage = data.sourceCoverage.filter(c => c.source !== "wise_history");
    expect(buildWorkforcePersonStates(data, now)[0].departedAt).toBeNull();
    data.sourceCoverage = evidence([], []).sourceCoverage.map(c => c.source === "wise_future_snapshot" ? { ...c, observedAt: "2026-09-01T00:00:00Z" } : c);
    expect(buildWorkforcePersonStates(data, now)[0].departedAt).toBeNull();
  });
  it("does not backdate current qualifications to create historical subject rosters", () => {
    const row = buildTurnoverMonths(evidence([person("p")]), { ...query, subject: "Math" }, now)[0];
    expect(row.turnoverPercent.value).toBeNull();
    expect(row.openingRosterCount.reasonCodes).toContain("HISTORICAL_QUALIFICATIONS_UNAVAILABLE");
  });
  it("does not turn a failed termination source into zero turnover", () => {
    const data = evidence([person("p")]);
    data.sourceCoverage = data.sourceCoverage.filter(c => c.source !== "termination_sheet");
    const row = buildTurnoverMonths(data, query, now)[0];
    expect(row.departuresCount.completeness).toBe("partial");
    expect(row.turnoverPercent.value).toBeNull();
    expect(row.turnoverPercent.reasonCodes).toContain("TERMINATION_SOURCE_INCOMPLETE");
  });
});
