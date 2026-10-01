import { it, expect } from 'vitest';
import { buildCapacity } from '../capacity';
import { evidence, query, now, start, HOUR, addSession } from './calculation-fixtures';
import { intervalMinutes } from '../intervals';
it('keeps a single shared pool and subtracts leave and unioned blocking bookings', () => {
    const e = evidence();
    e.observations.forEach(o => o.leaves = []);
    addSession(e, 'physics', 10, 60);
    const result = buildCapacity(e, query, now), person = result.people[0];
    expect(intervalMinutes(person.offered)).toBe(480);
    expect(intervalMinutes(person.free)).toBe(420);
    expect(person.qualificationSpans.some(s => s.qualification.subject === 'Math')).toBe(true);
    expect(person.qualificationSpans.some(s => s.qualification.subject === 'Physics')).toBe(true);
});
it('closes observation at an explicit failure and leaves the outage unknown', () => {
    const e = evidence();
    e.observations = e.observations.slice(0, 1);
    e.observations[0].offeredWindows = [{ weekday: 1, startMinute: 0, endMinute: 1440, modality: 'onsite' }];
    e.observations.push({ ...e.observations[0], id: 'failed', observedAt: new Date(start + HOUR).toISOString(), availabilityCompleteness: 'unknown', completeness: 'partial' });
    const person = buildCapacity(e, query, now).people[0];
    expect(intervalMinutes(person.coverage)).toBe(60);
    expect(intervalMinutes(person.offered)).toBe(60);
    expect(person.reasonCodes).toContain('AVAILABILITY_COVERAGE_PARTIAL');
});
it('keeps March capacity unknown without observations and excludes later-today projection from actual coverage', () => {
    const e = evidence();
    e.observations = [];
    expect(buildCapacity(e, query, now).people[0].coverage).toEqual([]);
    const observed = evidence();
    const instant = new Date(start + 10.5 * HOUR);
    const result = buildCapacity(observed, query, instant).people[0];
    expect(result.coverage.every(i => i.end <= instant.getTime())).toBe(true);
    expect(result.projectionOffered.some(i => i.end > instant.getTime())).toBe(true);
});
it('caps a cached availability payload at its original fetch time, not the later capture time', () => {
    const e = evidence();
    e.observations = [{ ...e.observations[0], observedAt: new Date(start + HOUR).toISOString(), sourceTimes: { roster: new Date(start + HOUR).toISOString(), availability: new Date(start).toISOString(), nearLeaves: null, farLeaves: null }, offeredWindows: [{ weekday: 1, startMinute: 0, endMinute: 1440, modality: 'onsite' }] }];
    expect(intervalMinutes(buildCapacity(e, query, now).people[0].coverage)).toBe(30);
});
it('keeps known qualification capacity partial when other qualification tags are unmapped', () => {
    const e = evidence();
    e.observations.forEach(o => o.qualificationCompleteness = 'partial');
    const p = buildCapacity(e, { ...query, subject: 'Math' }, now).people[0];
    expect(intervalMinutes(p.usable)).toBe(360);
    expect(p.reasonCodes).toContain('QUALIFICATIONS_PARTIAL');
});
