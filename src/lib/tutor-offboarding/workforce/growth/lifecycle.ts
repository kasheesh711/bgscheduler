import { isCancelledSession, isNoShowSession, recordedTeachingMinutes } from '../credits';
import { workforceContentHash } from '../observations';
import { bangkokDayStart, clipIntervals, intervalMinutes } from '../intervals';
import { resolveAcademicSubject } from '../subject-mappings';
import type { WorkforceMetric, WorkforceSession } from '../types';
import { addMonths, churnBaselineMonths, GROWTH_CHURN_WAIT_MS, historyCoversMonth, monthOf } from './calendar';
import { normalizeGrowthBookingMetadata } from './source';
import type { GrowthBookingKind, GrowthCourse, GrowthEvidence, GrowthLifecycleEvent } from './types';

export const GROWTH_LIFECYCLE_ALGORITHM = 'subject-lifecycle-v1';
export const growthKnown = (value: number, reasonCodes: string[] = []): WorkforceMetric => ({ value, completeness: 'complete', reasonCodes });
export const growthUnknown = (...reasonCodes: string[]): WorkforceMetric => ({ value: null, completeness: 'unknown', reasonCodes: [...new Set(reasonCodes)].sort() });
export function growthCourse(subject: string, curriculum: string | null, level: string | null): GrowthCourse {
  return { courseKey: JSON.stringify([subject, curriculum, level]), subject, curriculum, level };
}
export interface GrowthResolvedBooking {
  session: WorkforceSession;
  course: GrowthCourse | null;
  kind: GrowthBookingKind;
  studentIds: string[];
  reasonCodes: string[];
}
/** Latest retained revision wins before cohort dates are calculated. Academic labels are re-resolved. */
export function resolveGrowthBookings(evidence: GrowthEvidence): GrowthResolvedBooking[] {
  const latest = new Map<string, WorkforceSession>();
  for (const session of evidence.workforce.sessions) {
    const old = latest.get(session.wiseSessionId);
    if (!old || Date.parse(session.observedAt ?? '1970-01-01') >= Date.parse(old.observedAt ?? '1970-01-01')) latest.set(session.wiseSessionId, session);
  }
  const metadata = new Map(evidence.bookingMetadata.map(row => [row.wiseSessionId, row]));
  return [...latest.values()].filter(session => Number.isFinite(Date.parse(session.startAt))).map(session => {
    const mapping = resolveAcademicSubject({ classId: session.wiseClassId, sourceValue: session.classTitle }, evidence.workforce.subjectMappings);
    const stored = metadata.get(session.wiseSessionId);
    const classification = stored && stored.classification !== 'unknown' && !stored.reasonCodes.includes('OWNER_CONFIRMED_TITLE_CLASSIFICATION')
      ? stored : normalizeGrowthBookingMetadata(session, session.observedAt ?? stored?.observedAt ?? '1970-01-01T00:00:00Z', mapping.completeness === 'complete');
    return { session, course: mapping.subject ? growthCourse(mapping.subject, mapping.curriculum, mapping.level) : null,
      kind: classification.classification, studentIds: [...new Set(session.historicalBookedStudentIds ?? [])],
      reasonCodes: [...new Set([...mapping.reasonCodes, ...classification.reasonCodes])] };
  }).sort((a,b) => Date.parse(a.session.startAt) - Date.parse(b.session.startAt) || a.session.wiseSessionId.localeCompare(b.session.wiseSessionId));
}
/** Teaching is established independently for each known historical participant. */
export function studentWasTaught(booking: GrowthResolvedBooking, studentId: string, evidence: GrowthEvidence): boolean {
  const { session } = booking;
  const credits = evidence.workforce.studentCredits.filter(row => row.wiseSessionId === session.wiseSessionId && row.wiseStudentId === studentId);
  // Per-student exclusions can be retained without discarding other members of a group.
  if (credits.some(row => row.issueCodes.some(code => ['STUDENT_CANCELLED','STUDENT_CANCELED','STUDENT_NO_SHOW','STUDENT_ABSENT'].includes(code.toUpperCase())))) return false;
  return (recordedTeachingMinutes(session, credits).value ?? 0) > 0;
}
export function studentNetHours(booking: GrowthResolvedBooking, studentId: string, evidence: GrowthEvidence): WorkforceMetric {
  const normal = (booking.session.scheduledMinutes ?? 0) / 60;
  if (!Number.isFinite(normal) || normal <= 0) return growthUnknown('SCHEDULED_DURATION_UNKNOWN');
  const rows = evidence.workforce.studentCredits.filter(row => row.wiseSessionId === booking.session.wiseSessionId && row.wiseStudentId === studentId);
  const distinct = new Map(rows.map(row => [JSON.stringify([row.netCredits,row.evidenceStatus,row.sourceInterpretation]),row]));
  if (distinct.size !== 1) return growthUnknown(distinct.size ? 'CONFLICTING_CREDIT_EVIDENCE' : 'CREDIT_EVIDENCE_MISSING');
  const row = [...distinct.values()][0];
  if (row.evidenceStatus !== 'verified' || row.netCredits === null || !Number.isFinite(row.netCredits)) return growthUnknown('NET_CREDIT_UNVERIFIED');
  if (row.netCredits < 0 || row.netCredits > normal) return growthUnknown('NET_CREDIT_OUTSIDE_SCHEDULED_CHARGE');
  return growthKnown(row.netCredits, ['OWNER_CONFIRMED_ONE_CREDIT_PER_HOUR']);
}
export function isActiveGrowthBooking(booking: GrowthResolvedBooking): boolean {
  return !isCancelledSession(booking.session) && !isNoShowSession(booking.session) && !booking.session.reasonCodes.includes('absent_from_current_future_snapshot');
}
export function hasFreshGrowthFutureEvidence(evidence: GrowthEvidence, now: Date): boolean {
  const snapshots = evidence.workforce.sourceCoverage.filter(row => row.source === 'wise_future_snapshot');
  const latest = snapshots.sort((a,b) => Date.parse(b.observedAt ?? '') - Date.parse(a.observedAt ?? ''))[0];
  const age = now.getTime() - Date.parse(latest?.observedAt ?? '');
  return Boolean(latest?.completeness === 'complete' && !latest.truncated && age >= 0 && age <= 90 * 60000);
}
export function hasCompleteGrowthTeachingHistory(evidence: GrowthEvidence, start: number, end: number): boolean {
  const intervals = evidence.workforce.sourceCoverage.filter(row=>row.source==='wise_history' && row.completeness==='complete' && !row.truncated).flatMap(row=>{
    try { return [{start:bangkokDayStart(row.requestedFrom),end:bangkokDayStart(row.requestedTo)+86400000}]; }
    catch { return []; }
  });
  return intervalMinutes(clipIntervals(intervals,{start,end}))*60000 >= end-start;
}
function baseline(bookings: GrowthResolvedBooking[], studentId: string, months: string[], evidence: GrowthEvidence) {
  const courses = new Map<string, { course: GrowthCourse; hours: number; issues: Set<string> }>();
  let hours = 0;
  const sourceIds: string[] = [];
  const issues = new Set<string>();
  for (const month of months) if (!historyCoversMonth(evidence.workforce.sourceCoverage, month)) issues.add(`BASELINE_HISTORY_MISSING:${month}`);
  for (const booking of bookings.filter(row => row.studentIds.includes(studentId) && months.includes(monthOf(row.session.startAt)))) {
    if (booking.kind === 'trial' || booking.kind === 'pretest') continue;
    if (booking.kind !== 'regular' || !booking.course) { issues.add('BASELINE_CLASSIFICATION_UNRESOLVED'); continue; }
    const course = courses.get(booking.course.courseKey) ?? { course: booking.course, hours: 0, issues: new Set<string>() };
    const value = booking.session.scheduledMinutes;
    if (value === null || !Number.isFinite(value) || value <= 0) { issues.add('BASELINE_DURATION_UNKNOWN'); course.issues.add('BASELINE_DURATION_UNKNOWN'); }
    else { hours += value / 60; course.hours += value / 60; }
    sourceIds.push(booking.session.wiseSessionId);
    courses.set(booking.course.courseKey, course);
  }
  return { metric: issues.size ? growthUnknown(...issues) : growthKnown(hours / 3), sourceIds,
    byCourse: [...courses.values()].map(row => ({ course: row.course, studentHours: issues.size || row.issues.size ? growthUnknown(...issues,...row.issues) : growthKnown(row.hours / 3) })) };
}
const identity = (student: string, subject: string) => JSON.stringify([student,subject]);
function eventKey(studentId: string, subject: string, kind: string, anchor: string): string {
  return `${GROWTH_LIFECYCLE_ALGORITHM}:${kind}:${workforceContentHash([studentId,subject,anchor])}`;
}

/** Pure reconstruction plus explicit correction revisions; ingestion decides when to persist. */
export function deriveGrowthLifecycleEvents(evidence: GrowthEvidence, now: Date): GrowthLifecycleEvent[] {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid lifecycle time');
  const bookings = resolveGrowthBookings(evidence);
  const groups = new Map<string, GrowthResolvedBooking[]>();
  for (const booking of bookings) if (booking.course && booking.kind === 'regular') for (const id of booking.studentIds) {
    const key = identity(id,booking.course.subject); groups.set(key,[...(groups.get(key) ?? []),booking]);
  }
  const retained = new Map(evidence.lifecycleEvents.map(event => [event.eventKey,event]));
  const events = new Map<string,GrowthLifecycleEvent>();
  // Retained events survive returns. Only direct source corrections supersede them.
  for (const event of retained.values()) {
    if (event.status === 'superseded') { events.set(event.eventKey,event); continue; }
    const rows = groups.get(identity(event.studentId,event.subject)) ?? [];
    const anchor = rows.find(row => row.session.startAt === event.lastTaughtAt && studentWasTaught(row,event.studentId,evidence));
    const threshold = Date.parse(event.lastTaughtAt ?? '') + GROWTH_CHURN_WAIT_MS;
    const interruption = rows.some(row => Date.parse(row.session.startAt) > Date.parse(event.lastTaughtAt ?? '') && Date.parse(row.session.startAt) < threshold && studentWasTaught(row,event.studentId,evidence));
    const invalidReturn = event.kind === 'reactivation' && !rows.some(row => row.session.startAt === event.returnAt && isActiveGrowthBooking(row));
    // Missing records in a partial replay cannot invalidate retained evidence. A
    // changed final-class record can: its ID was outside the baseline months.
    const finalSourcePresent = bookings.some(row => event.sourceSessionIds.includes(row.session.wiseSessionId) && !event.baselineMonths.includes(monthOf(row.session.startAt)) && row.session.startAt !== event.returnAt);
    const returnSourcePresent = event.kind === 'reactivation' && bookings.some(row => event.sourceSessionIds.includes(row.session.wiseSessionId) && row.session.startAt === event.returnAt);
    if ((finalSourcePresent && (!anchor || interruption)) || (returnSourcePresent && invalidReturn)) events.set(event.eventKey,{...event,revision:event.revision+1,status:'superseded',evidenceRevision:evidence.revision,reasonCodes:[...new Set([...event.reasonCodes,'SOURCE_CORRECTION_SUPERSEDED'])]});
    else events.set(event.eventKey,event);
  }
  for (const [key, rows] of groups) {
    const [studentId,subject] = JSON.parse(key) as [string,string];
    const taught = rows.filter(row => Date.parse(row.session.startAt) <= now.getTime() && studentWasTaught(row,studentId,evidence));
    for (let i = 0; i < taught.length; i++) {
      const last = taught[i], threshold = Date.parse(last.session.startAt) + GROWTH_CHURN_WAIT_MS;
      if (threshold > now.getTime()) continue;
      const next = taught[i+1];
      if (next && Date.parse(next.session.startAt) < threshold) continue;
      const later = rows.find(row => Date.parse(row.session.startAt) >= threshold && isActiveGrowthBooking(row));
      const historical = Boolean(later && Date.parse(later.session.startAt) <= now.getTime());
      const future = bookings.some(row => row.course?.subject === subject && row.studentIds.includes(studentId) && Date.parse(row.session.endAt ?? row.session.startAt) > now.getTime() && isActiveGrowthBooking(row));
      const futureUnknown = bookings.some(row => Date.parse(row.session.endAt ?? row.session.startAt) > now.getTime() && isActiveGrowthBooking(row)
        && (row.session.participantCompleteness !== 'complete' || (row.studentIds.includes(studentId) && (!row.course || row.kind === 'unknown'))));
      const churnKey = eventKey(studentId,subject,'churn',last.session.wiseSessionId);
      const old = events.get(churnKey);
      const historyComplete = hasCompleteGrowthTeachingHistory(evidence,Date.parse(last.session.startAt),historical ? threshold : now.getTime());
      if ((!old || old.status==='superseded') && !historyComplete) continue;
      if (!old && !historical && (future || futureUnknown || !hasFreshGrowthFutureEvidence(evidence,now))) continue;
      // Reinstating a corrected source creates another explicit revision.
      if (old?.status === 'superseded' && !historical && (future || futureUnknown || !hasFreshGrowthFutureEvidence(evidence,now))) continue;
      const months = churnBaselineMonths(last.session.startAt);
      const summary = baseline(rows,studentId,months,evidence);
      const certainty = old?.certainty ?? (historical ? 'inferred' : 'observed');
      const churn: GrowthLifecycleEvent = { eventKey:churnKey,revision:old?.status === 'superseded' ? old.revision+1 : old?.revision ?? 1,studentId,subject,kind:'churn',lastTaughtAt:last.session.startAt,returnAt:null,
        effectiveMonth:addMonths(monthOf(last.session.startAt),1),confirmedAt:old?.confirmedAt ?? new Date(threshold).toISOString(),baselineMonths:months,
        baselineStudentHours:summary.metric,baselineByCourse:summary.byCourse,evidenceRevision:evidence.revision,
        sourceSessionIds:[...new Set([last.session.wiseSessionId,...summary.sourceIds])].sort(),status:'active',certainty,
        reasonCodes:[GROWTH_LIFECYCLE_ALGORITHM,...(certainty==='inferred' ? ['HISTORICAL_FUTURE_BOOKINGS_NOT_RETAINED'] : ['FRESH_FUTURE_NO_BOOKING_CHECK']),...(summary.metric.reasonCodes)] };
      events.set(churnKey,churn);
      if (later && Date.parse(later.session.startAt) <= now.getTime()) {
        const returnKey = eventKey(studentId,subject,'reactivation',churnKey);
        const prior = events.get(returnKey);
        events.set(returnKey,{...churn,eventKey:returnKey,revision:prior?.status === 'superseded' ? prior.revision+1 : prior?.revision ?? 1,kind:'reactivation',returnAt:later.session.startAt,effectiveMonth:monthOf(later.session.startAt),
          confirmedAt:prior?.confirmedAt ?? later.session.startAt,sourceSessionIds:[...new Set([...churn.sourceSessionIds,later.session.wiseSessionId])].sort(),reasonCodes:[GROWTH_LIFECYCLE_ALGORITHM,'RETURN_AFTER_CONFIRMED_CHURN']});
      }
    }
  }
  // A corrected departure invalidates its dependent return, never silently
  // removing either audit record.
  for (const event of events.values()) if (event.kind === 'reactivation' && event.status === 'active') {
    const churn = [...events.values()].find(other => other.kind === 'churn' && other.studentId === event.studentId && other.subject === event.subject && other.lastTaughtAt === event.lastTaughtAt);
    if (churn?.status === 'superseded') events.set(event.eventKey,{...event,status:'superseded',revision:event.revision+1,evidenceRevision:evidence.revision,reasonCodes:[...new Set([...event.reasonCodes,'SOURCE_CORRECTION_SUPERSEDED'])]});
  }
  return [...events.values()].sort((a,b) => a.confirmedAt.localeCompare(b.confirmedAt) || a.kind.localeCompare(b.kind) || a.eventKey.localeCompare(b.eventKey));
}
