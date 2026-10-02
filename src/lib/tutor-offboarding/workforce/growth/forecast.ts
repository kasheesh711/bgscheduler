import { TutorOffboardingError } from '../../errors';
import { buildCapacity, qualificationMatches, sessionInterval } from '../capacity';
import { isCancelledSession, isNoShowSession } from '../credits';
import { bangkokDayStart, bangkokMonthBounds, intersectIntervals } from '../intervals';
import { buildWorkforcePersonStates } from '../turnover';
import type { WorkforceMetric } from '../types';
import { allocateGrowthCapacity } from './allocation';
import { addMonths, historyCoversMonth, monthOf } from './calendar';
import { buildAllGrowthFlows } from './flows';
import { buildGrowthHiringEstimates } from './hiring';
import { growthKnown, growthUnknown, resolveGrowthBookings, hasFreshGrowthFutureEvidence } from './lifecycle';
import type { GrowthAllocationDemand, GrowthAllocationInput, GrowthCourse, GrowthEvidence, GrowthFlows, GrowthForecast, GrowthForecastInputs, GrowthForecastMonth, GrowthModelInput, GrowthQuery, GrowthSubjectOverrides } from './types';
const DAY = 86400000, HOUR = 3600000, MINUTE = 60000;
const fields = ['newStudentHours', 'reactivatedStudentHours', 'churnStudentHours', 'cancellationFraction', 'studentHoursPerTutorHour'] as const;
function input(measured: WorkforceMetric, override?: number): GrowthModelInput {
    const available=measured.completeness!=='unknown' && measured.value!==null;
    return {value:override ?? (available?measured.value:null),source:override!==undefined?'override':available?'measured':'unavailable',measured};
}
function validateOverrides(query: GrowthQuery, courses: Set<string>) {
    if (query.filters.role !== 'all' || query.filters.modality !== 'all')
        throw new TutorOffboardingError('Growth allocation covers all teaching staff and modes.', 422);
    if (!Number.isFinite(query.assumptions.bufferPercent) || query.assumptions.bufferPercent < 0 || query.assumptions.bufferPercent > 100)
        throw new TutorOffboardingError('Use a buffer from0 to100percent.', 422);
    for (const [key, values] of Object.entries(query.assumptions.subjects ?? {})) {
        if (!courses.has(key))
            throw new TutorOffboardingError('This course override does not match retained evidence.', 422);
        for (const [field, value] of Object.entries(values))
            if (!fields.includes(field as typeof fields[number]) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || field === 'cancellationFraction' && value > 1 || field === 'studentHoursPerTutorHour' && value <= 0)
                throw new TutorOffboardingError('Use valid nonnegative forecast assumptions.', 422);
    }
}
function courseMatches(course: GrowthCourse, query: GrowthQuery): boolean { return (!query.filters.subject || course.subject === query.filters.subject) && (!query.filters.curriculum || course.curriculum === query.filters.curriculum) && (!query.filters.level || course.level === query.filters.level); }
function projectedDemand(course: GrowthCourse, hours: number, patterns: GrowthFlows['patterns'], month: string): GrowthAllocationDemand[] {
    const bounds = bangkokMonthBounds(month), pieces: Array<{
        start: number;
        end: number;
        weight: number;
    }> = [];
    for (let day = bounds.start; day < bounds.end; day += DAY) {
        const weekday = new Date(day + 7 * HOUR).getUTCDay();
        for (const pattern of patterns) {
            if (pattern.courseKey !== course.courseKey || pattern.weekday !== weekday || pattern.completeness !== 'complete' || !Number.isFinite(pattern.share) || pattern.share <= 0 || pattern.endMinute <= pattern.startMinute)
                continue;
            for (let minute = pattern.startMinute; minute < pattern.endMinute;) {
                const endMinute = Math.min(pattern.endMinute, Math.floor(minute / 30) * 30 + 30);
                const start = day + minute * MINUTE, end = day + endMinute * MINUTE;
                if (end > start)
                    pieces.push({ start, end, weight: pattern.share * (end - start) / ((pattern.endMinute - pattern.startMinute) * MINUTE) });
                minute = endMinute;
            }
        }
    }
    const total = pieces.reduce((sum, p) => sum + p.weight, 0);
    return total > 0 ? pieces.map(p => ({ ...course, startAt: new Date(p.start).toISOString(), endAt: new Date(p.end).toISOString(), hours: hours * p.weight / total })) : [];
}
/** Full-pool model first; academic filters are applied only after competing allocation. */
export function buildGrowthForecast(evidence: GrowthEvidence, _displayFlows: GrowthFlows, query: GrowthQuery, now: Date, fullFlows?: GrowthFlows): GrowthForecast {
    const flows = fullFlows ?? buildAllGrowthFlows(evidence, now), baseMonth = addMonths(monthOf(now), -1), months = Array.from({ length: 12 }, (_, i) => addMonths(baseMonth, i + 1));
    const courses = new Map<string, GrowthCourse>();
    for (const row of [...flows.averages, ...flows.months, ...flows.patterns])
        courses.set(row.courseKey, { courseKey: row.courseKey, subject: row.subject, curriculum: row.curriculum, level: row.level });
    const bookings = resolveGrowthBookings(evidence);
    for (const row of bookings)
        if (row.course)
            courses.set(row.course.courseKey, { courseKey: row.course.courseKey, subject: row.course.subject, curriculum: row.course.curriculum, level: row.course.level });
    validateOverrides(query, new Set(courses.keys()));
    const inputs: GrowthForecastInputs[] = [...courses.values()].sort((a, b) => a.courseKey.localeCompare(b.courseKey)).map(course => {
        const base = flows.months.find(row => row.courseKey === course.courseKey && row.month === baseMonth)?.bookedStudentHours ?? (historyCoversMonth(evidence.workforce.sourceCoverage, baseMonth) ? growthKnown(0) : growthUnknown('BASE_MONTH_HISTORY_INCOMPLETE'));
        const average = flows.averages.find(row => row.courseKey === course.courseKey), override: GrowthSubjectOverrides = query.assumptions.subjects?.[course.courseKey] ?? {};
        return { ...course, baseStudentHours: input(base), ...Object.fromEntries(fields.map(field => [field, input(average?.[field] ?? growthUnknown('COMMON_MODEL_INPUT_UNAVAILABLE'), override[field])])) } as GrowthForecastInputs;
    });
    const states = buildWorkforcePersonStates(evidence.workforce, now), eligible = states.filter(p => p.role && p.rosterState === 'active' && !p.departedAt);
    const capacity = buildCapacity({ ...evidence.workforce, people: eligible }, { from: months[0] + '-01', to: new Date(bangkokMonthBounds(months.at(-1)!).end - 1 + 7 * HOUR).toISOString().slice(0, 10), viewMonth: months[0], role: 'all', modality: 'all' }, now, { projectionStart: bangkokMonthBounds(months[0]).start });
    const observations = Map.groupBy(evidence.workforce.observations.filter(o => Date.parse(o.observedAt) <= now.getTime()), o => o.canonicalKey), sourceReasons = new Set<string>();
    let supplyUnknown = eligible.length > 0 && !capacity.people.some(p => p.projectionSourceAt), supplyPartial = false;
    for (const person of capacity.people) {
        const latest = (observations.get(person.canonicalKey) ?? []).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
        if (!person.projectionSourceAt) {
            supplyPartial = true;
            sourceReasons.add('PROJECTED_AVAILABILITY_UNKNOWN');
        }
        if (latest?.availabilityCompleteness !== 'complete') {
            supplyPartial = true;
            sourceReasons.add('LATEST_AVAILABILITY_OBSERVATION_FAILED');
        }
        if (latest?.qualificationCompleteness !== 'complete') {
            supplyPartial = true;
            sourceReasons.add('PROJECTED_QUALIFICATIONS_PARTIAL');
        }
        if (person.projectionReasonCodes.includes('LAST_KNOWN_AVAILABILITY_STALE')) {
            supplyPartial = true;
            sourceReasons.add('PROJECTED_AVAILABILITY_STALE');
        }
        sourceReasons.add('FUTURE_RECURRENCE_PROJECTION');
        sourceReasons.add('FUTURE_LEAVE_HORIZON_NOT_PROVEN');
    }
    if ([...courses.values()].some(c => c.curriculum === null || c.level === null)) {
        supplyPartial = true;
        sourceReasons.add('COURSE_DIMENSIONS_PARTIAL');
    }
    if (!eligible.length) {
        supplyUnknown = true;
        sourceReasons.add('CURRENT_TEACHING_ROSTER_UNAVAILABLE');
    }
    if (eligible.some(p => p.pendingDeparture))
        sourceReasons.add('PENDING_DEPARTURE_AVAILABILITY_PROJECTED');
    if (states.some(p => !p.role)) {
        supplyPartial = true;
        sourceReasons.add('ROLE_UNCONFIRMED');
    }
    if (!hasFreshGrowthFutureEvidence(evidence, now)) {
        supplyPartial = true;
        sourceReasons.add('CURRENT_BOOKING_SNAPSHOT_UNCONFIRMED');
    }
    sourceReasons.add('MODELED_CURRENT_MONTH_RECURRENCE');
    const supply = capacity.people.flatMap(person => { const courseKeys = [...courses.values()].filter(course => person.projectionQualificationSpans.some(span => qualificationMatches(span.qualification, { subject: course.subject, curriculum: course.curriculum ?? undefined, level: course.level ?? undefined, modality: 'all' }))).map(c => c.courseKey).sort(); return person.projectionUsable.map(span => ({ canonicalKey: person.canonicalKey, startAt: new Date(span.start).toISOString(), endAt: new Date(span.end).toISOString(), courseKeys })); });
    const future = bookings.filter(b => !isCancelledSession(b.session) && !isNoShowSession(b.session) && !b.session.reasonCodes.includes('absent_from_current_future_snapshot') && (sessionInterval(b.session)?.end ?? Date.parse(b.session.startAt)) > now.getTime());
    const commitments = future.flatMap(b => {
        const span = sessionInterval(b.session);
        if (!span) {
            supplyPartial = true;
            sourceReasons.add('BOOKING_COMMITMENT_DURATION_UNKNOWN');
            return [];
        }
        if (b.session.canonicalTutorKeys.length !== 1) {
            supplyPartial = true;
            sourceReasons.add('BOOKING_COMMITMENT_IDENTITY_UNKNOWN');
        }
        if (!b.course) {
            supplyPartial = true;
            sourceReasons.add('BOOKING_COMMITMENT_ACADEMIC_MAPPING_UNKNOWN');
        }
        return [{ wiseSessionId: b.session.wiseSessionId, canonicalKey: b.session.canonicalTutorKeys.length === 1 ? b.session.canonicalTutorKeys[0] : 'unresolved:' + b.session.wiseSessionId, subject: b.course?.subject ?? null, courseKey: b.course?.courseKey ?? null, startAt: new Date(Math.max(now.getTime(), span.start)).toISOString(), endAt: new Date(span.end).toISOString() }];
    });
    const supplyByMonth = new Map<string, typeof supply>();
    const commitmentsByMonth = new Map<string, typeof commitments>();
    const committedHours = new Map<string, number>();
    for (const month of months) {
        const bounds = bangkokMonthBounds(month);
        supplyByMonth.set(month, supply.filter(s => Date.parse(s.startAt) < bounds.end && Date.parse(s.endAt) > bounds.start));
        const rows = commitments.filter(c => Date.parse(c.startAt) < bounds.end && Date.parse(c.endAt) > bounds.start);
        commitmentsByMonth.set(month, rows);
        for (const row of rows)
            if (row.courseKey) {
                const hours = intersectIntervals([{ start: Date.parse(row.startAt), end: Date.parse(row.endAt) }], [bounds]).reduce((sum, span) => sum + (span.end - span.start) / HOUR, 0);
                const key = JSON.stringify([month, row.courseKey]);
                committedHours.set(key, (committedHours.get(key) ?? 0) + hours);
            }
    }
    const forecastRows: GrowthForecastMonth[] = [], allocations: GrowthForecast['allocations'] = [];
    for (let k = 0; k < months.length; k++) {
        const month = months[k], demand: GrowthAllocationDemand[] = [], pending: Array<{
            row: GrowthForecastMonth;
            modeledKnown: boolean;
        }> = [], monthReasons = new Set(sourceReasons);
        let missingModels = false, missingPatterns = false, partialModels = false;
        for (const model of inputs) {
            const values = [model.baseStudentHours, model.newStudentHours, model.reactivatedStudentHours, model.churnStudentHours];
            const raw = values.every(v => v.value !== null) ? Math.max(0, model.baseStudentHours.value! + (k + 1) * (model.newStudentHours.value! + model.reactivatedStudentHours.value! - model.churnStudentHours.value!)) : null;
            const cancellation = model.cancellationFraction.value, mix = model.studentHoursPerTutorHour.value, net = raw !== null && cancellation !== null ? raw * (1 - cancellation) : null, tutor = raw !== null && mix !== null ? raw / mix : null, netTutor = net !== null && mix !== null ? net / mix : null;
            const missing = fields.filter(field => model[field].value === null).map(field => 'MODEL_INPUT_UNAVAILABLE:' + field);
            if (model.baseStudentHours.value === null)
                missing.push('MODEL_INPUT_UNAVAILABLE:baseStudentHours');
            const modelInputs=[model.baseStudentHours,...fields.map(field=>model[field])];
            const partialModel=modelInputs.some(value=>value.source==='measured' && value.measured.completeness!=='complete');
            const modelReasons=[...fields.filter(field=>model[field].source==='override').map(field=>'OVERRIDE:'+field),
                ...modelInputs.filter(value=>value.source==='measured').flatMap(value=>value.measured.reasonCodes),...(partialModel?['RECORDED_MODEL_ESTIMATE']:[])];
            if(partialModel){partialModels=true;for(const reason of modelReasons)monthReasons.add(reason);}
            const metric = (value: number | null): WorkforceMetric => value === null ? growthUnknown(...missing,...modelReasons) :
                {value,completeness:partialModel?'partial':'complete',reasonCodes:[...new Set(modelReasons)].sort()};
            const knownCommitments = committedHours.get(JSON.stringify([month, model.courseKey])) ?? 0;
            let distributed: GrowthAllocationDemand[] = [];
            if (netTutor !== null && netTutor > 0)
                distributed = projectedDemand(model, netTutor, flows.patterns, month);
            if (netTutor === null) {
                missingModels = true;
                monthReasons.add('COMPETING_MODEL_DEMAND_INCOMPLETE');
            }
            else if (netTutor > knownCommitments && !distributed.length) {
                missingPatterns = true;
                monthReasons.add('FORECAST_TIME_PATTERN_UNAVAILABLE');
            }
            demand.push(...distributed);
            pending.push({ modeledKnown: netTutor !== null && (netTutor <= knownCommitments || distributed.length > 0), row: { courseKey: model.courseKey, subject: model.subject, curriculum: model.curriculum, level: model.level, key: 'forecast:' + JSON.stringify([month, model.courseKey]), month, bookedStudentHours: metric(raw), creditStudentHours: metric(net), bookedTutorHours: metric(tutor), creditTutorHours: metric(netTutor), flatStudentHours: metric(model.baseStudentHours.value), knownCommittedTutorHours: growthKnown(knownCommitments), capacityRequiredTutorHours: growthUnknown('ALLOCATION_PENDING'), additionalWeeklyHours: growthUnknown('ALLOCATION_PENDING'), bufferedAdditionalWeeklyHours: growthUnknown('ALLOCATION_PENDING') } });
        }
        const allocationInput: GrowthAllocationInput = { month, supply: supplyByMonth.get(month) ?? [], demand, commitments: commitmentsByMonth.get(month) ?? [], completeness: supplyUnknown || missingPatterns ? 'unknown' : supplyPartial || missingModels || partialModels ? 'partial' : 'complete', reasonCodes: [...monthReasons].sort(), bufferPercent: query.assumptions.bufferPercent, observedAt: capacity.people.flatMap(p => p.projectionSourceAt ? [p.projectionSourceAt] : []) };
        const allocation = allocateGrowthCapacity(allocationInput);
        allocations.push(allocation);
        for (const { row, modeledKnown } of pending) {
            const cells = allocation.cells.filter(c => c.courseKey === row.courseKey), sum = (field: 'requiredHours' | 'additionalWeeklyHours' | 'bufferedAdditionalWeeklyHours'): WorkforceMetric => { const unknown = cells.some(c => c[field].value === null); const value = unknown ? null : cells.reduce((total, c) => total + c[field].value!, 0); return { value, completeness: value === null ? 'unknown' : allocationInput.completeness === 'complete' ? 'complete' : 'partial', reasonCodes: allocation.reasonCodes }; };
            row.capacityRequiredTutorHours = modeledKnown ? sum('requiredHours') : { value: row.knownCommittedTutorHours.value! > 0 ? row.knownCommittedTutorHours.value : null, completeness: row.knownCommittedTutorHours.value! > 0 ? 'partial' : 'unknown', reasonCodes: ['MODEL_OR_PATTERN_CAPACITY_UNAVAILABLE', 'KNOWN_COMMITMENT_FLOOR'] };
            row.additionalWeeklyHours = modeledKnown ? sum('additionalWeeklyHours') : growthUnknown('MODEL_OR_PATTERN_CAPACITY_UNAVAILABLE');
            row.bufferedAdditionalWeeklyHours = modeledKnown ? sum('bufferedAdditionalWeeklyHours') : growthUnknown('MODEL_OR_PATTERN_CAPACITY_UNAVAILABLE');
            forecastRows.push(row);
        }
    }
    const hiring = buildGrowthHiringEstimates(evidence, allocations, now), issueCodes = [...new Set([...flows.quality.issueCodes, ...allocations.flatMap(a => a.reasonCodes), ...forecastRows.flatMap(row => [row.bookedStudentHours, row.creditStudentHours, row.creditTutorHours].flatMap(m => m.value === null ? m.reasonCodes : []))])].sort();
    return { baseMonth, inputs: inputs.filter(c => courseMatches(c, query)), months: forecastRows.filter(c => courseMatches(c, query)), allocations: allocations.map(a => ({ ...a, cells: a.cells.filter(c => courseMatches(c, query)) })), hiring: hiring.filter(c => courseMatches(c, query)), bufferPercent: query.assumptions.bufferPercent,
        assumptions: ['Monthly starts and reactivations contribute the same hours in later months.', 'The common mature window supplies additions and losses.', 'Cancellation/refund loss is applied once.', 'Observed group mix remains constant.', 'Current recurrence and qualifications continue; approved recorded leave is subtracted.', 'All competing courses share each canonical tutor pool before display filters.', 'Assigned booking commitments remain a staffing floor.', 'Pending departure availability continues until a verified final departure.', 'The current forecast month models the latest recurrence over its full calendar month; these are projections, not observed past availability.', 'Hiring estimates overlap across courses and must not be summed.'], quality: { completeness: issueCodes.length ? 'partial' : 'complete', issueCodes, sourceCoverage: evidence.workforce.sourceCoverage, exceptions: flows.quality.exceptions } };
}
/** Display filters never change the lifecycle/model history or the competing supply pool. */
export function selectGrowthFlows(full: GrowthFlows, query: GrowthQuery): GrowthFlows {
    const partialDates = bangkokDayStart(query.filters.from) !== bangkokMonthBounds(query.filters.from.slice(0, 7)).start || bangkokDayStart(query.filters.to) + DAY !== bangkokMonthBounds(query.filters.to.slice(0, 7)).end;
    return { ...full, quality: partialDates ? { ...full.quality, completeness: 'partial', issueCodes: [...new Set([...full.quality.issueCodes, 'MONTHLY_DISPLAY_USES_CALENDAR_MONTH_TOTALS'])] } : full.quality,
        months: full.months.filter(row => row.month >= query.filters.from.slice(0, 7) && row.month <= query.filters.to.slice(0, 7) && courseMatches(row, query)),
        averages: full.averages.filter(row => courseMatches(row, query)),
        patterns: full.patterns.filter(row => courseMatches(row, query)),
        lifecycleEvents: full.lifecycleEvents.filter(event => !query.filters.subject || event.subject === query.filters.subject),
    };
}
