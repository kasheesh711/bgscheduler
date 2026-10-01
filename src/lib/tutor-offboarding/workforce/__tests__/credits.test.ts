import { describe, expect, it } from "vitest";
import { computeConsumedMinutes, recordedTeachingMinutes } from "../credits";
import type { WorkforceSession, StudentCreditEvidence } from "../types";
function session(changes:Partial<WorkforceSession>={}):WorkforceSession {return {wiseSessionId:"s",wiseClassId:"c",classTitle:"Math",startAt:"2026-09-01T02:00:00Z",endAt:"2026-09-01T03:00:00Z",scheduledMinutes:60,canonicalTutorKeys:["p"],historicalBookedStudentIds:["a"],participantCompleteness:"complete",completeness:"complete",meetingStatus:"ENDED",attendanceStatus:null,modality:"online",subject:"Math",curriculum:null,level:null,reasonCodes:[],...changes};}
function credit(student="a",net=1,normal:number|null=1):StudentCreditEvidence {return {wiseSessionId:"s",wiseStudentId:student,netCredits:net,normalCredits:normal,evidenceStatus:"verified",sourceInterpretation:"current_balance",observedAt:"2026-10-01T00:00:00Z",issueCodes:[]};}
describe("credit-consumed tutor time",()=>{
 it("scales a partial single charge",()=>expect(computeConsumedMinutes(session(),[credit("a",0.5)]).value).toBe(30));
 it("averages group fractions equally, including differently priced students",()=>{
  expect(computeConsumedMinutes(session({historicalBookedStudentIds:["a","b"]}),[credit("a",2,2),credit("b",5,10)]).value).toBe(45);
 });
 it("five students consume one tutor-hour, not five",()=>{
  const ids=["a","b","c","d","e"];
  expect(computeConsumedMinutes(session({historicalBookedStudentIds:ids}),ids.map(id=>credit(id))).value).toBe(60);
 });
 it("does not omit an unknown participant",()=>expect(computeConsumedMinutes(session({historicalBookedStudentIds:["a","b"]}),[credit()]).value).toBeNull());
 it("requires known historical membership and normal charge",()=>{
  expect(computeConsumedMinutes(session({participantCompleteness:"partial"}),[credit()]).value).toBeNull();
  expect(computeConsumedMinutes(session(),[credit("a",1,null)]).value).toBeNull();
 });
 it("handles verified full refunds and explicitly free sessions",()=>{
  expect(computeConsumedMinutes(session(),[credit("a",0)]).value).toBe(0);
  expect(computeConsumedMinutes(session(),[credit("a",0,0)]).value).toBe(0);
  expect(computeConsumedMinutes(session(),[{...credit("a",0,null),sourceInterpretation:"verified_session_refund"}]).value).toBe(0);
 });
 it.each([-0.1,1.1,NaN])("rejects unexplained net charge %s",net=>expect(computeConsumedMinutes(session(),[credit("a",net)]).value).toBeNull());
 it("rejects conflicting duplicate credit evidence",()=>expect(computeConsumedMinutes(session(),[credit(),credit("a",0.5)]).value).toBeNull());
 it("retains charged cancelled demand",()=>expect(computeConsumedMinutes(session({meetingStatus:"CANCELLED"}),[credit("a",0.5)]).value).toBe(30));
});
describe("recorded teaching evidence",()=>{
 it("can use positive verified net credits without knowing the normal charge",()=>expect(recordedTeachingMinutes(session(),[credit("a",1,null)]).value).toBe(60));
 it("excludes known cancellations and student no-shows",()=>{
  expect(recordedTeachingMinutes(session({meetingStatus:"CANCELLED"}),[credit()]).value).toBe(0);
  expect(recordedTeachingMinutes(session({attendanceStatus:"STUDENT_NO_SHOW"}),[credit()]).value).toBe(0);
 });
 it("keeps direct teaching evidence after a refund",()=>expect(recordedTeachingMinutes(session({directTeachingEvidence:{minutes:53,source:"presence",evidenceId:"e"}}),[credit("a",0)]).value).toBe(53));
 it("requires positive net for the ended-status fallback",()=>{
  expect(recordedTeachingMinutes(session(),[credit("a",0)]).value).toBeNull();
  expect(recordedTeachingMinutes(session(),[{...credit(),evidenceStatus:"unknown"}]).value).toBeNull();
  expect(recordedTeachingMinutes(session(),[credit(),credit("a",0)]).value).toBeNull();
 });
});
