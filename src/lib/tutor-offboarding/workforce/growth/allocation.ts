import { createHash } from 'node:crypto';
import { bangkokMonthBounds } from '../intervals';
import type { WorkforceMetric } from '../types';
import type { GrowthAllocationInput, GrowthAllocationResult, GrowthCourse } from './types';
const HOUR = 3600000, HALF = 1800000, DAY = 86400000, EPS = 1e-9;
interface Edge {
    to: number;
    reverse: number;
    remaining: number;
}
/** Dinic's residual graph permits reassignment; greedy subject allocation cannot do that. */
function maxFlow(people: Array<{
    key: string;
    courses: Set<string>;
    hours: number;
}>, needs: Array<{
    key: string;
    hours: number;
}>): Map<string, number> {
    const source = 0, personStart = 1, courseStart = personStart + people.length, sink = courseStart + needs.length;
    const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
    const add = (from: number, to: number, hours: number) => { const edge = { to, remaining: hours, reverse: graph[to].length }; graph[from].push(edge); graph[to].push({ to: from, remaining: 0, reverse: graph[from].length - 1 }); return edge; };
    for (let p = 0; p < people.length; p++) {
        add(source, personStart + p, people[p].hours);
        for (let c = 0; c < needs.length; c++)
            if (people[p].courses.has(needs[c].key))
                add(personStart + p, courseStart + c, people[p].hours);
    }
    const sinks = needs.map((need, c) => add(courseStart + c, sink, need.hours));
    while (true) {
        const level = Array(graph.length).fill(-1);
        level[source] = 0;
        const queue = [source];
        for (let head = 0; head < queue.length; head++)
            for (const e of graph[queue[head]])
                if (e.remaining > EPS && level[e.to] < 0) {
                    level[e.to] = level[queue[head]] + 1;
                    queue.push(e.to);
                }
        if (level[sink] < 0)
            break;
        const cursor = Array(graph.length).fill(0);
        const send = (node: number, limit: number): number => {
            if (node === sink)
                return limit;
            for (; cursor[node] < graph[node].length; cursor[node]++) {
                const e = graph[node][cursor[node]];
                if (e.remaining <= EPS || level[e.to] !== level[node] + 1)
                    continue;
                const sent = send(e.to, Math.min(limit, e.remaining));
                if (sent > EPS) {
                    e.remaining -= sent;
                    graph[e.to][e.reverse].remaining += sent;
                    return sent;
                }
            }
            return 0;
        };
        while (send(source, Number.MAX_SAFE_INTEGER) > EPS) { /* exhaust this level graph */ }
    }
    return new Map(needs.map((need, c) => [need.key, Math.max(0, need.hours - sinks[c].remaining)]));
}
function courseForKey(key: string, subject: string | null): GrowthCourse {
    try {
        const parsed = JSON.parse(key);
        if (Array.isArray(parsed) && parsed.length === 3 && typeof parsed[0] === 'string')
            return { courseKey: key, subject: parsed[0], curriculum: typeof parsed[1] === 'string' ? parsed[1] : null, level: typeof parsed[2] === 'string' ? parsed[2] : null };
    }
    catch { /* non-JSON keys are accepted by the source-neutral allocation interface */ }
    return { courseKey: key, subject: subject ?? 'Unmapped', curriculum: null, level: null };
}
/** Continuous dated flow, with actual assignments reserved before flexible modeled demand. */
export function allocateGrowthCapacity(input: GrowthAllocationInput): GrowthAllocationResult {
    const month = bangkokMonthBounds(input.month), events = new Map<number, Array<{
        kind: 'supply' | 'demand' | 'commit';
        id: number;
        add: boolean;
    }>>(), boundaries = new Set<number>([month.start, month.end]);
    const courses = new Map<string, GrowthCourse>(), reasons = new Set(input.reasonCodes);
    if (!Number.isFinite(input.bufferPercent) || input.bufferPercent < 0 || input.bufferPercent > 100)
        throw new RangeError('Invalid capacity buffer');
    function register(kind: 'supply' | 'demand' | 'commit', id: number, startAt: string, endAt: string, buckets: boolean) {
        const originalStart = Date.parse(startAt), originalEnd = Date.parse(endAt);
        if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd) || originalEnd <= originalStart)
            throw new RangeError('Invalid allocation interval');
        const start = Math.max(month.start, originalStart), end = Math.min(month.end, originalEnd);
        if (end <= start)
            return;
        for (const [at, add] of [[start, true], [end, false]] as const) {
            boundaries.add(at);
            events.set(at, [...(events.get(at) ?? []), { kind, id, add }]);
        }
        if (buckets)
            for (let at = Math.floor((start + 7 * HOUR) / HALF) * HALF - 7 * HOUR; at < end; at += HALF)
                if (at > start)
                    boundaries.add(at);
    }
    input.supply.forEach((row, id) => register('supply', id, row.startAt, row.endAt, false));
    input.demand.forEach((row, id) => {
        if (!Number.isFinite(row.hours) || row.hours < 0)
            throw new RangeError('Invalid allocation demand');
        courses.set(row.courseKey, { courseKey: row.courseKey, subject: row.subject, curriculum: row.curriculum, level: row.level });
        if (row.hours > 0)
            register('demand', id, row.startAt, row.endAt, true);
    });
    const commitments = [...new Map([...input.commitments].sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey) || a.wiseSessionId.localeCompare(b.wiseSessionId)).map(row => [row.wiseSessionId, row])).values()];
    commitments.forEach((row, id) => {
        if (row.courseKey && !courses.has(row.courseKey))
            courses.set(row.courseKey, courseForKey(row.courseKey, row.subject));
        if (!row.courseKey)
            reasons.add('UNMAPPED_BOOKING_COMMITMENT');
        register('commit', id, row.startAt, row.endAt, true);
    });
    // Bookings form part of the monthly model. Only its uncommitted residual is patterned.
    const modeledTotals = new Map<string, number>(), bookedTotals = new Map<string, number>();
    const overlapHours = (startAt: string, endAt: string) => Math.max(0, Math.min(month.end, Date.parse(endAt)) - Math.max(month.start, Date.parse(startAt))) / HOUR;
    for (const row of input.demand)
        modeledTotals.set(row.courseKey, (modeledTotals.get(row.courseKey) ?? 0) + row.hours * overlapHours(row.startAt, row.endAt) / ((Date.parse(row.endAt) - Date.parse(row.startAt)) / HOUR));
    for (const row of commitments)
        if (row.courseKey)
            bookedTotals.set(row.courseKey, (bookedTotals.get(row.courseKey) ?? 0) + overlapHours(row.startAt, row.endAt));
    const residualFraction = new Map([...modeledTotals].map(([key, total]) => [key, total > 0 ? Math.max(0, total - (bookedTotals.get(key) ?? 0)) / total : 0]));
    const active = { supply: new Set<number>(), demand: new Set<number>(), commit: new Set<number>() };
    const cells = new Map<string, {
        course: GrowthCourse;
        weekday: number;
        startMinute: number;
        endMinute: number;
        required: number;
        allocated: number;
    }>();
    let unmappedRequired = 0, unmappedAllocated = 0;
    const unmappedGapByWeekday = new Map<number, number>();
    const times = [...boundaries].sort((a, b) => a - b);
    for (let i = 0; i < times.length - 1; i++) {
        const start = times[i], end = times[i + 1];
        for (const event of events.get(start) ?? [])
            if (event.add)
                active[event.kind].add(event.id);
            else
                active[event.kind].delete(event.id);
        if (!active.demand.size && !active.commit.size)
            continue;
        const hours = (end - start) / HOUR;
        const supply = new Map<string, Set<string>>();
        for (const id of active.supply) {
            const row = input.supply[id];
            const set = supply.get(row.canonicalKey) ?? new Set<string>();
            for (const key of row.courseKeys)
                set.add(key);
            supply.set(row.canonicalKey, set);
        }
        const modeled = new Map<string, number>();
        for (const id of active.demand) {
            const row = input.demand[id], duration = (Date.parse(row.endAt) - Date.parse(row.startAt)) / HOUR;
            modeled.set(row.courseKey, (modeled.get(row.courseKey) ?? 0) + row.hours / duration * hours * (residualFraction.get(row.courseKey) ?? 0));
        }
        const booked = new Map<string, number>(), allocated = new Map<string, number>(), occupied = new Set<string>();
        let unknownRequired = 0, unknownAllocated = 0;
        for (const id of [...active.commit].sort((a, b) => (commitments[a].courseKey ?? '').localeCompare(commitments[b].courseKey ?? '') || commitments[a].wiseSessionId.localeCompare(commitments[b].wiseSessionId))) {
            const row = commitments[id];
            if (!row.courseKey)
                unknownRequired += hours;
            if (row.courseKey)
                booked.set(row.courseKey, (booked.get(row.courseKey) ?? 0) + hours);
            if (occupied.has(row.canonicalKey)) {
                reasons.add('OVERLAPPING_BOOKING_COMMITMENTS');
                continue;
            }
            occupied.add(row.canonicalKey);
            if (!row.courseKey && supply.has(row.canonicalKey))
                unknownAllocated += hours;
            if (row.courseKey && supply.get(row.canonicalKey)?.has(row.courseKey))
                allocated.set(row.courseKey, (allocated.get(row.courseKey) ?? 0) + hours);
            else if (row.courseKey)
                reasons.add('COMMITMENT_OUTSIDE_KNOWN_SUPPLY');
        }
        const required = new Map<string, number>();
        for (const key of new Set([...modeled.keys(), ...booked.keys()]))
            required.set(key, (modeled.get(key) ?? 0) + (booked.get(key) ?? 0));
        const people = [...supply].filter(([key]) => !occupied.has(key)).map(([key, courses]) => ({ key, courses, hours })).sort((a, b) => a.courses.size - b.courses.size || a.key.localeCompare(b.key));
        // Unfilled assigned commitments remain gaps; they cannot be reassigned to erase the staffing floor.
        const needs = [...required].map(([key, need]) => ({ key, hours: Math.max(0, need - (booked.get(key) ?? 0)) })).filter(n => n.hours > EPS).sort((a, b) => people.filter(p => p.courses.has(a.key)).length - people.filter(p => p.courses.has(b.key)).length || a.key.localeCompare(b.key));
        const flexible = maxFlow(people, needs);
        for (const [key, h] of flexible)
            allocated.set(key, (allocated.get(key) ?? 0) + h);
        const local = new Date(start + 7 * HOUR), weekday = local.getUTCDay(), startMinute = local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60 + local.getUTCMilliseconds() / 60000, endMinute = startMinute + (end - start) / 60000;
        unmappedRequired += unknownRequired;
        unmappedAllocated += unknownAllocated;
        unmappedGapByWeekday.set(weekday, (unmappedGapByWeekday.get(weekday) ?? 0) + unknownRequired - unknownAllocated);
        for (const [courseKey, requiredHours] of required) {
            const key = JSON.stringify([courseKey, weekday, startMinute, endMinute]);
            const row = cells.get(key) ?? { course: courses.get(courseKey)!, weekday, startMinute, endMinute, required: 0, allocated: 0 };
            row.required += requiredHours;
            row.allocated += Math.min(requiredHours, allocated.get(courseKey) ?? 0);
            cells.set(key, row);
        }
    }
    const occurrences = new Map<number, number>();
    for (let day = month.start; day < month.end; day += DAY) {
        const weekday = new Date(day + 7 * HOUR).getUTCDay();
        occurrences.set(weekday, (occurrences.get(weekday) ?? 0) + 1);
    }
    const metric = (value: number | null): WorkforceMetric => ({ value: value === null ? null : Number(value.toFixed(9)), completeness: value === null ? 'unknown' : input.completeness === 'complete' && !reasons.has('UNMAPPED_BOOKING_COMMITMENT') ? 'complete' : 'partial', reasonCodes: [...reasons].sort() });
    // Allocation-level provenance is retained once; every chart metric keeps its local quality state.
    const cellMetric = (value: number | null): WorkforceMetric => {
        const result = metric(value);
        return { ...result, reasonCodes: result.completeness === 'unknown' ? ['PROJECTED_CAPACITY_UNKNOWN'] : result.completeness === 'partial' ? ['ALLOCATION_SOURCE_PARTIAL'] : [] };
    };
    const resultCells = [...cells.values()].sort((a, b) => a.course.courseKey.localeCompare(b.course.courseKey) || a.weekday - b.weekday || a.startMinute - b.startMinute || a.endMinute - b.endMinute).map(row => { const weekly = (row.required - row.allocated) / (occurrences.get(row.weekday) ?? 1), unknown = input.completeness === 'unknown'; return { ...row.course, key: `allocation:${input.month}:${createHash('sha256').update(row.course.courseKey).digest('hex').slice(0, 20)}:${row.weekday}:${row.startMinute}:${row.endMinute}`, month: input.month, weekday: row.weekday, startMinute: row.startMinute, endMinute: row.endMinute, requiredHours: cellMetric(row.required), allocatedHours: cellMetric(unknown ? null : row.allocated), additionalWeeklyHours: cellMetric(unknown ? null : Math.max(0, weekly)), bufferedAdditionalWeeklyHours: cellMetric(unknown ? null : Math.max(0, weekly) * (1 + input.bufferPercent / 100)) }; });
    const required = unmappedRequired + resultCells.reduce((sum, row) => sum + row.requiredHours.value!, 0), allocated = unmappedAllocated + resultCells.reduce((sum, row) => sum + (row.allocatedHours.value ?? 0), 0), weekly = [...unmappedGapByWeekday].reduce((sum, [weekday, hours]) => sum + hours / (occurrences.get(weekday) ?? 1), 0) + resultCells.reduce((sum, row) => sum + (row.additionalWeeklyHours.value ?? 0), 0);
    return { month: input.month, requiredHours: metric(required), allocatedHours: metric(input.completeness === 'unknown' ? null : allocated), additionalWeeklyHours: metric(input.completeness === 'unknown' ? null : weekly), bufferedAdditionalWeeklyHours: metric(input.completeness === 'unknown' ? null : weekly * (1 + input.bufferPercent / 100)), cells: resultCells, observedAt: [...new Set(input.observedAt)].sort(), reasonCodes: [...reasons].sort() };
}
