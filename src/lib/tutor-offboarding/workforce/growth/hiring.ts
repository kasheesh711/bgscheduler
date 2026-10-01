import { intersectIntervals, intervalMinutes, unionIntervals } from '../intervals';
import { qualificationMatches } from '../capacity';
import { buildWorkforcePersonStates } from '../turnover';
import type { WorkforceMetric } from '../types';
import type { GrowthAllocationResult, GrowthCourse, GrowthEvidence, GrowthHiringEstimate } from './types';
const DAY = 86400000, MINUTE = 60000;
/** Prospective-hire benchmarks use offered recurrence, before personal leave or current bookings. */
export function buildGrowthHiringEstimates(evidence: GrowthEvidence, allocations: GrowthAllocationResult[], now: Date): GrowthHiringEstimate[] {
    const marked = new Set(evidence.workforce.terminationMarks.filter(m => m.status !== 'cancelled').map(m => m.canonicalKey));
    const people = buildWorkforcePersonStates(evidence.workforce, now).filter(p => p.role && p.rosterState === 'active' && !marked.has(p.canonicalKey) && !p.departedAt);
    const observations = Map.groupBy(evidence.workforce.observations.filter(o => Date.parse(o.observedAt) <= now.getTime()), o => o.canonicalKey);
    const current = people.flatMap(p => { const rows = (observations.get(p.canonicalKey) ?? []).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)); const qualification = rows.find(o => o.qualificationCompleteness !== 'unknown'), availability = rows[0]; return qualification ? [{ person: p, qualification, availability }] : []; });
    const results: GrowthHiringEstimate[] = [];
    for (const allocation of allocations) {
        const courses = new Map<string, GrowthCourse>();
        for (const cell of allocation.cells)
            courses.set(cell.courseKey, { courseKey: cell.courseKey, subject: cell.subject, curriculum: cell.curriculum, level: cell.level });
        for (const course of courses.values()) {
            const cells = allocation.cells.filter(c => c.courseKey === course.courseKey), eligible = current.filter(row => row.qualification.qualifications.some(q => qualificationMatches(q, { subject: course.subject, curriculum: course.curriculum ?? undefined, level: course.level ?? undefined, modality: 'all' })));
            const known = eligible.filter(row => row.availability?.availabilityCompleteness === 'complete');
            const reasons = new Set<string>(['HIRING_ESTIMATES_NONADDITIVE', 'PROSPECTIVE_HIRE_OFFERED_HOURS']);
            if (course.curriculum === null || course.level === null)
                reasons.add('COURSE_DIMENSIONS_PARTIAL');
            if (eligible.length !== known.length)
                reasons.add('BENCHMARK_AVAILABILITY_INCOMPLETE');
            if (!known.length)
                reasons.add('HIRING_BENCHMARK_UNAVAILABLE');
            if (known.length < 3)
                reasons.add('SMALL_BENCHMARK_SAMPLE');
            if (eligible.some(row => row.qualification.qualificationCompleteness !== 'complete'))
                reasons.add('BENCHMARK_QUALIFICATIONS_PARTIAL');
            const shortages = unionIntervals(cells.filter(c => (c.additionalWeeklyHours.value ?? 0) > 0).map(c => ({ start: c.weekday * DAY + c.startMinute * MINUTE, end: c.weekday * DAY + c.endMinute * MINUTE })));
            let full = 0, matching = 0;
            for (const row of known) {
                const offered = unionIntervals(row.availability.offeredWindows.filter(w => Number.isFinite(w.weekday) && w.weekday >= 0 && w.weekday <= 6 && w.startMinute >= 0 && w.endMinute <= 1440 && w.endMinute > w.startMinute).map(w => ({ start: w.weekday * DAY + w.startMinute * MINUTE, end: w.weekday * DAY + w.endMinute * MINUTE })));
                full += intervalMinutes(offered) / 60;
                matching += intervalMinutes(intersectIntervals(offered, shortages)) / 60;
                const sourceAt = row.availability.sourceTimes?.availability ?? row.availability.observedAt;
                if (now.getTime() - Date.parse(sourceAt) > 90 * MINUTE)
                    reasons.add('BENCHMARK_AVAILABILITY_STALE');
            }
            const unknown = cells.some(c => c.additionalWeeklyHours.value === null), gap = unknown ? null : cells.reduce((sum, c) => sum + c.additionalWeeklyHours.value!, 0), buffered = unknown ? null : cells.reduce((sum, c) => sum + c.bufferedAdditionalWeeklyHours.value!, 0);
            const averageFull = known.length ? full / known.length : null, averageMatching = known.length ? matching / known.length : null;
            if (gap !== null && gap > 0 && averageMatching === 0)
                reasons.add('HIRING_DIFFERENT_HOURS_REQUIRED');
            const partial = course.curriculum === null || course.level === null || known.length < eligible.length || known.length < 3 || eligible.some(row => row.qualification.qualificationCompleteness !== 'complete') || reasons.has('BENCHMARK_AVAILABILITY_STALE') || cells.some(c => c.additionalWeeklyHours.completeness !== 'complete');
            const metric = (value: number | null): WorkforceMetric => ({ value, completeness: value === null ? 'unknown' : partial ? 'partial' : 'complete', reasonCodes: value === null ? [reasons.has('HIRING_DIFFERENT_HOURS_REQUIRED') ? 'HIRING_DIFFERENT_HOURS_REQUIRED' : 'HIRING_BENCHMARK_UNAVAILABLE'] : partial ? ['HIRING_BENCHMARK_PARTIAL'] : [] });
            const equivalents = (hours: number | null) => hours === 0 ? 0 : hours !== null && averageMatching !== null && averageMatching > 0 ? hours / averageMatching : null;
            const amount = equivalents(gap), bufferedAmount = equivalents(buffered);
            results.push({ ...course, month: allocation.month, eligibleTutors: eligible.length, knownAvailabilityTutors: known.length, averageOfferedWeeklyHours: metric(averageFull), averageMatchingWeeklyHours: metric(unknown ? null : averageMatching), extraWeeklyHours: metric(gap), tutorEquivalents: metric(amount), roundedHiringEstimate: metric(amount === null ? null : Math.ceil(amount - 1e-10)), bufferedTutorEquivalents: metric(bufferedAmount), bufferedRoundedHiringEstimate: metric(bufferedAmount === null ? null : Math.ceil(bufferedAmount - 1e-10)), benchmarkPersonKeys: known.map(row => row.person.canonicalKey).sort(), reasonCodes: [...reasons].sort() });
        }
    }
    return results.sort((a, b) => a.month.localeCompare(b.month) || a.courseKey.localeCompare(b.courseKey));
}
