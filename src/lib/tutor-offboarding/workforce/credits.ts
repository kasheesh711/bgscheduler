import type { StudentCreditEvidence, WorkforceMetric, WorkforceSession } from "./types";
const known = (value:number,reasonCodes:string[]=[]):WorkforceMetric => ({value,completeness:"complete",reasonCodes});
const unknown = (...reasonCodes:string[]):WorkforceMetric => ({value:null,completeness:"unknown",reasonCodes:[...new Set(reasonCodes)]});
const status = (value:string|null) => value?.trim().toUpperCase().replace(/[ -]+/g,"_");
export function isCancelledSession(session:WorkforceSession):boolean {
  return [session.meetingStatus,session.attendanceStatus].some(value=>["CANCELLED","CANCELED","CANCEL","DELETED"].includes(status(value)??""));
}
export function isNoShowSession(session:WorkforceSession):boolean {
  return [session.meetingStatus,session.attendanceStatus].some(value=>["NO_SHOW","NOSHOW","STUDENT_NO_SHOW","STUDENT_ABSENT"].includes(status(value)??""));
}

/** Mean of per-student fractions, never a sum of student credits or a price-weighted mean. */
export function computeConsumedMinutes(session:WorkforceSession,credits:StudentCreditEvidence[]):WorkforceMetric {
  const minutes=session.scheduledMinutes;
  if (minutes===null || !Number.isFinite(minutes) || minutes<=0) return unknown("SCHEDULED_DURATION_UNKNOWN");
  const ids=[...new Set(session.historicalBookedStudentIds??[])];
  if (session.participantCompleteness!=="complete" || !ids.length) return unknown("HISTORICAL_PARTICIPANTS_INCOMPLETE");
  const fractions:number[]=[];
  const issues:string[]=[];
  for (const id of ids) {
    const matches=credits.filter(row=>row.wiseSessionId===session.wiseSessionId && row.wiseStudentId===id);
    const distinct=new Map(matches.map(row=>[JSON.stringify([row.netCredits,row.normalCredits,row.evidenceStatus,row.sourceInterpretation]),row]));
    if (distinct.size!==1) { issues.push(distinct.size ? "CONFLICTING_CREDIT_EVIDENCE" : "CREDIT_EVIDENCE_MISSING"); continue; }
    const row=[...distinct.values()][0];
    if (row.evidenceStatus!=="verified" || row.netCredits===null || !Number.isFinite(row.netCredits)) {
      issues.push("NET_CREDIT_UNVERIFIED"); continue;
    }
    if (row.netCredits<0) { issues.push("NEGATIVE_NET_CREDIT"); continue; }
    if (row.sourceInterpretation==="verified_session_refund" && row.netCredits===0) { fractions.push(0); continue; }
    if (row.normalCredits===null || !Number.isFinite(row.normalCredits) || row.normalCredits<0) {
      issues.push("NORMAL_CHARGE_UNKNOWN"); continue;
    }
    if (row.netCredits>row.normalCredits) { issues.push("CHARGE_ABOVE_NORMAL"); continue; }
    fractions.push(row.normalCredits===0 ? 0 : row.netCredits/row.normalCredits);
  }
  if (issues.length) return unknown(...issues);
  return known(minutes*fractions.reduce((sum,value)=>sum+value,0)/ids.length);
}

/** The fallback is a recorded-class estimate, not a measurement of attendance minutes. */
export function recordedTeachingMinutes(session:WorkforceSession,credits:StudentCreditEvidence[]):WorkforceMetric {
  if (isCancelledSession(session)) return known(0,["CANCELLED_EXCLUDED_FROM_TEACHING"]);
  if (isNoShowSession(session)) return known(0,["NO_SHOW_EXCLUDED_FROM_TEACHING"]);
  const direct=session.directTeachingEvidence;
  if (direct && Number.isFinite(direct.minutes) && direct.minutes>=0 && direct.source && direct.evidenceId) {
    return known(direct.minutes,["DIRECT_TEACHING_EVIDENCE"]);
  }
  if (status(session.meetingStatus)!=="ENDED") return unknown("TEACHING_STATUS_UNCONFIRMED");
  const relevant=credits.filter(row=>row.wiseSessionId===session.wiseSessionId);
  const groups=Map.groupBy(relevant,row=>row.wiseStudentId);
  const positive=[...groups.values()].some(rows=>{
    const values=new Set(rows.map(row=>JSON.stringify([row.netCredits,row.evidenceStatus,row.sourceInterpretation])));
    const row=rows[0];
    return values.size===1 && row.evidenceStatus==="verified" && row.netCredits!==null && Number.isFinite(row.netCredits) && row.netCredits>0;
  });
  if (!positive) return unknown("POSITIVE_NET_CREDIT_NOT_VERIFIED");
  if (session.scheduledMinutes===null || !Number.isFinite(session.scheduledMinutes) || session.scheduledMinutes<=0) return unknown("SCHEDULED_DURATION_UNKNOWN");
  return known(session.scheduledMinutes,["RECORDED_CLASS_DATA","SCHEDULED_DURATION_ESTIMATE"]);
}
