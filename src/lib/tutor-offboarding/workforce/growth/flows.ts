import { computeConsumedMinutes, sumCreditCoverage } from '../credits';
import { formatInTimeZone } from 'date-fns-tz';
import { bangkokDayStart, bangkokMonthBounds } from '../intervals';
import type { WorkforceMetric, WorkforceQuality } from '../types';
import { addMonths, commonMatureWindow, GROWTH_HISTORY_FLOOR, GROWTH_CHURN_WAIT_MS, historyCoversMonth, isGrowthMonthMature, monthOf } from './calendar';
import { deriveGrowthLifecycleEvents, growthKnown, growthUnknown, hasCompleteGrowthTeachingHistory, hasFreshGrowthFutureEvidence, hasUnresolvedGrowthTeachingHistory, isActiveGrowthBooking, resolveGrowthBookings, studentNetHours } from './lifecycle';
import type { GrowthResolvedBooking } from './lifecycle';
import type { GrowthCourse, GrowthEvidence, GrowthFlows, GrowthMonthlyRow, GrowthQuery, GrowthSubjectAverages, GrowthTimePattern } from './types';

export const GROWTH_FLOWS_ALGORITHM = 'subject-flows-v1';
type MetricKey = 'newlyObservedStudents' | 'reactivatedStudents' | 'churnedStudents' | 'newStudentHours' | 'reactivatedStudentHours' | 'churnStudentHours' | 'bookedStudentHours' | 'creditStudentHours' | 'cancellationStudentHours' | 'bookedTutorHours' | 'creditTutorHours' | 'cancellationTutorHours' | 'newTutorHours' | 'reactivatedTutorHours' | 'trialStudentHours' | 'pretestStudentHours';
const metricKeys: MetricKey[] = ['newlyObservedStudents','reactivatedStudents','churnedStudents','newStudentHours','reactivatedStudentHours','churnStudentHours','bookedStudentHours','creditStudentHours','cancellationStudentHours','bookedTutorHours','creditTutorHours','cancellationTutorHours','newTutorHours','reactivatedTutorHours','trialStudentHours','pretestStudentHours'];
const sorted = (values: string[]) => [...new Set(values)].sort();
function add(row: GrowthMonthlyRow, key: MetricKey, hours: number) { const m=row[key]; m.value=(m.value ?? 0)+hours; if(m.completeness==='unknown')m.completeness='partial'; }
function limit(row: GrowthMonthlyRow, keys: MetricKey[], ...reasons: string[]) {
  for (const key of keys) { row[key].completeness = row[key].value === null ? 'unknown' : 'partial'; row[key].reasonCodes=sorted([...row[key].reasonCodes,...reasons]); }
}
/** A recorded estimate may use partial values only when numerator and denominator cover the same observations. */
function recordedRatio(numerator: WorkforceMetric, denominator: WorkforceMetric): WorkforceMetric {
  const reasons=sorted([...numerator.reasonCodes,...denominator.reasonCodes]);
  if (numerator.value===null || denominator.value===null) return growthUnknown(...reasons,'MODEL_INPUT_INCOMPLETE');
  if (denominator.value<=0) return growthUnknown(...reasons,'ZERO_DEMAND_RATIO_UNAVAILABLE');
  return {value:numerator.value/denominator.value,completeness:numerator.completeness==='complete' && denominator.completeness==='complete' ? 'complete' : 'partial',reasonCodes:reasons};
}
function sumRecorded(values: WorkforceMetric[], divide=1): WorkforceMetric {
  if (!values.length || values.some(row=>row.value===null || row.completeness==='unknown')) return growthUnknown(...sorted(values.flatMap(row=>row.reasonCodes)), 'THREE_MONTH_INPUT_INCOMPLETE');
  return {value:values.reduce((sum,row)=>sum+row.value!,0)/divide,completeness:values.some(row=>row.completeness!=='complete')?'partial':'complete',reasonCodes:sorted(values.flatMap(row=>row.reasonCodes))};
}
function dates(from: string, to: string): string[] {
  const start=from.slice(0,7), end=to.slice(0,7), result: string[]=[];
  for (let month=start;month<=end;month=addMonths(month,1)) result.push(month);
  return result;
}
function matching(booking: GrowthResolvedBooking, evidence: GrowthEvidence, query: GrowthQuery): boolean {
  const { filters }=query, course=booking.course;
  return Boolean(course && (!filters.subject || course.subject===filters.subject) && (!filters.curriculum || course.curriculum===filters.curriculum) && (!filters.level || course.level===filters.level)
    && (filters.modality==='all' || booking.session.modality===filters.modality)
    && (filters.role==='all' || booking.session.canonicalTutorKeys.some(key=>evidence.workforce.people.find(person=>person.canonicalKey===key)?.role===filters.role)));
}
function courseMatches(course: GrowthCourse,query: GrowthQuery): boolean {
  const {filters}=query;
  return (!filters.subject || filters.subject===course.subject) && (!filters.curriculum || filters.curriculum===course.curriculum) && (!filters.level || filters.level===course.level);
}
function emptyRow(course: GrowthCourse, month: string, evidence: GrowthEvidence,now: Date): GrowthMonthlyRow {
  const complete=historyCoversMonth(evidence.workforce.sourceCoverage,month);
  const metrics=Object.fromEntries(metricKeys.map(key=>[key,complete ? growthKnown(0) : growthUnknown(`HISTORY_MONTH_INCOMPLETE:${month}`)])) as Record<MetricKey,WorkforceMetric>;
  return {...course,...metrics,key:JSON.stringify([month,course.courseKey]),month,mature:isGrowthMonthMature(month,now),provisional:!isGrowthMonthMature(month,now),startingCohortExcluded:month==='2026-03',contributors:{studentIds:[],sessionIds:[],eventKeys:[]}};
}
function normalizedPatterns(bookings: GrowthResolvedBooking[],window: string[],evidence: GrowthEvidence): GrowthTimePattern[] {
  const sums=new Map<string,{course:GrowthCourse;weekday:number;startMinute:number;endMinute:number;hours:number;issues:Set<string>}>();
  const occurrences=new Map<number,number>();
  for (const month of window) {
    const bounds=bangkokMonthBounds(month);
    for(let ms=bounds.start;ms<bounds.end;ms+=86400000){const weekday=Number(formatInTimeZone(ms,'Asia/Bangkok','i'))%7;occurrences.set(weekday,(occurrences.get(weekday) ?? 0)+1);}
  }
  for(const booking of bookings) {
    if (!booking.course || booking.kind!=='regular' || !window.includes(monthOf(booking.session.startAt))) continue;
    const minutes=booking.session.scheduledMinutes;
    if(minutes===null || !Number.isFinite(minutes) || minutes<=0) continue;
    // Split overnight classes at Bangkok midnight so capacity receives valid day windows.
    let cursor=Date.parse(booking.session.startAt),remaining=minutes;
    while(remaining>0){
      const weekday=Number(formatInTimeZone(cursor,'Asia/Bangkok','i'))%7;
      const minute=Number(formatInTimeZone(cursor,'Asia/Bangkok','H'))*60+Number(formatInTimeZone(cursor,'Asia/Bangkok','m'));
      const size=Math.min(remaining,1440-minute),key=JSON.stringify([booking.course.courseKey,weekday,minute,minute+size]);
      const entry=sums.get(key) ?? {course:booking.course,weekday,startMinute:minute,endMinute:minute+size,hours:0,issues:new Set<string>()};
      entry.hours+=size/60;
      if(window.some(month=>!historyCoversMonth(evidence.workforce.sourceCoverage,month)))entry.issues.add('PATTERN_HISTORY_INCOMPLETE');
      sums.set(key,entry);remaining-=size;cursor+=size*60000;
    }
  }
  const weekly=new Map<string,number>();
  for(const entry of sums.values())weekly.set(entry.course.courseKey,(weekly.get(entry.course.courseKey) ?? 0)+entry.hours/(occurrences.get(entry.weekday) || 1));
  return [...sums.values()].map(entry=>({...entry.course,weekday:entry.weekday,startMinute:entry.startMinute,endMinute:entry.endMinute,share:(entry.hours/(occurrences.get(entry.weekday) || 1))/(weekly.get(entry.course.courseKey) || 1),completeness:entry.issues.size?'partial' as const:'complete' as const,reasonCodes:[...entry.issues]})).sort((a,b)=>a.courseKey.localeCompare(b.courseKey)||a.weekday-b.weekday||a.startMinute-b.startMinute);
}

/** Date filters affect monthly display only; inception and the common model window use retained history. */
export function buildGrowthFlows(evidence: GrowthEvidence,query: GrowthQuery,now: Date): GrowthFlows {
  const all=resolveGrowthBookings(evidence),commonWindow=commonMatureWindow(now),events=deriveGrowthLifecycleEvents(evidence,now);
  const selected=all.filter(booking=>matching(booking,evidence,query));
  const courses=new Map<string,GrowthCourse>();
  for(const booking of selected) if(booking.course) courses.set(booking.course.courseKey,booking.course);
  for(const event of events.filter(e=>e.status==='active'))for(const part of event.baselineByCourse ?? [])if(courseMatches(part.course,query))courses.set(part.course.courseKey,part.course);
  const neededMonths=sorted([...dates(query.filters.from,query.filters.to),...commonWindow,addMonths(monthOf(now),-1)]);
  const rows=new Map<string,GrowthMonthlyRow>();
  const get=(course:GrowthCourse,month:string)=>{
    const key=JSON.stringify([month,course.courseKey]);
    let row=rows.get(key);if(!row){row=emptyRow(course,month,evidence,now);rows.set(key,row);}return row;
  };
  for(const course of courses.values())for(const month of neededMonths)get(course,month);
  const starts=new Map<string,string>();
  for(const booking of all) if(booking.kind==='regular' && booking.course && !booking.session.reasonCodes.includes('absent_from_current_future_snapshot'))for(const student of booking.studentIds){
    const key=JSON.stringify([student,booking.course.subject]);if(!starts.has(key))starts.set(key,monthOf(booking.session.startAt));
  }
  const returns=new Map<string,typeof events>();
  for(const event of events.filter(e=>e.status==='active'&&e.kind==='reactivation')){const key=JSON.stringify([event.studentId,event.subject]);returns.set(key,[...(returns.get(key) ?? []),event]);}
  const studentCounts=new Map<string,Set<string>>();
  const verifiedTutorCreditRows=new Set<string>();
  const creditCoveredBookings=new Map<string,{booked:number;loss:number}>();
  const participantSupportedTutorHours=new Map<string,number>();
  const knownParticipantRows=new Set<string>(), unknownEmptyRows=new Set<string>();
  function count(row:GrowthMonthlyRow,key:'newlyObservedStudents'|'reactivatedStudents'|'churnedStudents',student:string){const id=JSON.stringify([row.key,key]);const set=studentCounts.get(id) ?? new Set<string>();if(!set.has(student)){set.add(student);add(row,key,1);}studentCounts.set(id,set);}
  for(const booking of selected){
    const {session,course,studentIds,kind}=booking;if(!course || session.reasonCodes.includes('absent_from_current_future_snapshot'))continue;
    const month=monthOf(session.startAt);if(!neededMonths.includes(month))continue;
    const row=get(course,month),duration=session.scheduledMinutes;
    row.contributors.sessionIds.push(session.wiseSessionId);row.contributors.studentIds.push(...studentIds);
    if(duration===null || !Number.isFinite(duration) || duration<=0){limit(row,metricKeys,'SCHEDULED_DURATION_UNKNOWN');continue;}
    const hours=duration/60;
    if(kind==='trial' || kind==='pretest'){
      const field=kind==='trial'?'trialStudentHours':'pretestStudentHours';add(row,field,hours*studentIds.length);
      if(session.participantCompleteness!=='complete')limit(row,[field],'HISTORICAL_PARTICIPANTS_INCOMPLETE');
      continue;
    }
    if(kind!=='regular'){limit(row,metricKeys,'BOOKING_CLASSIFICATION_UNRESOLVED');continue;}
    if(studentIds.length)knownParticipantRows.add(row.key);
    if(!studentIds.length && session.participantCompleteness!=='complete')unknownEmptyRows.add(row.key);
    if(studentIds.length || session.participantCompleteness==='complete')participantSupportedTutorHours.set(row.key,(participantSupportedTutorHours.get(row.key) ?? 0)+hours);
    add(row,'bookedStudentHours',hours*studentIds.length);add(row,'bookedTutorHours',hours);
    let newMembers=0,returnMembers=0;
    for(const student of studentIds){
      const net=studentNetHours(booking,student);
      if(net.value===null){limit(row,['creditStudentHours','cancellationStudentHours'],...net.reasonCodes);}
      else{
        const covered=creditCoveredBookings.get(row.key) ?? {booked:0,loss:0};
        covered.booked+=hours;covered.loss+=hours-net.value;creditCoveredBookings.set(row.key,covered);
        add(row,'creditStudentHours',net.value);add(row,'cancellationStudentHours',hours-net.value);}
      const key=JSON.stringify([student,course.subject]),start=starts.get(key);
      const returnEvent=returns.get(key)?.find(event=>event.effectiveMonth===month && Date.parse(session.startAt)>=Date.parse(event.returnAt!));
      if(returnEvent){count(row,'reactivatedStudents',student);add(row,'reactivatedStudentHours',hours);returnMembers++;row.contributors.eventKeys.push(returnEvent.eventKey);}
      else if(start===month && month!=='2026-03'){count(row,'newlyObservedStudents',student);add(row,'newStudentHours',hours);newMembers++;}
    }
    const consumed = computeConsumedMinutes(session,[...booking.creditsByStudent.values()].flat());
    row.creditTutorHours.creditCoverage = sumCreditCoverage([row.creditTutorHours,consumed]);
    row.cancellationTutorHours.creditCoverage = row.creditTutorHours.creditCoverage;
    if(consumed.value!==null){
      add(row,'creditTutorHours',consumed.value/60);
      add(row,'cancellationTutorHours',hours-consumed.value/60);
      verifiedTutorCreditRows.add(row.key);
      if(consumed.completeness!=='complete')limit(row,['creditTutorHours','cancellationTutorHours'],...consumed.reasonCodes);
    } else {
      if(!verifiedTutorCreditRows.has(row.key)){row.creditTutorHours.value=null;row.cancellationTutorHours.value=null;}
      limit(row,['creditTutorHours','cancellationTutorHours'],'GROUP_CREDIT_OR_MEMBERSHIP_INCOMPLETE',...consumed.reasonCodes);
    }
    if(studentIds.length){add(row,'newTutorHours',hours*newMembers/studentIds.length);add(row,'reactivatedTutorHours',hours*returnMembers/studentIds.length);}
    if(session.participantCompleteness!=='complete')limit(row,['bookedStudentHours','creditStudentHours','cancellationStudentHours','newStudentHours','reactivatedStudentHours','newTutorHours','reactivatedTutorHours','newlyObservedStudents','reactivatedStudents'],'HISTORICAL_PARTICIPANTS_INCOMPLETE');
  }
  for(const event of events.filter(e=>e.kind==='churn'&&e.status==='active')) {
    const parts=event.baselineByCourse ?? [];
    for(const part of parts){if(!courses.has(part.course.courseKey) || !neededMonths.includes(event.effectiveMonth))continue;
      const row=get(part.course,event.effectiveMonth);count(row,'churnedStudents',event.studentId);
      if(part.studentHours.value!==null)add(row,'churnStudentHours',part.studentHours.value);
      if(part.studentHours.completeness!=='complete' || part.studentHours.value===null)limit(row,['churnStudentHours'],...part.studentHours.reasonCodes);
      if(part.studentHours.value===null && row.churnStudentHours.value===0)row.churnStudentHours.value=null;
      if(event.certainty==='inferred')row.churnStudentHours.reasonCodes=sorted([...row.churnStudentHours.reasonCodes,'HISTORICAL_FUTURE_BOOKINGS_NOT_RETAINED']);
      row.contributors.studentIds.push(event.studentId);row.contributors.sessionIds.push(...event.sourceSessionIds);row.contributors.eventKeys.push(event.eventKey);
    }
    // A missing whole baseline must invalidate a flow even when no course could be reconstructed.
    if(!parts.length && event.baselineStudentHours.completeness!=='complete')for(const course of courses.values())if(course.subject===event.subject && neededMonths.includes(event.effectiveMonth)){
      const row=get(course,event.effectiveMonth);limit(row,['churnStudentHours','churnedStudents'],'CHURN_BASELINE_UNAVAILABLE');
      if(row.churnStudentHours.value===0)row.churnStudentHours.value=null;
      if(row.churnedStudents.value===0)row.churnedStudents.value=null;
    }
  }
  const unresolved=all.filter(b=>!b.course || b.kind==='unknown');
  const unknownFuture=all.some(b=>Date.parse(b.session.endAt ?? b.session.startAt)>now.getTime() && isActiveGrowthBooking(b)
    && (b.session.participantCompleteness!=='complete' || !b.course || b.kind==='unknown'));
  const futureIncomplete=!hasFreshGrowthFutureEvidence(evidence,now) || unknownFuture;
  const confirmationHistoryIncomplete=commonWindow.length>0 && !hasCompleteGrowthTeachingHistory(evidence,bangkokDayStart(GROWTH_HISTORY_FLOOR),bangkokMonthBounds(commonWindow.at(-1)!).start-1+GROWTH_CHURN_WAIT_MS);
  const inceptionMissing=commonWindow.length ? dates(GROWTH_HISTORY_FLOOR,`${commonWindow.at(-1)}-01`).filter(month=>!historyCoversMonth(evidence.workforce.sourceCoverage,month)) : [];
  const modelUnresolved=unresolved.filter(b=>monthOf(b.session.startAt)<=commonWindow.at(-1)!);
  const uncertainTeachingBySubject=new Map<string,boolean>();
  const confirmationEnd=commonWindow.length ? Math.min(now.getTime(),bangkokMonthBounds(commonWindow.at(-1)!).start-1+GROWTH_CHURN_WAIT_MS) : now.getTime();
  for(const row of rows.values()){
    // No returned learner cannot establish a zero student subtotal. Other known
    // participant classes may still establish a partial recorded subtotal.
    if(unknownEmptyRows.has(row.key) && !knownParticipantRows.has(row.key)){
      for(const field of ['bookedStudentHours','creditStudentHours','cancellationStudentHours','newStudentHours','reactivatedStudentHours','newTutorHours','reactivatedTutorHours','newlyObservedStudents','reactivatedStudents'] as const){
        row[field].value=null;row[field].completeness='unknown';
        row[field].reasonCodes=sorted([...row[field].reasonCodes,'HISTORICAL_PARTICIPANTS_UNKNOWN']);
      }
    }
    // An unmapped lesson could belong to any selected subject; its absence is not a measured zero.
    if(unresolved.some(b=>monthOf(b.session.startAt)===row.month))limit(row,metricKeys,'UNRESOLVED_BOOKING_OR_SUBJECT');
    if(modelUnresolved.length)limit(row,['newStudentHours','reactivatedStudentHours','churnStudentHours'],'COHORT_HISTORY_UNRESOLVED');
    if(inceptionMissing.length)limit(row,['newStudentHours','reactivatedStudentHours','newlyObservedStudents','reactivatedStudents'],...inceptionMissing.map(month=>`COHORT_HISTORY_MISSING:${month}`));
    if(confirmationHistoryIncomplete)limit(row,['churnStudentHours','churnedStudents'],'CHURN_CONFIRMATION_HISTORY_INCOMPLETE');
    if(!uncertainTeachingBySubject.has(row.subject))uncertainTeachingBySubject.set(row.subject,hasUnresolvedGrowthTeachingHistory(all,bangkokDayStart(GROWTH_HISTORY_FLOOR),confirmationEnd,undefined,row.subject));
    if(uncertainTeachingBySubject.get(row.subject))limit(row,['churnStudentHours','churnedStudents'],'CHURN_TEACHING_EVIDENCE_INCOMPLETE');
    if(futureIncomplete)limit(row,['churnStudentHours','churnedStudents'],'SUBJECT_CHURN_FUTURE_CHECK_INCOMPLETE');
    for(const field of ['studentIds','sessionIds','eventKeys'] as const)row.contributors[field]=sorted(row.contributors[field]);
  }
  const averages:GrowthSubjectAverages[]=[...courses.values()].map(course=>{
    const monthly=commonWindow.map(month=>get(course,month));
    const metric=(key:MetricKey)=>{
      const values=monthly.map(row=>row[key]);
      const absenceUnknown=key==='churnStudentHours' && values.some(value=>value.reasonCodes.some(reason=>[
        'CHURN_TEACHING_EVIDENCE_INCOMPLETE','SUBJECT_CHURN_FUTURE_CHECK_INCOMPLETE','CHURN_CONFIRMATION_HISTORY_INCOMPLETE','CHURN_BASELINE_UNAVAILABLE'
      ].includes(reason)));
      return commonWindow.length===3 && !absenceUnknown ? sumRecorded(values,3) : growthUnknown(...values.flatMap(v=>v.reasonCodes),absenceUnknown?'CHURN_ABSENCE_EVIDENCE_UNAVAILABLE':'COMMON_MATURE_WINDOW_UNAVAILABLE');
    };
    const matched=(row:GrowthMonthlyRow,field:'booked'|'loss'):WorkforceMetric=>{
      const covered=creditCoveredBookings.get(row.key);
      const unknown=!covered && row.bookedStudentHours.value===null;
      const partial=row.cancellationStudentHours.completeness!=='complete' || row.bookedStudentHours.completeness!=='complete';
      return {value:unknown?null:covered?.[field] ?? 0,completeness:unknown?'unknown':partial?'partial':'complete',
        reasonCodes:sorted([...row.cancellationStudentHours.reasonCodes,...row.bookedStudentHours.reasonCodes,...(partial?['MATCHED_CREDIT_BOOKINGS_ESTIMATE']:[])]),
        creditCoverage:row.creditTutorHours.creditCoverage};
    };
    const numerator=commonWindow.length===3?sumRecorded(monthly.map(row=>matched(row,'loss'))):growthUnknown('COMMON_MATURE_WINDOW_UNAVAILABLE');
    const denominator=commonWindow.length===3?sumRecorded(monthly.map(row=>matched(row,'booked'))):growthUnknown('COMMON_MATURE_WINDOW_UNAVAILABLE');
    numerator.creditCoverage=sumCreditCoverage(monthly.map(row=>row.creditTutorHours));
    denominator.creditCoverage=numerator.creditCoverage;
    const booked=commonWindow.length===3?sumRecorded(monthly.map(row=>row.bookedStudentHours)):growthUnknown('COMMON_MATURE_WINDOW_UNAVAILABLE');
    const tutor=commonWindow.length===3?sumRecorded(monthly.map(row=>({
      ...row.bookedTutorHours,value:row.bookedStudentHours.value===null?null:participantSupportedTutorHours.get(row.key) ?? 0,
      completeness:row.bookedStudentHours.value===null?'unknown':row.bookedStudentHours.completeness,
      reasonCodes:row.bookedStudentHours.reasonCodes
    }))):growthUnknown('COMMON_MATURE_WINDOW_UNAVAILABLE');
    const mix=recordedRatio(booked,tutor);
    if(mix.value!==null && mix.value<=0){mix.value=null;mix.completeness='unknown';mix.reasonCodes=sorted([...mix.reasonCodes,'ZERO_GROUP_MIX_UNAVAILABLE']);}
    return {...course,months:commonWindow,newStudentHours:metric('newStudentHours'),reactivatedStudentHours:metric('reactivatedStudentHours'),churnStudentHours:metric('churnStudentHours'),cancellationNumerator:numerator,cancellationDenominator:denominator,cancellationFraction:recordedRatio(numerator,denominator),studentHoursPerTutorHour:mix};
  }).sort((a,b)=>a.courseKey.localeCompare(b.courseKey));
  const issueCodes=sorted([...unresolved.flatMap(b=>b.reasonCodes),...averages.flatMap(row=>[row.newStudentHours,row.reactivatedStudentHours,row.churnStudentHours,row.cancellationFraction,row.studentHoursPerTutorHour].flatMap(metric=>metric.reasonCodes)),...events.flatMap(event=>event.reasonCodes.filter(reason=>reason!=='subject-lifecycle-v1' && reason!=='FRESH_FUTURE_NO_BOOKING_CHECK' && reason!=='RETURN_AFTER_CONFIRMED_CHURN'))]);
  const quality:WorkforceQuality={completeness:issueCodes.length?'partial':'complete',issueCodes,sourceCoverage:evidence.workforce.sourceCoverage,
    exceptions:unresolved.map(b=>({code:'UNRESOLVED_GROWTH_BOOKING',entityId:b.session.wiseSessionId,message:'The retained booking needs academic mapping or lesson-purpose review.'}))};
  const displayMonths=dates(query.filters.from,query.filters.to);
  // Monthly demand is evaluated at the scheduled instant, including cancellations and no-shows.
  const from=bangkokDayStart(query.filters.from),to=bangkokDayStart(query.filters.to)+86400000;
  const partialDates = from!==bangkokMonthBounds(displayMonths[0]).start || to!==bangkokMonthBounds(displayMonths.at(-1)!).end;
  if(partialDates){quality.issueCodes=sorted([...quality.issueCodes,'MONTHLY_DISPLAY_USES_CALENDAR_MONTH_TOTALS']);quality.completeness='partial';}
  return {months:[...rows.values()].filter(row=>displayMonths.includes(row.month)).sort((a,b)=>a.month.localeCompare(b.month)||a.courseKey.localeCompare(b.courseKey)),lifecycleEvents:events.filter(event=>!query.filters.subject || event.subject===query.filters.subject),commonWindow,averages,patterns:normalizedPatterns(selected,commonWindow,evidence),quality};
}
/** Institution-wide model evidence for shared capacity, independent of display filters. */
export function buildAllGrowthFlows(evidence:GrowthEvidence,now:Date):GrowthFlows {
  return buildGrowthFlows(evidence,{filters:{from:GROWTH_HISTORY_FLOOR,to:formatInTimeZone(now,'Asia/Bangkok','yyyy-MM-dd'),viewMonth:monthOf(now),role:'all',modality:'all'},assumptions:{bufferPercent:0}},now);
}
