import type { StudentCreditEvidence, WorkforceCreditCoverage, WorkforceMetric, WorkforceSession } from "./types";
const known = (value:number,reasonCodes:string[]=[]):WorkforceMetric => ({value,completeness:"complete",reasonCodes});
const unknown = (...reasonCodes:string[]):WorkforceMetric => ({value:null,completeness:"unknown",reasonCodes:[...new Set(reasonCodes)]});
const status = (value:string|null) => value?.trim().toUpperCase().replace(/[ -]+/g,"_");
export function isCancelledSession(session:WorkforceSession):boolean {
  return [session.meetingStatus,session.attendanceStatus].some(value=>["CANCELLED","CANCELED","CANCEL","DELETED"].includes(status(value)??""));
}
export function isNoShowSession(session:WorkforceSession):boolean {
  return [session.meetingStatus,session.attendanceStatus].some(value=>["NO_SHOW","NOSHOW","STUDENT_NO_SHOW","STUDENT_ABSENT"].includes(status(value)??""));
}

/** Coverage counts remain counts when a metric is converted from minutes to hours. */
export function sumCreditCoverage(metrics: Iterable<WorkforceMetric>): WorkforceCreditCoverage {
  const total: WorkforceCreditCoverage = { totalClasses: 0, computedClasses: 0, estimatedClasses: 0, unknownClasses: 0,
    returnedParticipants: 0, verifiedCreditParticipants: 0, unknownCreditParticipants: 0 };
  for (const metric of metrics) if (metric.creditCoverage) {
    for (const key of Object.keys(total) as Array<keyof WorkforceCreditCoverage>) total[key] += metric.creditCoverage[key];
  }
  return total;
}

/** Mean of all returned students' fractions. Reconstructed membership yields an estimate, never a lower bound. */
export function computeConsumedMinutes(session:WorkforceSession,credits:StudentCreditEvidence[]):WorkforceMetric {
  const minutes=session.scheduledMinutes;
  const ids=[...new Set(session.historicalBookedStudentIds??[])];
  const reconstructed = session.participantCompleteness === 'partial'
    && session.reasonCodes.includes('HISTORICAL_PARTICIPANTS_RECONSTRUCTED_FROM_RETURNED_SESSION')
    && !session.reasonCodes.includes('CONFLICTING_PARTICIPANTS');
  const fractions:number[]=[];
  const issues:string[]=[];
  if (minutes===null || !Number.isFinite(minutes) || minutes<=0) issues.push('SCHEDULED_DURATION_UNKNOWN');
  if (!ids.length || session.participantCompleteness!=='complete' && !reconstructed
    || session.reasonCodes.includes('CONFLICTING_PARTICIPANTS')) issues.push('HISTORICAL_PARTICIPANTS_INCOMPLETE');
  const byStudent = Map.groupBy(credits.filter(row => row.wiseSessionId === session.wiseSessionId), row => row.wiseStudentId);
  for (const id of ids) {
    const matches=byStudent.get(id) ?? [];
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
  const computed = issues.length === 0;
  const creditCoverage: WorkforceCreditCoverage = { totalClasses: 1, computedClasses: computed ? 1 : 0,
    estimatedClasses: computed && reconstructed ? 1 : 0, unknownClasses: computed ? 0 : 1,
    returnedParticipants: ids.length, verifiedCreditParticipants: fractions.length, unknownCreditParticipants: ids.length - fractions.length };
  if (!computed) return { ...unknown(...issues), creditCoverage };
  return { value: minutes!*fractions.reduce((sum,value)=>sum+value,0)/ids.length,
    completeness: reconstructed ? 'partial' : 'complete',
    reasonCodes: reconstructed ? ['HISTORICAL_PARTICIPANTS_INCOMPLETE','RETURNED_PARTICIPANT_CREDIT_ESTIMATE'] : [], creditCoverage };
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
