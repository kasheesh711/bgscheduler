import { it, expect, vi, beforeEach } from 'vitest';
vi.mock('../flows', () => ({ buildAllGrowthFlows: vi.fn() }));
import { buildAllGrowthFlows } from '../flows';
import { buildGrowthForecast } from '../forecast';
import { growthCourse, growthKnown, growthUnknown } from '../lifecycle';
import { evidence, now, query, booking } from './fixtures';
import type { GrowthFlows } from '../types';
const course = growthCourse('Maths', 'International', 'Y10');
function flows(): GrowthFlows { const m = growthKnown; return { months: [{ ...course, key: 'base', month: '2026-09', bookedStudentHours: m(100), bookedTutorHours: m(50) } as GrowthFlows['months'][number]], averages: [{ ...course, months: ['2026-06', '2026-07', '2026-08'], newStudentHours: m(12), reactivatedStudentHours: m(2), churnStudentHours: m(4), cancellationFraction: m(.1), cancellationNumerator: m(10), cancellationDenominator: m(100), studentHoursPerTutorHour: m(2) }], patterns: [{ ...course, weekday: 1, startMinute: 600, endMinute: 660, share: 1, completeness: 'complete', reasonCodes: [] }], commonWindow: ['2026-06', '2026-07', '2026-08'], lifecycleEvents: [], quality: { completeness: 'complete', issueCodes: [], exceptions: [], sourceCoverage: [] } }; }
beforeEach(() => vi.mocked(buildAllGrowthFlows).mockReturnValue(flows()));
it('projects raw110/220 then adjusts cancellation once to99/198 and converts group mix to49.5', () => { const r = buildGrowthForecast(evidence(), flows(), query, now); expect(r.months).toHaveLength(12); expect(r.months[0].bookedStudentHours.value).toBe(110); expect(r.months[11].bookedStudentHours.value).toBe(220); expect(r.months[0].creditStudentHours.value).toBe(99); expect(r.months[11].creditStudentHours.value).toBe(198); expect(r.months[0].creditTutorHours.value).toBe(49.5); });
it('keeps missing measured input unavailable until explicit override and resets to measured values', () => { const f = flows(); f.averages[0].churnStudentHours = growthUnknown('BASELINE_MISSING'); vi.mocked(buildAllGrowthFlows).mockReturnValue(f); const e = evidence(); expect(buildGrowthForecast(e, f, query, now).months[0].bookedStudentHours.value).toBeNull(); const q = { ...query, assumptions: { bufferPercent: 0, subjects: { [course.courseKey]: { churnStudentHours: 4 } } } }; const r = buildGrowthForecast(e, f, q, now); expect(r.months[0].bookedStudentHours.value).toBe(110); expect(r.inputs[0].churnStudentHours.source).toBe('override'); expect(r.inputs[0].churnStudentHours.measured.value).toBeNull(); expect(buildGrowthForecast(e, f, query, now).months[0].bookedStudentHours.value).toBeNull(); });
it('raises capacity above model for actual commitments and preserves full-pool allocation under filters', () => { const e = evidence(); booking(e, 'future', '2026-10-05', ['st'], 60); e.workforce.sessions[0].meetingStatus = 'UPCOMING'; const r = buildGrowthForecast(e, flows(), { ...query, filters: { ...query.filters, subject: 'Maths' } }, now); expect(r.months[0].knownCommittedTutorHours.value).toBe(60); expect(r.months[0].capacityRequiredTutorHours.value).toBeGreaterThanOrEqual(60); expect(buildAllGrowthFlows).toHaveBeenCalledWith(e, now); });
it('rejects overrides for unknown course keys', () => { expect(() => buildGrowthForecast(evidence(), flows(), { ...query, assumptions: { bufferPercent: 0, subjects: { unknown: { newStudentHours: 1 } } } }, now)).toThrowError(expect.objectContaining({ status: 422 })); });
it('does not reserve a future booking absent from the authoritative fresh snapshot', () => { const e = evidence(); booking(e, 'absent', '2026-10-05', ['st'], 60, 'Maths', { meetingStatus: 'UPCOMING', reasonCodes: ['absent_from_current_future_snapshot'] }); expect(buildGrowthForecast(e, flows(), query, now).months[0].knownCommittedTutorHours.value).toBe(0); });
it('keeps shared overall allocation unchanged when a competing course is hidden', () => {
    const e = evidence(), f = flows(), physics = growthCourse('Physics', 'International', 'Y10');
    f.averages.push({ ...f.averages[0], ...physics, newStudentHours: growthKnown(0), reactivatedStudentHours: growthKnown(0), churnStudentHours: growthKnown(0) });
    f.months.push({ ...f.months[0], ...physics, bookedStudentHours: growthKnown(100) });
    f.patterns.push({ ...f.patterns[0], ...physics });
    vi.mocked(buildAllGrowthFlows).mockReturnValue(f);
    e.workforce.observations = [{ id: 'o', canonicalKey: 'Tutor', observedAt: now.toISOString(), source: 'fixture', role: 'tutor', accounts: [], qualifications: [course, physics].map(c => ({ subject: c.subject, curriculum: c.curriculum, level: c.level, modality: 'onsite' })), offeredWindows: [{ weekday: 1, startMinute: 600, endMinute: 660, modality: 'onsite' }], leaves: [], availabilityCompleteness: 'complete', qualificationCompleteness: 'complete', completeness: 'complete', reasonCodes: [] }];
    const all = buildGrowthForecast(e, f, query, now), filtered = buildGrowthForecast(e, f, { ...query, filters: { ...query.filters, subject: 'Maths' } }, now);
    expect(filtered.allocations[0].additionalWeeklyHours).toEqual(all.allocations[0].additionalWeeklyHours);
    expect(filtered.months).toHaveLength(12);
    expect(filtered.allocations[0].cells.every(c => c.subject === 'Maths')).toBe(true);
    expect(all.allocations[0].additionalWeeklyHours.value).toBeGreaterThan(0);
});
it('keeps the current month calendar pattern intact late in the month and subtracts dated leave', () => {
    const late = new Date('2026-10-25T12:00:00+07:00'), e = evidence(), f = flows();
    vi.mocked(buildAllGrowthFlows).mockReturnValue(f);
    e.workforce.observations = [{ id: 'o', canonicalKey: 'Tutor', observedAt: late.toISOString(), source: 'fixture', role: 'tutor', accounts: [], qualifications: [{ subject: 'Maths', curriculum: 'International', level: 'Y10', modality: 'onsite' }], offeredWindows: [{ weekday: 1, startMinute: 600, endMinute: 660, modality: 'onsite' }], leaves: [{ startAt: '2026-10-26T10:00:00+07:00', endAt: '2026-10-26T11:00:00+07:00', status: 'approved' }], availabilityCompleteness: 'complete', qualificationCompleteness: 'complete', completeness: 'complete', reasonCodes: [] }];
    const r = buildGrowthForecast(e, f, query, late);
    expect(r.allocations[0].requiredHours.value).toBeCloseTo(49.5);
    expect(r.allocations[0].allocatedHours.value).toBe(3);
    expect(r.assumptions.some(s => s.includes('full calendar month'))).toBe(true);
});
it('needs no modeled pattern when dated commitments already exceed that months entire model', () => {
    const e = evidence(), f = flows();
    f.patterns = [];
    vi.mocked(buildAllGrowthFlows).mockReturnValue(f);
    booking(e, 'floor', '2026-10-05', ['s'], 60);
    e.workforce.sessions[0].meetingStatus = 'UPCOMING';
    const r = buildGrowthForecast(e, f, query, now);
    expect(r.months[0].capacityRequiredTutorHours.value).toBe(60);
    expect(r.allocations[0].reasonCodes).not.toContain('FORECAST_TIME_PATTERN_UNAVAILABLE');
});
