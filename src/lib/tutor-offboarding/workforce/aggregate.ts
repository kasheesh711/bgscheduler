import { createHash } from 'node:crypto';
import { buildCapacity, qualificationMatches, queryBounds, sessionInterval, type PersonCapacity } from './capacity';
import { computeConsumedMinutes, isCancelledSession, isNoShowSession, recordedTeachingMinutes } from './credits';
import { bangkokDayStart, bangkokMonthBounds, intersectIntervals, intervalMinutes, subtractIntervals, unionIntervals, type Interval } from './intervals';
import { resolveAcademicSubject } from './subject-mappings';
import { buildTurnoverMonths, buildWorkforcePersonStates } from './turnover';
import type { WorkforceEvidence, WorkforceMetric, WorkforceQuery, WorkforceReport, WorkforceSession, WorkforceSubjectRow, WorkforceUtilizationMetrics, WorkforceWeekCell } from './types';
const DAY = 86400000, MINUTE = 60000;
const unique = <T>(values: T[]) => [...new Set(values)];
const metric = (value: number | null, reasons: string[] = [], partial = false): WorkforceMetric => ({
    value, completeness: value === null ? 'unknown' : partial ? 'partial' : 'complete', reasonCodes: unique(reasons),
});
export interface PreparedClass {
    session: WorkforceSession;
    interval: Interval | null;
    consumed: WorkforceMetric;
    taught: WorkforceMetric;
}
export interface PreparedWorkforce {
    evidence: WorkforceEvidence;
    classes: PreparedClass[];
    unknownDurationClasses: PreparedClass[];
    capacity: PersonCapacity[];
    query: WorkforceQuery;
    now: Date;
}
/** Collapse student-grained copies before counting tutor-hours. Conflicting facts stay unknown. */
export function prepareWorkforce(evidence: WorkforceEvidence, query: WorkforceQuery, now: Date): PreparedWorkforce {
    const people = buildWorkforcePersonStates(evidence, now);
    const participants = new Map(evidence.historicalBookedParticipants.map(p => [p.wiseSessionId, p]));
    const sessions = new Map<string, WorkforceSession>();
    for (const input of evidence.sessions) {
        const previous = sessions.get(input.wiseSessionId);
        const session = { ...input, canonicalTutorKeys: unique(input.canonicalTutorKeys), reasonCodes: [...input.reasonCodes] };
        const participant = participants.get(input.wiseSessionId);
        if (participant && session.historicalBookedStudentIds === null) {
            session.historicalBookedStudentIds = participant.studentIds;
            session.participantCompleteness = participant.completeness;
        }
        if (previous) {
            session.canonicalTutorKeys = unique([...previous.canonicalTutorKeys, ...session.canonicalTutorKeys]);
            session.reasonCodes = unique([...previous.reasonCodes, ...session.reasonCodes]);
            session.wiseClassId ??= previous.wiseClassId;
            session.classTitle ??= previous.classTitle;
            if (JSON.stringify([previous.startAt, previous.endAt, previous.scheduledMinutes]) !== JSON.stringify([session.startAt, session.endAt, session.scheduledMinutes])) {
                session.scheduledMinutes = null;
                session.reasonCodes.push('CONFLICTING_SESSION_DURATION');
            }
            if (previous.participantCompleteness !== session.participantCompleteness ||
                JSON.stringify(unique(previous.historicalBookedStudentIds ?? []).sort()) !== JSON.stringify(unique(session.historicalBookedStudentIds ?? []).sort())) {
                session.participantCompleteness = 'partial';
                session.historicalBookedStudentIds = unique([...(previous.historicalBookedStudentIds ?? []), ...(session.historicalBookedStudentIds ?? [])]);
                session.reasonCodes.push('CONFLICTING_PARTICIPANTS');
            }
        }
        if (session.canonicalTutorKeys.length > 1)
            session.reasonCodes.push('CONFLICTING_TUTOR_ASSIGNMENT');
        if (!session.subject) {
            const mapped = resolveAcademicSubject({ classId: session.wiseClassId, sourceValue: session.classTitle }, evidence.subjectMappings);
            session.subject = mapped.subject;
            session.curriculum = mapped.curriculum;
            session.level = mapped.level;
            session.reasonCodes.push(...mapped.reasonCodes);
        }
        sessions.set(session.wiseSessionId, session);
    }
    const normalized = { ...evidence, people, sessions: [...sessions.values()] };
    const credits = Map.groupBy(evidence.studentCredits, c => c.wiseSessionId);
    const classes = normalized.sessions.map(session => ({ session, interval: sessionInterval(session),
        consumed: computeConsumedMinutes(session, credits.get(session.wiseSessionId) ?? []),
        taught: recordedTeachingMinutes(session, credits.get(session.wiseSessionId) ?? []) }));
    return { evidence: normalized, classes, unknownDurationClasses: classes.filter(r => !r.interval), capacity: buildCapacity(normalized, { ...query, subject: undefined, curriculum: undefined, level: undefined }, now).people, query, now };
}
export function classMatches(session: WorkforceSession, query: WorkforceQuery): boolean {
    return (!query.subject || session.subject === query.subject) && (!query.curriculum || session.curriculum === query.curriculum) &&
        (!query.level || session.level === query.level) && (query.modality === 'all' || session.modality === query.modality);
}
export function capacityMask(person: PersonCapacity, query: WorkforceQuery): Interval[] {
    if (!query.subject && !query.curriculum && !query.level)
        return person.coverage;
    return intersectIntervals(person.coverage, person.qualificationSpans.filter(s => qualificationMatches(s.qualification, query)).map(s => s.interval));
}
function pool(prepared: PreparedWorkforce, query: WorkforceQuery): PersonCapacity[] {
    return prepared.capacity.filter(p => !query.subject && !query.curriculum && !query.level || p.qualificationSpans.some(s => qualificationMatches(s.qualification, query)));
}
function sourceComplete(prepared: PreparedWorkforce, mask: Interval[]): boolean {
    const history = prepared.evidence.sourceCoverage.filter(c => c.source === 'wise_history' && c.completeness === 'complete' && !c.truncated)
        .map(c => ({ start: bangkokDayStart(c.requestedFrom), end: bangkokDayStart(c.requestedTo) + DAY }));
    const future = prepared.evidence.sourceCoverage.find(c => c.source === 'wise_future_snapshot' && c.completeness === 'complete' && !c.truncated && c.observedAt && Date.parse(c.observedAt) <= prepared.now.getTime() && prepared.now.getTime() - Date.parse(c.observedAt) <= 90 * MINUTE);
    if (future && mask.length)
        history.push({ start: prepared.now.getTime(), end: Math.max(prepared.now.getTime(), ...mask.map(i => i.end)) });
    return subtractIntervals(mask, history).length === 0;
}
function sumEvidence(rows: PreparedClass[], field: 'consumed' | 'taught', mask: Interval[], complete: boolean, exactOverlap: boolean): WorkforceMetric {
    let total = 0, known = 0, missing = false;
    const reasons: string[] = [];
    for (const row of rows) {
        const fraction = exactOverlap && row.interval ? intervalMinutes(intersectIntervals([row.interval], mask)) / intervalMinutes([row.interval]) : 1;
        if (fraction <= 0)
            continue;
        reasons.push(...row[field].reasonCodes);
        if (row[field].value === null)
            missing = true;
        else {
            total += row[field].value! / 60 * fraction;
            known++;
        }
    }
    if (!complete)
        reasons.push('SESSION_HISTORY_INCOMPLETE');
    return metric(missing && !known || !rows.length && !complete ? null : total, reasons, missing || !complete);
}
/** Demand uses the verified full period; ratios use precisely the observed capacity mask. */
export function measureWorkforce(prepared: PreparedWorkforce, query: WorkforceQuery, mask: Interval[], candidateRows = prepared.classes, candidatePeople = pool(prepared, query), exactOverlap = false): WorkforceUtilizationMetrics {
    const activeKeys = new Set(prepared.evidence.people.filter(p => p.role && (query.role === 'all' || p.role === query.role)).map(p => p.canonicalKey));
    const knownTeachingKeys = new Set(prepared.evidence.people.filter(p => p.role).map(p => p.canonicalKey));
    const unresolved = (r: PreparedClass) => r.session.canonicalTutorKeys.length !== 1 || !knownTeachingKeys.has(r.session.canonicalTutorKeys[0]);
    const inScope = (r: PreparedClass) => classMatches(r.session, query) && (exactOverlap
        ? Boolean(r.interval && intervalMinutes(intersectIntervals([r.interval], mask)) > 0)
        : mask.some(i => Date.parse(r.session.startAt) >= i.start && Date.parse(r.session.startAt) < i.end));
    const rateRows = candidateRows.filter(r => r.interval && intervalMinutes(intersectIntervals([r.interval], mask)) > 0 && classMatches(r.session, query) && r.session.canonicalTutorKeys.some(k => activeKeys.has(k)));
    const rows = candidateRows.filter(r => inScope(r) && (r.session.canonicalTutorKeys.some(k => activeKeys.has(k)) || query.role === 'all' && unresolved(r)));
    const complete = sourceComplete(prepared, mask);
    const demandReasons = complete ? [] : ['SESSION_HISTORY_INCOMPLETE'];
    const ids = new Set<string>();
    let bookings = 0, booked = 0, cancelled = 0, noShows = 0;
    let membershipUnknown = false, durationUnknown = false;
    let identityUnknown = candidateRows.some(r => inScope(r) && unresolved(r));
    if (identityUnknown) demandReasons.push('TUTOR_ASSIGNMENT_UNRESOLVED');
    for (const row of rows) {
        const students = unique(row.session.historicalBookedStudentIds ?? []);
        for (const id of students)
            ids.add(id);
        bookings += students.length;
        if (isCancelledSession(row.session))
            cancelled += students.length;
        if (isNoShowSession(row.session))
            noShows += students.length;
        membershipUnknown ||= row.session.participantCompleteness !== 'complete';
        durationUnknown ||= row.session.scheduledMinutes === null;
        identityUnknown ||= row.session.canonicalTutorKeys.length !== 1;
        booked += row.session.scheduledMinutes === null || !row.interval ? 0 : row.session.scheduledMinutes / 60 * (exactOverlap ? intervalMinutes(intersectIntervals([row.interval!], mask)) / intervalMinutes([row.interval!]) : 1);
    }
    const demandPartial = !complete || identityUnknown;
    const participantReasons = [...demandReasons, ...(membershipUnknown ? ['HISTORICAL_PARTICIPANTS_INCOMPLETE'] : [])];
    const capacityPeople = candidatePeople.filter(p => activeKeys.has(p.canonicalKey));
    let coverage = 0, expected = 0, offered = 0, leave = 0, usable = 0, free = 0, outside = 0, overlap = 0;
    let maskedReserved = 0, maskedConsumed = 0, maskedTaught = 0, reserved = 0;
    let missingConsumed = false, missingTaught = false, qualificationPartial = false;
    const capacityReasons: string[] = [];
    const reportBounds = queryBounds(query);
    const observedMask = intersectIntervals(mask, [{ start: reportBounds.start, end: Math.max(reportBounds.start, Math.min(reportBounds.end, prepared.now.getTime())) }]);
    for (const p of capacityPeople) {
        const support = intersectIntervals(capacityMask(p, query), observedMask);
        const offeredIntervals = intersectIntervals(p.offered, support), usableIntervals = intersectIntervals(p.usable, support);
        coverage += intervalMinutes(support);
        expected += intervalMinutes(observedMask);
        offered += intervalMinutes(offeredIntervals);
        leave += intervalMinutes(intersectIntervals(p.leave, support));
        usable += intervalMinutes(usableIntervals);
        free += intervalMinutes(intersectIntervals(p.free, support));
        capacityReasons.push(...p.reasonCodes);
        qualificationPartial ||= p.qualificationSpans.some(s => qualificationMatches(s.qualification, query) && s.completeness !== 'complete');
        const personRows = rateRows.filter(r => r.session.canonicalTutorKeys.length === 1 && r.session.canonicalTutorKeys[0] === p.canonicalKey);
        const bookingIntervals: Interval[] = [];
        for (const row of personRows) {
            const duration = intervalMinutes([row.interval!]);
            const covered = intervalMinutes(intersectIntervals([row.interval!], support));
            if (!isCancelledSession(row.session)) {
                maskedReserved += covered;
                bookingIntervals.push(...intersectIntervals([row.interval!], support));
                outside += intervalMinutes(subtractIntervals(intersectIntervals([row.interval!], support), offeredIntervals));
            }
            if (covered > 0) {
                if (row.consumed.value === null)
                    missingConsumed = true;
                else
                    maskedConsumed += row.consumed.value / duration * covered;
                if (row.taught.value === null)
                    missingTaught = true;
                else
                    maskedTaught += row.taught.value / duration * covered;
            }
        }
        overlap += Math.max(0, bookingIntervals.reduce((sum, i) => sum + (i.end - i.start) / MINUTE, 0) - intervalMinutes(unionIntervals(bookingIntervals)));
    }
    for (const row of rows)
        if (!isCancelledSession(row.session) && !row.session.reasonCodes.includes('absent_from_current_future_snapshot') && row.session.canonicalTutorKeys.length === 1)
            reserved += exactOverlap && row.interval ? intervalMinutes(intersectIntervals([row.interval], mask)) : row.session.scheduledMinutes ?? 0;
    const busyDurationUnknown = prepared.unknownDurationClasses.some(r => !r.interval && !isCancelledSession(r.session) && mask.some(i => Date.parse(r.session.startAt) >= i.start && Date.parse(r.session.startAt) < i.end) && r.session.canonicalTutorKeys.some(k => capacityPeople.some(p => p.canonicalKey === k)));
    if (busyDurationUnknown) {
        capacityReasons.push('BLOCKING_DURATION_UNKNOWN');
        missingConsumed = true;
        missingTaught = true;
    }
    if (identityUnknown)
        capacityReasons.push('CONFLICTING_TUTOR_ASSIGNMENT');
    if (outside > 0)
        capacityReasons.push('OUTSIDE_OFFERED_HOURS');
    if (overlap > 0)
        capacityReasons.push('OVERLAPPING_BOOKINGS');
    const hasCoverage = coverage > 0;
    const partialCapacity = coverage < expected || qualificationPartial || identityUnknown;
    const qualified = capacityPeople.filter(p => p.qualificationSpans.some(s => qualificationMatches(s.qualification, query) && intervalMinutes(intersectIntervals([s.interval], mask)) > 0)).length;
    const qualificationsKnown = capacityPeople.some(p => p.qualificationSpans.length > 0);
    if (coverage < expected)
        capacityReasons.push('AVAILABILITY_COVERAGE_PARTIAL');
    if (!hasCoverage)
        capacityReasons.push('AVAILABILITY_HISTORY_MISSING');
    const absentDemand = !rows.length && !complete;
    const cap = (minutes: number) => metric(hasCoverage ? minutes / 60 : null, capacityReasons, partialCapacity);
    const numerator = (minutes: number, missing: boolean) => metric(hasCoverage ? minutes / 60 : null, [...capacityReasons, ...(missing ? ['UTILIZATION_CLASS_EVIDENCE_INCOMPLETE'] : [])], partialCapacity || missing || !complete);
    const ratio = (minutes: number, missing: boolean) => metric(hasCoverage && usable > 0 && !missing && !identityUnknown && !busyDurationUnknown ? minutes / usable * 100 : null, [...capacityReasons, ...(usable === 0 ? ['NO_USABLE_CAPACITY'] : []), ...(missing ? ['UTILIZATION_CLASS_EVIDENCE_INCOMPLETE'] : [])], partialCapacity || !complete);
    return {
        uniqueStudents: metric(absentDemand ? null : ids.size, participantReasons, demandPartial || membershipUnknown),
        studentBookings: metric(absentDemand ? null : bookings, participantReasons, demandPartial || membershipUnknown),
        distinctClasses: metric(absentDemand ? null : rows.length, demandReasons, demandPartial),
        bookedHours: metric(absentDemand || durationUnknown && !booked ? null : booked, [...demandReasons, ...(durationUnknown ? ['SCHEDULED_DURATION_UNKNOWN'] : [])], demandPartial || durationUnknown),
        cancelledBookings: metric(absentDemand ? null : cancelled, participantReasons, demandPartial || membershipUnknown),
        noShowBookings: metric(absentDemand ? null : noShows, participantReasons, demandPartial || membershipUnknown),
        creditConsumedHours: sumEvidence(rows, 'consumed', mask, complete, exactOverlap), recordedTeachingHours: sumEvidence(rows, 'taught', mask, complete, exactOverlap),
        qualifiedPeople: metric(qualificationsKnown ? qualified : null, !qualificationsKnown ? ['QUALIFICATION_HISTORY_MISSING'] : qualificationPartial ? ['QUALIFICATIONS_PARTIAL'] : [], qualificationPartial),
        offeredHours: cap(offered), leaveHours: cap(leave), usableHours: cap(usable), freeHours: busyDurationUnknown ? metric(null, capacityReasons) : cap(free),
        reservedHours: metric(absentDemand || busyDurationUnknown ? null : reserved / 60, identityUnknown ? ['CONFLICTING_TUTOR_ASSIGNMENT'] : demandReasons, demandPartial),
        outsideHours: cap(outside), overlapHours: cap(overlap),
        utilizationReservedHours: numerator(maskedReserved, identityUnknown), utilizationCreditConsumedHours: numerator(maskedConsumed, missingConsumed), utilizationRecordedTeachingHours: numerator(maskedTaught, missingTaught),
        coverageHours: metric(coverage / 60, capacityReasons, partialCapacity), expectedCoverageHours: metric(expected / 60),
        coveragePercent: metric(expected > 0 ? coverage / expected * 100 : null, capacityReasons, partialCapacity),
        reservedUtilizationPercent: ratio(maskedReserved, identityUnknown), consumedUtilizationPercent: ratio(maskedConsumed, missingConsumed), recordedTeachingUtilizationPercent: ratio(maskedTaught, missingTaught),
    };
}
export function subjectKey(month: string, subject: string, curriculum: string | null, level: string | null): string {
    return 'subject:' + JSON.stringify([month, subject, curriculum, level]);
}
export function weekKey(month: string, weekday: number, minute: number): string { return `week:${month}:${weekday}:${minute}`; }
function monthMask(month: string, bounds: Interval): Interval[] { return intersectIntervals([bangkokMonthBounds(month)], [bounds]); }
export function weekMask(query: WorkforceQuery, weekday: number, minute: number): Interval[] {
    const month = bangkokMonthBounds(query.viewMonth), bounds = queryBounds(query), result: Interval[] = [];
    for (let day = month.start; day < month.end; day += DAY)
        if (new Date(day + 7 * 3600000).getUTCDay() === weekday) {
            result.push(...intersectIntervals([{ start: day + minute * MINUTE, end: day + (minute + 30) * MINUTE }], [bounds]));
        }
    return result;
}
function buildReport(prepared: PreparedWorkforce): WorkforceReport {
    const { evidence, query, now } = prepared, bounds = queryBounds(query);
    const turnover = buildTurnoverMonths(evidence, query, now);
    const months = turnover.map(row => ({ ...row, ...measureWorkforce(prepared, query, monthMask(row.month, bounds)) }));
    const subjects: WorkforceSubjectRow[] = [];
    const dimensions = new Map<string, {
        subject: string;
        curriculum: string | null;
        level: string | null;
        depth: 0 | 1 | 2;
    }>();
    function addDimension(subject: string, curriculum: string | null, level: string | null) {
        for (const [c, l, depth] of [[null, null, 0], [curriculum, null, 1], [curriculum, level, 2]] as const) {
            if (depth === 1 && c === null || depth === 2 && l === null)
                continue;
            dimensions.set(JSON.stringify([subject, c, l]), { subject, curriculum: c, level: l, depth });
        }
    }
    for (const p of prepared.capacity)
        for (const s of p.qualificationSpans)
            if (qualificationMatches(s.qualification, query))
                addDimension(s.qualification.subject, s.qualification.curriculum, s.qualification.level);
    for (const row of prepared.classes)
        if (row.interval && intervalMinutes(intersectIntervals([row.interval], [bounds])) && classMatches(row.session, query))
            addDimension(row.session.subject ?? 'Unmapped', row.session.curriculum, row.session.level);
    const subjectClasses = Map.groupBy(prepared.classes, r => r.session.subject ?? 'Unmapped');
    for (const month of months)
        for (const dimension of dimensions.values()) {
            const filtered = { ...query, subject: dimension.subject, curriculum: dimension.curriculum ?? query.curriculum, level: dimension.level ?? query.level };
            const key = subjectKey(month.month, dimension.subject, dimension.curriculum, dimension.level);
            const rows = subjectClasses.get(dimension.subject) ?? [];
            // Unmapped records have an explicit bucket rather than an inferred academic subject.
            const eligibleRows = dimension.subject === 'Unmapped' ? rows.map(r => ({ ...r, session: { ...r.session, subject: 'Unmapped' } })) : rows;
            subjects.push({ ...measureWorkforce(prepared, filtered, monthMask(month.month, bounds), eligibleRows), ...dimension, month: month.month, key,
                parentKey: dimension.depth === 0 ? null : subjectKey(month.month, dimension.subject, dimension.depth === 1 ? null : dimension.curriculum, null), modality: query.modality });
        }
    const cellRows = new Map<string, PreparedClass[]>();
    const selectedMonth = intersectIntervals([bangkokMonthBounds(query.viewMonth)], [bounds]);
    for (const row of prepared.classes)
        if (row.interval)
            for (const span of intersectIntervals([row.interval], selectedMonth)) {
                for (let cursor = Math.floor((span.start + 7 * 3600000) / (30 * MINUTE)) * 30 * MINUTE - 7 * 3600000; cursor < span.end; cursor += 30 * MINUTE) {
                    const local = new Date(cursor + 7 * 3600000), key = weekKey(query.viewMonth, local.getUTCDay(), local.getUTCHours() * 60 + local.getUTCMinutes());
                    const rows = cellRows.get(key) ?? [];
                    if (!rows.includes(row))
                        rows.push(row);
                    cellRows.set(key, rows);
                }
            }
    const weekCells: WorkforceWeekCell[] = [];
    for (let weekday = 0; weekday < 7; weekday++)
        for (let minute = 0; minute < 1440; minute += 30) {
            const mask = weekMask(query, weekday, minute), key = weekKey(query.viewMonth, weekday, minute), people = pool(prepared, query);
            const monthlyTotals = measureWorkforce(prepared, query, mask, cellRows.get(key) ?? [], people, true);
            const coveredDates = mask.filter(span => people.some(p => intervalMinutes(intersectIntervals(capacityMask(p, query), [span])) > 0)).length;
            const demandDates = mask.filter(span => sourceComplete(prepared, [span])).length;
            const average = Object.fromEntries(Object.entries(monthlyTotals).map(([field, value]) => {
                if (field.endsWith('Percent') || field === 'qualifiedPeople')
                    return [field, value];
                const denominator = ['uniqueStudents', 'studentBookings', 'distinctClasses', 'bookedHours', 'cancelledBookings', 'noShowBookings', 'creditConsumedHours', 'recordedTeachingHours', 'reservedHours'].includes(field) ? demandDates : coveredDates;
                return [field, { ...value, value: value.value === null || denominator === 0 ? null : value.value / denominator,
                        reasonCodes: unique([...value.reasonCodes, `COVERED_OCCURRENCES:${denominator}`]) }];
            })) as unknown as WorkforceUtilizationMetrics;
            const contributingRows = (cellRows.get(key) ?? []).filter(r => classMatches(r.session, query) && (query.role === 'all' || r.session.canonicalTutorKeys.some(k => people.some(p => p.canonicalKey === k))));
            const studentOccurrences = mask.filter(span => sourceComplete(prepared, [span])).reduce((sum, span) => sum + new Set(contributingRows.filter(r => r.interval && intervalMinutes(intersectIntervals([r.interval], [span])) > 0).flatMap(r => r.session.historicalBookedStudentIds ?? [])).size, 0);
            average.uniqueStudents = { ...average.uniqueStudents, value: demandDates > 0 ? studentOccurrences / demandDates : null };
            const qualifiedOccurrences = mask.reduce((sum, span) => sum + people.filter(p => p.qualificationSpans.some(s => qualificationMatches(s.qualification, query) && intervalMinutes(intersectIntervals([s.interval], [span])) > 0)).length, 0);
            average.qualifiedPeople = { ...average.qualifiedPeople, value: coveredDates > 0 ? qualifiedOccurrences / coveredDates : null };
            weekCells.push({ ...average, key, month: query.viewMonth, weekday, startMinute: minute, endMinute: minute + 30, coveredDates,
                calendarOccurrences: mask.length, monthlyTotals, subject: query.subject ?? null, curriculum: query.curriculum ?? null, level: query.level ?? null, modality: query.modality });
        }
    const byPerson = new Map<string, PreparedClass[]>();
    for (const row of prepared.classes)
        for (const key of row.session.canonicalTutorKeys) {
            const rows = byPerson.get(key) ?? [];
            rows.push(row);
            byPerson.set(key, rows);
        }
    const people = evidence.people.filter(p => p.role && (query.role === 'all' || p.role === query.role)).map(person => {
        const capacity = prepared.capacity.filter(p => p.canonicalKey === person.canonicalKey), rows = byPerson.get(person.canonicalKey) ?? [];
        const state = person as ReturnType<typeof buildWorkforcePersonStates>[number];
        return { ...measureWorkforce(prepared, query, [bounds], rows, capacity), canonicalKey: person.canonicalKey, displayName: person.displayName,
            role: person.role, rosterState: person.rosterState, joinedAt: person.joinedAt, departedAt: state.departedAt, pendingDeparture: state.pendingDeparture,
            months: months.map(m => ({ month: m.month, ...measureWorkforce(prepared, query, monthMask(m.month, bounds), rows, capacity) })), reasonCodes: unique([...person.reasonCodes, ...(capacity[0]?.reasonCodes ?? [])]) };
    });
    const totals = measureWorkforce(prepared, query, [bounds]);
    const issueCodes = unique([...evidence.sourceCoverage.flatMap(c => c.issueCodes), ...evidence.people.filter(p => !p.role).map(() => 'ROLE_UNCONFIRMED'),
        ...prepared.classes.flatMap(r => r.session.reasonCodes), ...Object.values(totals).flatMap(m => m.completeness === 'complete' ? [] : m.reasonCodes)]);
    const digest = createHash('sha256').update(JSON.stringify({ revision: evidence.revision ?? evidence, query, totals, months, sourceCoverage: evidence.sourceCoverage })).digest('hex');
    // Carry the calculation instant so a later drilldown/export does not extend
    // an in-progress observation merely because another request took time.
    const reportRevision = `v2:${now.getTime()}:${digest}`;
    return { schemaVersion: 1, reportRevision, generatedAt: now.toISOString(), query, totals, months, subjects, weekCells, people,
        quality: { completeness: Object.values(totals).some(m => m.completeness !== 'complete') || issueCodes.length ? 'partial' : 'complete', issueCodes, sourceCoverage: evidence.sourceCoverage,
            exceptions: prepared.classes.filter(r => !r.session.subject || r.session.canonicalTutorKeys.length !== 1 || !r.interval).map(r => ({ code: !r.session.subject ? 'ACADEMIC_SUBJECT_UNMAPPED' : 'SESSION_IDENTITY_OR_DURATION_UNKNOWN', message: 'This class has unresolved source evidence.', entityId: r.session.wiseSessionId })) } };
}
export function buildPreparedWorkforceReport(prepared: PreparedWorkforce): WorkforceReport { return buildReport(prepared); }
export function buildWorkforceReport(evidence: WorkforceEvidence, query: WorkforceQuery, now: Date): WorkforceReport {
    return buildReport(prepareWorkforce(evidence, query, now));
}
