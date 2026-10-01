import { isCancelledSession } from './credits';
import { bangkokDayStart, bangkokMonthBounds, unionIntervals, intersectIntervals, subtractIntervals, intervalMinutes, type Interval } from './intervals';
import { WORKFORCE_OBSERVATION_MAX_AGE_MINUTES } from './observations';
import type { WorkforceEvidence, WorkforceQuery, WorkforceQualification, WorkforceDatedObservation, WorkforceSession } from './types';
const DAY = 86400000, MINUTE = 60000;
export interface QualificationSpan {
    interval: Interval;
    qualification: WorkforceQualification;
    completeness: 'complete' | 'partial' | 'unknown';
}
export interface PersonCapacity {
    canonicalKey: string;
    coverage: Interval[];
    offered: Interval[];
    leave: Interval[];
    usable: Interval[];
    reserved: Interval[];
    free: Interval[];
    qualificationSpans: QualificationSpan[];
    observationIds: string[];
    reasonCodes: string[];
    projectionOffered: Interval[];
    projectionUsable: Interval[];
    projectionFree: Interval[];
    projectionQualificationSpans: QualificationSpan[];
    projectionSourceAt: string | null;
    projectionReasonCodes: string[];
}
export interface CapacityResult {
    bounds: Interval;
    observedBounds: Interval;
    people: PersonCapacity[];
}
export function qualificationMatches(q: WorkforceQualification, query: Pick<WorkforceQuery, 'subject' | 'curriculum' | 'level' | 'modality'>): boolean {
    return (!query.subject || q.subject === query.subject) && (!query.curriculum || q.curriculum === query.curriculum) && (!query.level || q.level === query.level) && (query.modality === 'all' || q.modality === null || q.modality === query.modality);
}
export function sessionInterval(session: WorkforceSession): Interval | null {
    const start = Date.parse(session.startAt), end = session.endAt ? Date.parse(session.endAt) : session.scheduledMinutes !== null ? start + session.scheduledMinutes * MINUTE : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}
export function queryBounds(query: WorkforceQuery): Interval { return { start: bangkokDayStart(query.from), end: bangkokDayStart(query.to) + DAY }; }
function instantiate(observation: WorkforceDatedObservation, bounds: Interval, query: WorkforceQuery): Interval[] {
    const result: Interval[] = [];
    for (let day = bangkokDayStart(new Date(bounds.start + 7 * 3600000).toISOString().slice(0, 10)); day < bounds.end; day += DAY) {
        const weekday = new Date(day + 7 * 3600000).getUTCDay();
        for (const w of observation.offeredWindows) {
            if (w.weekday !== weekday || (query.modality !== 'all' && w.modality !== query.modality))
                continue;
            if (!Number.isFinite(w.startMinute) || !Number.isFinite(w.endMinute) || w.startMinute < 0 || w.endMinute > 1440 || w.endMinute <= w.startMinute)
                continue;
            result.push({ start: Math.max(bounds.start, day + w.startMinute * MINUTE), end: Math.min(bounds.end, day + w.endMinute * MINUTE) });
        }
    }
    return unionIntervals(result.filter(i => i.end > i.start));
}
function leaves(observation: WorkforceDatedObservation, bounds: Interval): Interval[] {
    return intersectIntervals(observation.leaves.filter(l => l.status === 'approved').flatMap(l => { const start = Date.parse(l.startAt), end = Date.parse(l.endAt); return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end }] : []; }), [bounds]);
}
/** Canonical-person interval unions prevent online/onsite and subject double counting. */
export function buildCapacity(evidence: WorkforceEvidence, query: WorkforceQuery, now: Date, options: {
    projectionStart?: number;
} = {}): CapacityResult {
    if (options.projectionStart !== undefined && (!Number.isFinite(options.projectionStart) || options.projectionStart < bangkokMonthBounds(new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 7)).start))
        throw new RangeError('A modeled recurrence cannot project an earlier historical month');
    const bounds = queryBounds(query), observedBounds = { start: bounds.start, end: Math.max(bounds.start, Math.min(bounds.end, now.getTime())) };
    const byPerson = Map.groupBy(evidence.observations.filter(o => Number.isFinite(Date.parse(o.observedAt)) && Date.parse(o.observedAt) <= now.getTime()), o => o.canonicalKey);
    const blocks = new Map<string, Interval[]>();
    for (const session of evidence.sessions) {
        if (isCancelledSession(session) || session.reasonCodes.includes('absent_from_current_future_snapshot'))
            continue;
        const interval = sessionInterval(session);
        if (!interval)
            continue;
        for (const key of new Set(session.canonicalTutorKeys))
            blocks.set(key, [...(blocks.get(key) ?? []), interval]);
    }
    const people = evidence.people.filter(p => p.role !== null && (query.role === 'all' || p.role === query.role)).map(person => {
        const result: PersonCapacity = { canonicalKey: person.canonicalKey, coverage: [], offered: [], leave: [], usable: [], reserved: unionIntervals(blocks.get(person.canonicalKey) ?? []), free: [], qualificationSpans: [], observationIds: [], reasonCodes: [], projectionOffered: [], projectionUsable: [], projectionFree: [], projectionQualificationSpans: [], projectionSourceAt: null, projectionReasonCodes: [] };
        const observations = (byPerson.get(person.canonicalKey) ?? []).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
        for (let i = 0; i < observations.length; i++) {
            const o = observations[i], observed = Date.parse(o.observedAt), availabilityTime = Date.parse(o.sourceTimes?.availability ?? o.observedAt);
            const start = Math.max(observedBounds.start, observed), end = Math.min(observedBounds.end, observations[i + 1] ? Date.parse(observations[i + 1].observedAt) : Infinity, availabilityTime + WORKFORCE_OBSERVATION_MAX_AGE_MINUTES * MINUTE);
            if (!(end > start))
                continue;
            const span = { start, end };
            result.observationIds.push(o.id);
            result.reasonCodes.push(...o.reasonCodes);
            const matching = o.qualifications.filter(q => qualificationMatches(q, query));
            for (const qualification of matching)
                result.qualificationSpans.push({ interval: span, qualification, completeness: o.qualificationCompleteness });
            if (o.qualificationCompleteness !== 'complete')
                result.reasonCodes.push('QUALIFICATIONS_PARTIAL');
            if (o.availabilityCompleteness !== 'complete' || !Number.isFinite(availabilityTime)) {
                result.reasonCodes.push('AVAILABILITY_OBSERVATION_FAILED');
                continue;
            }
            result.coverage.push(span);
            const subjectFiltered = Boolean(query.subject || query.curriculum || query.level);
            if (subjectFiltered && !matching.length)
                continue;
            result.offered.push(...instantiate(o, span, query));
            result.leave.push(...leaves(o, span));
        }
        result.coverage = unionIntervals(result.coverage);
        result.offered = unionIntervals(result.offered);
        result.leave = intersectIntervals(result.offered, unionIntervals(result.leave));
        result.usable = subtractIntervals(result.offered, result.leave);
        result.free = subtractIntervals(result.usable, result.reserved);
        if (intervalMinutes(result.coverage) < intervalMinutes([observedBounds]))
            result.reasonCodes.push('AVAILABILITY_COVERAGE_PARTIAL');
        if (!result.coverage.length)
            result.reasonCodes.push('AVAILABILITY_HISTORY_MISSING');
        const last = [...observations].reverse().find(o => o.availabilityCompleteness === 'complete');
        if (last && bounds.end > now.getTime()) {
            const projectionBounds = { start: Math.max(bounds.start, options.projectionStart ?? now.getTime()), end: bounds.end };
            const qualificationObservation = [...observations].reverse().find(o => o.qualifications.length || o.qualificationCompleteness === 'complete') ?? last;
            const matching = qualificationObservation.qualifications.filter(q => qualificationMatches(q, query));
            if (!(query.subject || query.curriculum || query.level) || matching.length) {
                result.projectionOffered = instantiate(last, projectionBounds, query);
                result.projectionUsable = subtractIntervals(result.projectionOffered, leaves(last, projectionBounds));
                result.projectionFree = subtractIntervals(result.projectionUsable, result.reserved);
            }
            result.projectionQualificationSpans = matching.map(qualification => ({ interval: projectionBounds, qualification, completeness: qualificationObservation.qualificationCompleteness }));
            result.projectionSourceAt = last.sourceTimes?.availability ?? last.observedAt;
            result.projectionReasonCodes = ['PROJECTED_RECURRENCE', 'LEAVE_HORIZON_NOT_PROVEN', ...(options.projectionStart !== undefined && options.projectionStart < now.getTime() ? ['MODELED_CURRENT_MONTH_RECURRENCE'] : [])];
            if (qualificationObservation.qualificationCompleteness !== 'complete')
                result.projectionReasonCodes.push('QUALIFICATIONS_PARTIAL');
            if (now.getTime() - Date.parse(result.projectionSourceAt) > WORKFORCE_OBSERVATION_MAX_AGE_MINUTES * MINUTE)
                result.projectionReasonCodes.push('LAST_KNOWN_AVAILABILITY_STALE');
        }
        result.reasonCodes = [...new Set(result.reasonCodes)];
        return result;
    });
    return { bounds, observedBounds, people };
}
