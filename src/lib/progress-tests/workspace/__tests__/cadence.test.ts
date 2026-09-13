import { describe, expect, it } from "vitest";
import { countedAttendance, needsReminder, seriesKey, verifiedInstructor, type Attendance } from "../cadence";
import { assertOwner, assertRevision, cycleNumbers, stageFor, validateMarks, type Paper } from "../model";
import { publicationReadiness } from "../publication";

const launch = new Date("2026-09-01T00:00:00Z");
const now = new Date("2026-10-01T00:00:00Z");
const row = (day: number, patch: Partial<Attendance> = {}): Attendance => ({ sessionId:`s${day}`,studentId:"student",courseId:"course",ownerKey:"tutor-a",start:new Date(launch.getTime()+day*86400000),status:"ENDED",credit:1,...patch });
describe("tutor progress-test cadence", () => {
  it("resets at launch, counts the ordinary class-8 test and keeps a late class-9 test from shifting class 16", () => {
    const rows = [row(-1),...Array.from({ length:16 },(_,i) => row(i+1))];
    const counts = countedAttendance(rows,launch,now);
    expect(counts.get(seriesKey("tutor-a","course","student"))).toHaveLength(16);
    expect(cycleNumbers(9)).toEqual([1,2]);
    expect(cycleNumbers(16)).toEqual([1,2,3]);
    const prep = { paperVersionId:"reviewed",topics:"Algebra",studentInformed:true };
    expect(stageFor(9,1,prep,false,false)).toBe("awaiting_submission");
    expect(stageFor(9,2,prep,false,false)).toBe("ready");
    expect(stageFor(16,2,prep,false,false)).toBe("awaiting_submission");
  });
  it("separates two tutors and students with different attendance in the same group course", () => {
    const rows = [row(1),row(2),row(3,{ownerKey:"tutor-b"}),row(1,{studentId:"peer"}),row(2,{studentId:"peer",credit:0})];
    const result = countedAttendance(rows,launch,now);
    expect(result.get(seriesKey("tutor-a","course","student"))).toEqual(["s1","s2"]);
    expect(result.get(seriesKey("tutor-b","course","student"))).toEqual(["s3"]);
    expect(result.get(seriesKey("tutor-a","course","peer"))).toEqual(["s1"]);
  });
  it("reconciles cancellations, refunds, rescheduled dates and instructor corrections instead of counting duplicates", () => {
    const rows = [row(1),row(1,{status:"CANCELLED"}),row(2,{credit:0}),row(3),row(3,{ownerKey:"tutor-b"}),row(4,{ownerKey:null}),row(5,{start:new Date("2026-08-31")}),row(6,{start:new Date("2027-01-01")})];
    const result = countedAttendance(rows,launch,now);
    expect(result.has(seriesKey("tutor-a","course","student"))).toBe(false);
    expect(result.get(seriesKey("tutor-b","course","student"))).toEqual(["s3"]);
  });
  it("catches up skipped milestones without repeating an acknowledged reminder", () => {
    expect(needsReminder(5,1,false)).toBe(false);
    expect(needsReminder(6,1,false)).toBe(true);
    expect(needsReminder(9,1,false)).toBe(true);
    expect(needsReminder(9,1,true)).toBe(false);
    expect(needsReminder(14,2,false)).toBe(true);
  });
  it("never resolves instructor identity from names or conflicting identifiers", () => {
    const identities = [{wiseTeacherId:"teacherA",wiseUserId:"userA",canonicalKey:"a",displayName:"Same name"},{wiseTeacherId:"teacherB",wiseUserId:"userB",canonicalKey:"b",displayName:"Same name"}];
    expect(verifiedInstructor("userA",null,identities)?.canonicalKey).toBe("a");
    expect(verifiedInstructor("unknown",null,identities)).toBeNull();
    expect(verifiedInstructor("userA","teacherB",identities)).toBeNull();
  });
});
describe("review and release invariants", () => {
  const paper: Paper = { title:"Test",instructions:"",warnings:[],questions:[{id:"q",text:"2+2?",topic:"Arithmetic",maxMarks:2,rubric:"One mark for method and one for 4.",sourcePage:null,needsVisual:false}] };
  const mark = {questionId:"q",marks:1.5,explanation:"Partial credit",answerReference:"Page 1, question 1",needsReview:false};
  it("computes totals in code and rejects missing, duplicate, excessive or unreadable answers", () => {
    expect(validateMarks(paper,[mark],true)).toEqual({earned:1.5,possible:2,percent:75});
    for (const bad of [[],[mark,mark],[{...mark,marks:3}],[{...mark,marks:NaN}],[{...mark,questionId:"other"}]]) expect(() => validateMarks(paper,bad)).toThrow();
    expect(() => validateMarks(paper,[{...mark,needsReview:true}],true)).toThrow(/flagged/);
    expect(() => validateMarks(paper,[{...mark,answerReference:""}],true)).toThrow(/reference/);
  });
  it("enforces ownership and optimistic revisions, including guessed IDs", () => {
    expect(() => assertOwner(["a"],"b")).toThrow("Record not found");
    expect(() => assertOwner([],"a")).toThrow();
    expect(() => assertOwner(null,"b")).not.toThrow();
    expect(() => assertRevision(4,3)).toThrow(/changed/);
  });
  it("keeps native publication disabled without an inferred external-link fallback", () => {
    expect(publicationReadiness().ready).toBe(false);
    expect(publicationReadiness().missing).toContain("Publication integration validation");
  });
});
