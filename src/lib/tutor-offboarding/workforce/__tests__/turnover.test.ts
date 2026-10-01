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
  it("uses a later ENDED class without financial evidence as the confirmed resignation date", () => {
    const data = evidence([person("p")], [session("p"), session("unknown", { canonicalTutorKeys: ["p"], startAt: "2026-09-30T02:00:00Z", endAt: "2026-09-30T03:00:00Z", directTeachingEvidence: null })]);
    const state = buildWorkforcePersonStates(data, now)[0];
    expect(state.departedAt).toBe("2026-09-30T03:00:00.000Z");
    expect(state.reasonCodes).toContain("LAST_RECORDED_CLASS_DATE");
    expect(buildTurnoverMonths(data, query, now)[0].turnoverPercent.value).toBe(100);
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
  it("retains owner-confirmed dates with missing history or stale future coverage as partial provenance", () => {
    const data = evidence([person("p")], [session("p")]);
    data.sourceCoverage = data.sourceCoverage.filter(c => c.source !== "wise_history");
    expect(buildWorkforcePersonStates(data, now)[0].departedAt).toBe("2026-09-20T03:00:00.000Z");
    expect(buildWorkforcePersonStates(data, now)[0].reasonCodes).toContain("DEPARTURE_HISTORY_INCOMPLETE");
    data.sourceCoverage = evidence([], []).sourceCoverage.map(c => c.source === "wise_future_snapshot" ? { ...c, observedAt: "2026-09-01T00:00:00Z" } : c);
    expect(buildWorkforcePersonStates(data, now)[0].departedAt).toBe("2026-09-20T03:00:00.000Z");
    expect(buildTurnoverMonths(data, query, now)[0].turnoverPercent).toMatchObject({value:100,completeness:"partial"});
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


it("computes the known opening-roster rate despite partial identities and no credit/capacity history", () => {
  const data = evidence([person("confirmed"), person("retained"), person("unknown-role", {role:null}), person("office", {role:null,accounts:[{wiseTeacherId:"office",wiseUserId:"office",joinedAt:null,relation:"ADMIN",modality:null}]})], [session("confirmed", {directTeachingEvidence:null})]);
  data.sourceCoverage = data.sourceCoverage.filter(c=>c.source!=="wise_history" && c.source!=="wise_future_snapshot").map(c=>({...c,completeness:"partial",issueCodes:["unmatched_termination_identity"]}));
  const row = buildTurnoverMonths(data, query, now)[0];
  expect(row.openingRosterCount.value).toBe(2);
  expect(row.departuresCount.value).toBe(1);
  expect(row.turnoverPercent).toMatchObject({value:50,completeness:"partial"});
  expect(row.turnoverPercent.reasonCodes).toContain("TERMINATION_SOURCE_INCOMPLETE");
  expect(row.turnoverPercent.reasonCodes).toContain("DEPARTURE_HISTORY_INCOMPLETE");
  expect(row.turnoverPercent.reasonCodes).toContain("FUTURE_SNAPSHOT_UNCONFIRMED");
});

it("keeps a known nonteaching admin out of unresolved all-staff roster gates", () => {
  const data = evidence([person("tutor"),person("office",{role:null,accounts:[{wiseTeacherId:"office",wiseUserId:"office",joinedAt:null,relation:"ADMIN",modality:null}]})],[session("tutor",{directTeachingEvidence:null})]);
  const row = buildTurnoverMonths(data,query,now)[0];
  expect(row.turnoverPercent).toMatchObject({value:100,completeness:"complete"});
  expect(row.turnoverPercent.reasonCodes).not.toContain("ROLE_UNCONFIRMED");
});

it("recognizes teaching admins from recorded classes without credit evidence", () => {
  const data = evidence([person("admin",{role:null,accounts:[{wiseTeacherId:"admin",wiseUserId:"admin",joinedAt:null,relation:"ADMIN",modality:null}]})],[session("admin",{directTeachingEvidence:null})]);
  expect(buildWorkforcePersonStates(data,now)[0].role).toBe("teaching_admin");
  expect(buildTurnoverMonths(data,query,now)[0].departuresCount.value).toBe(1);
});

it("does not invent a last class for a confirmed person with only cancellations or no-shows", () => {
  const data = evidence([person("p")],[session("p",{meetingStatus:"CANCELLED"}),session("no-show",{canonicalTutorKeys:["p"],attendanceStatus:"STUDENT_NO_SHOW"})]);
  const state = buildWorkforcePersonStates(data,now)[0];
  expect(state.markedForDeparture).toBe(true);expect(state.departedAt).toBeNull();
  expect(state.reasonCodes).toContain("DEPARTURE_DATE_UNCONFIRMED");
  expect(buildTurnoverMonths(data,query,now)[0].turnoverPercent).toMatchObject({value:0,completeness:"partial"});
});

it("does not allow a rate when an included person's missing join prevents a usable opening denominator", () => {
  const data = evidence([person("p"),person("missing",{joinedAt:null})],[session("p",{directTeachingEvidence:null})]);
  const row = buildTurnoverMonths(data,query,now)[0];
  expect(row.departuresCount.value).toBe(1);expect(row.turnoverPercent.value).toBeNull();
  expect(row.turnoverPercent.reasonCodes).toContain("JOIN_DATE_UNKNOWN");
});


it("uses actual future classes to settle a previously pending-class mark but ignores cancelled confirmation", () => {
  const data = evidence([person("p")],[session("p",{directTeachingEvidence:null})]);
  data.terminationMarks[0].status="pending_classes";
  let state = buildWorkforcePersonStates(data,now)[0];
  expect(state.departedAt).toBe("2026-09-20T03:00:00.000Z");
  data.terminationMarks[0].status="cancelled";
  state=buildWorkforcePersonStates(data,now)[0];
  expect(state.markedForDeparture).toBe(false);expect(state.departedAt).toBeNull();
});

it("ignores future no-shows and missed records but retains a genuine future class as pending even without coverage", () => {
  const data = evidence([person("p")],[session("p",{directTeachingEvidence:null}),session("future-missed",{canonicalTutorKeys:["p"],startAt:"2026-10-20T02:00:00Z",endAt:"2026-10-20T03:00:00Z",meetingStatus:"MISSED"}),session("future-noshow",{canonicalTutorKeys:["p"],startAt:"2026-10-21T02:00:00Z",endAt:"2026-10-21T03:00:00Z",meetingStatus:"FUTURE",attendanceStatus:"STUDENT_NO_SHOW"})]);
  data.sourceCoverage=data.sourceCoverage.filter(c=>c.source!=="wise_future_snapshot");
  expect(buildWorkforcePersonStates(data,now)[0].departedAt).toBe("2026-09-20T03:00:00.000Z");
  data.sessions.push(session("future-real",{canonicalTutorKeys:["p"],startAt:"2026-10-22T02:00:00Z",endAt:"2026-10-22T03:00:00Z",meetingStatus:"FUTURE",directTeachingEvidence:null}));
  const state=buildWorkforcePersonStates(data,now)[0];
  expect(state.pendingDeparture).toBe(true);expect(state.departedAt).toBeNull();
});

it("keeps an invalid final date unavailable without using a credit value to infer it", () => {
  const data=evidence([person("p")],[session("p",{startAt:"invalid",endAt:null,directTeachingEvidence:null})]);
  const state=buildWorkforcePersonStates(data,now)[0];
  expect(state.departedAt).toBeNull();expect(state.reasonCodes).toContain("DEPARTURE_DATE_UNCONFIRMED");
});

it("does not extend resignation with MISSED classes even when contradictory direct evidence is present", () => {
  const data=evidence([person("p")],[session("p"),session("missed",{canonicalTutorKeys:["p"],startAt:"2026-09-30T02:00:00Z",endAt:"2026-09-30T03:00:00Z",meetingStatus:"MISSED"})]);
  expect(buildWorkforcePersonStates(data,now)[0].departedAt).toBe("2026-09-20T03:00:00.000Z");
});


it("accepts explicit owner-confirmed departure evidence when no sheet source exists", () => {
  const data=evidence([person("p"),person("retained")],[session("p",{directTeachingEvidence:null})]);
  data.sourceCoverage=data.sourceCoverage.filter(c=>c.source!=="termination_sheet");
  data.sourceCoverage.push({...data.sourceCoverage[0],source:"owner_confirmed_departures",completeness:"partial",issueCodes:["unmatched_termination_identity"]});
  const row=buildTurnoverMonths(data,query,now)[0];
  expect(row.departuresCount.value).toBe(1);
  expect(row.turnoverPercent).toMatchObject({value:50,completeness:"partial"});
});

it("uses positive direct class evidence with an unknown meeting status without relying on credits", () => {
  const data=evidence([person("p")],[session("p",{meetingStatus:"UNKNOWN"})]);
  expect(buildWorkforcePersonStates(data,now)[0].departedAt).toBe('2026-09-20T03:00:00.000Z');
});

it("keeps turnover unavailable when confirmed marks have no usable source coverage", () => {
  const data=evidence([person("p")],[session("p",{directTeachingEvidence:null})]);
  data.sourceCoverage=data.sourceCoverage.map(c=>c.source==='termination_sheet'?{...c,completeness:'unknown'}:c);
  expect(buildTurnoverMonths(data,query,now)[0].turnoverPercent.value).toBeNull();
});

it("keeps a current upcoming assignment pending when its snapshot timestamp is unverified", () => {
  const data=evidence([person("p")],[session("p",{directTeachingEvidence:null}),session("unverified",{canonicalTutorKeys:["p"],startAt:'',endAt:null,meetingStatus:'UPCOMING',directTeachingEvidence:null,reasonCodes:['SNAPSHOT_TIMESTAMP_UNVERIFIED']})]);
  data.sourceCoverage=data.sourceCoverage.map(c=>c.source==='wise_future_snapshot'?{...c,completeness:'partial'}:c);
  const state=buildWorkforcePersonStates(data,now)[0];
  expect(state.pendingDeparture).toBe(true);expect(state.departedAt).toBeNull();
  expect(state.reasonCodes).toContain('PENDING_CLASS_TIME_UNCONFIRMED');
  data.sessions[1].meetingStatus='CANCELLED';
  expect(buildWorkforcePersonStates(data,now)[0].departedAt).toBe('2026-09-20T03:00:00.000Z');
  data.sessions[1].meetingStatus='UPCOMING';data.sessions[1].attendanceStatus='STUDENT_NO_SHOW';
  expect(buildWorkforcePersonStates(data,now)[0].departedAt).toBe('2026-09-20T03:00:00.000Z');
});
