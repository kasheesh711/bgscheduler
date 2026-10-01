import type { Database } from '@/lib/db';
import { TutorOffboardingError } from '../errors';
import { buildPreparedWorkforceReport, capacityMask, classMatches, prepareWorkforce, weekMask } from './aggregate';
import { queryBounds } from './capacity';
import { bangkokMonthBounds, intersectIntervals, intervalMinutes, type Interval } from './intervals';
import { loadWorkforceEvidence } from './source-db';
import type { WorkforceDrilldown, WorkforceDrilldownQuery, WorkforceQuery, WorkforceReport } from './types';
function calculationTime(revision: string | undefined, now: Date): Date {
    if (!revision) return now;
    const match = /^v2:(\d{13}):[a-f0-9]{64}$/.exec(revision);
    const instant = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(instant) || instant > now.getTime())
        throw new TutorOffboardingError('Refresh the workforce report before opening details or exporting.', 409);
    return new Date(instant);
}
/** Database-only read. The loader supplies one repeatable-read evidence revision. */
export async function getWorkforceReport(db: Database, query: WorkforceQuery, now: Date, revision?: string): Promise<WorkforceReport> {
    const asOf = calculationTime(revision, now);
    return buildPreparedWorkforceReport(prepareWorkforce(await loadWorkforceEvidence(db, query, now), query, asOf));
}
export async function getWorkforceDrilldown(db: Database, query: WorkforceDrilldownQuery, now: Date): Promise<WorkforceDrilldown> {
    const { kind, key, reportRevision, cursor, pageSize, ...filters } = query;
    const asOf = calculationTime(reportRevision, now);
    const prepared = prepareWorkforce(await loadWorkforceEvidence(db, filters, now), filters, asOf);
    const report = buildPreparedWorkforceReport(prepared);
    if (report.reportRevision !== reportRevision)
        throw new TutorOffboardingError('The workforce evidence changed. Refresh the report before opening details.', 409);
    let mask: Interval[] = [queryBounds(filters)];
    let selected = filters;
    let keys = report.people.map(p => p.canonicalKey);
    if (kind === 'person') {
        if (!keys.includes(key))
            throw new TutorOffboardingError('This person is not in the selected report.', 404);
        keys = [key];
    }
    else if (kind === 'turnover') {
        const month = report.months.find(m => m.month === key);
        if (!month)
            throw new TutorOffboardingError('This month is not in the selected report.', 404);
        mask = intersectIntervals(mask, [bangkokMonthBounds(month.month)]);
        keys = [...new Set([...month.joinedPersonKeys, ...month.departedPersonKeys, ...month.pendingPersonKeys])];
    }
    else {
        const subject = report.subjects.find(s => s.key === key);
        const week = report.weekCells.find(s => s.key === key);
        if (subject) {
            selected = { ...filters, subject: subject.subject, curriculum: subject.curriculum ?? filters.curriculum, level: subject.level ?? filters.level };
            mask = intersectIntervals(mask, [bangkokMonthBounds(subject.month)]);
            keys = [...new Set([...prepared.capacity.filter(p => intervalMinutes(intersectIntervals(capacityMask(p, selected), mask)) > 0).map(p => p.canonicalKey), ...prepared.classes.filter(r => r.interval && intervalMinutes(intersectIntervals([r.interval], mask)) > 0 && (subject.subject === 'Unmapped' ? !r.session.subject : classMatches(r.session, selected))).flatMap(r => r.session.canonicalTutorKeys)])];
        }
        else if (week) {
            mask = weekMask(filters, week.weekday, week.startMinute);
        }
        else
            throw new TutorOffboardingError('This cell is not in the selected report.', 404);
    }
    const keySet = new Set(keys);
    const sessions = prepared.classes.filter(r => r.interval && intervalMinutes(intersectIntervals([r.interval], mask)) > 0 &&
        (r.session.canonicalTutorKeys.some(k => keySet.has(k)) || kind === 'subject_cell' && filters.role === 'all' && !r.session.canonicalTutorKeys.length && classMatches(r.session, selected))).map(r => classMatches(r.session, selected) ? r.session : { ...r.session, reasonCodes: [...r.session.reasonCodes, 'OTHER_SUBJECT_COMMITMENT'] });
    const observations = prepared.evidence.observations.filter(o => keySet.has(o.canonicalKey));
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0)
        throw new TutorOffboardingError('Use a valid detail cursor.', 400);
    const limit = Math.min(500, Math.max(1, pageSize ?? 100));
    // A shared offset bounds both source lists. Contributors describe this page, not hidden records.
    const sessionPage = sessions.slice(offset, offset + limit), observationPage = observations.slice(offset, offset + limit);
    return { query: filters, reportRevision: report.reportRevision, kind, key,
        contributors: { canonicalKeys: keys, wiseSessionIds: sessionPage.map(s => s.wiseSessionId), wiseClassIds: [...new Set(sessionPage.flatMap(s => s.wiseClassId ? [s.wiseClassId] : []))],
            wiseStudentIds: [...new Set(sessionPage.flatMap(s => s.historicalBookedStudentIds ?? []))], terminationSourceIds: prepared.evidence.terminationMarks.filter(m => keySet.has(m.canonicalKey)).map(m => m.sourceId), observationIds: observationPage.map(o => o.id) },
        people: report.people.filter(p => keySet.has(p.canonicalKey)), sessions: sessionPage, observations: observationPage,
        exceptions: report.quality.exceptions.filter(e => sessionPage.some(s => s.wiseSessionId === e.entityId)),
        nextCursor: offset + limit < Math.max(sessions.length, observations.length) ? String(offset + limit) : null };
}
