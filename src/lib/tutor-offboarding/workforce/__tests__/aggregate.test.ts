import { it, expect } from 'vitest';
import { buildWorkforceReport } from '../aggregate';
import { evidence, query, now, addSession } from './calculation-fixtures';
it('computes50 percent using6 usable hours after2 leave hours and3 consumed hours', () => {
    const e = evidence();
    addSession(e, '1', 10, 60);
    addSession(e, '2', 13, 120);
    const report = buildWorkforceReport(e, query, now);
    expect(report.totals.offeredHours.value).toBe(8);
    expect(report.totals.usableHours.value).toBe(6);
    expect(report.totals.creditConsumedHours.value).toBe(3);
    expect(report.totals.consumedUtilizationPercent.value).toBe(50);
});
it('allows125 percent including outside-hours work and flags overlapping bookings', () => {
    const e = evidence();
    e.observations.forEach(o => o.leaves = []);
    addSession(e, '1', 7, 600);
    addSession(e, 'overlap', 10, 60, 'Math', 0);
    const report = buildWorkforceReport(e, query, now);
    expect(report.totals.consumedUtilizationPercent.value).toBe(125);
    expect(report.totals.outsideHours.value).toBeGreaterThan(0);
    expect(report.totals.overlapHours.value).toBe(1);
});
it('retains full-history demand while unknown availability makes utilization unavailable', () => {
    const e = evidence();
    e.observations = [];
    addSession(e, '1', 10, 60);
    const report = buildWorkforceReport(e, query, now);
    expect(report.totals.bookedHours.value).toBe(1);
    expect(report.totals.usableHours.value).toBeNull();
    expect(report.totals.consumedUtilizationPercent.value).toBeNull();
});
it('dedupes linked tutor and student session rows, and keeps charged cancellations in demand only', () => {
    const e = evidence();
    const classRow = addSession(e, '1', 10, 60);
    classRow.canonicalTutorKeys = ['Aria', 'Aria'];
    e.sessions.push({ ...classRow });
    const cancelled = addSession(e, '2', 12, 60);
    cancelled.meetingStatus = 'CANCELLED';
    const report = buildWorkforceReport(e, query, now);
    expect(report.totals.distinctClasses.value).toBe(2);
    expect(report.totals.studentBookings.value).toBe(2);
    expect(report.totals.creditConsumedHours.value).toBe(2);
    expect(report.totals.recordedTeachingHours.value).toBe(1);
    expect(report.totals.reservedHours.value).toBe(1);
});
it('keeps unknown credit-class hours partial and makes selected subject pool shared rather than additive', () => {
    const e = evidence();
    e.observations.forEach(o => o.leaves = []);
    addSession(e, '1', 10, 60);
    addSession(e, '2', 13, 60);
    e.studentCredits = e.studentCredits.filter(c => c.wiseSessionId !== '2');
    const report = buildWorkforceReport(e, { ...query, subject: 'Math' }, now);
    expect(report.totals.freeHours.value).toBe(6);
    expect(report.totals.creditConsumedHours.value).toBe(0);
    expect(report.subjects.some(s => s.subject === 'Math')).toBe(true);
});
it('counts five students as five bookings, one class and one consumed tutor hour', () => {
    const e = evidence();
    const s = addSession(e, 'group', 10, 60);
    s.historicalBookedStudentIds = ['a', 'b', 'c', 'd', 'e'];
    e.studentCredits = s.historicalBookedStudentIds.map(wiseStudentId => ({ ...e.studentCredits[0], wiseStudentId }));
    const r = buildWorkforceReport(e, query, now);
    expect(r.totals.studentBookings.value).toBe(5);
    expect(r.totals.uniqueStudents.value).toBe(5);
    expect(r.totals.distinctClasses.value).toBe(1);
    expect(r.totals.creditConsumedHours.value).toBe(1);
});
it('clips consumed and reserved numerators to the same observation mask while retaining full demand', () => {
    const e = evidence();
    e.observations = e.observations.filter(o => o.observedAt.includes('T03:'));
    addSession(e, 'half', 10, 120);
    addSession(e, 'outside-support', 13, 60);
    const r = buildWorkforceReport(e, query, now);
    expect(r.totals.creditConsumedHours.value).toBe(3);
    expect(r.totals.utilizationCreditConsumedHours.value).toBe(1.5);
    expect(r.totals.usableHours.value).toBe(1.5);
    expect(r.totals.consumedUtilizationPercent.value).toBe(100);
});
it('reports different tutor assignments as partial, counts demand once and blocks both possible people', () => {
    const e = evidence();
    e.people.push({ ...e.people[0], canonicalKey: 'Bea', displayName: 'Bea' });
    e.observations.push(...e.observations.map(o => ({ ...o, id: 'b' + o.id, canonicalKey: 'Bea' })));
    const s = addSession(e, '1', 10, 60);
    e.sessions.push({ ...s, canonicalTutorKeys: ['Bea'] });
    const r = buildWorkforceReport(e, query, now);
    expect(r.totals.distinctClasses.value).toBe(1);
    expect(r.totals.consumedUtilizationPercent.value).toBeNull();
    expect(r.totals.freeHours.value).toBe(10);
    expect(r.quality.issueCodes).toContain('CONFLICTING_TUTOR_ASSIGNMENT');
});
it('keeps average Monday hours identical for four and five covered Mondays', () => {
    function monthReport(month: string, days: number) { const e = evidence(); const monthStart = Date.parse(month + '-01T00:00:00+07:00'); e.observations = Array.from({ length: days * 24 }, (_, i) => ({ ...e.observations[i % 24], id: 'm' + i, observedAt: new Date(monthStart + i * 3600000).toISOString(), leaves: [] })); e.sourceCoverage[0] = { ...e.sourceCoverage[0], requestedFrom: month + '-01', requestedTo: month + '-' + String(days) }; return buildWorkforceReport(e, { ...query, from: month + '-01', to: month + '-' + String(days), viewMonth: month }, new Date(monthStart + days * 86400000)); }
    const march = monthReport('2026-03', 31), april = monthReport('2026-04', 30);
    const a = march.weekCells.find(c => c.weekday === 1 && c.startMinute === 600)!, b = april.weekCells.find(c => c.weekday === 1 && c.startMinute === 600)!;
    expect(a.coveredDates).toBe(5);
    expect(b.coveredDates).toBe(4);
    expect(a.offeredHours.value).toBe(.5);
    expect(b.offeredHours.value).toBe(.5);
    expect(a.monthlyTotals.offeredHours?.value).toBe(2.5);
});
it('preserves teaching administrators but excludes administrators without teaching evidence', () => {
    const e = evidence();
    e.people.push({ ...e.people[0], canonicalKey: 'Admin', role: null, accounts: [{ wiseTeacherId: 'admin', wiseUserId: 'admin', joinedAt: null, relation: 'ADMIN', modality: null }] });
    e.people[0].role = 'teaching_admin';
    addSession(e, '1', 10, 60);
    const r = buildWorkforceReport(e, query, now);
    expect(r.people).toHaveLength(1);
    expect(r.people[0].role).toBe('teaching_admin');
    expect(r.quality.issueCodes).toContain('ROLE_UNCONFIRMED');
});
it('does not turn an unmapped academic class into proven zero supply', () => {
    const e = evidence();
    const s = addSession(e, '1', 10, 60);
    s.subject = null;
    s.classTitle = 'Y2-8 / G1-7 (Int.)';
    const r = buildWorkforceReport(e, query, now);
    const unmapped = r.subjects.find(s => s.subject === 'Unmapped')!;
    expect(unmapped.bookedHours.value).toBe(1);
    expect(unmapped.usableHours.value).toBeNull();
    expect(unmapped.qualifiedPeople.value).toBeNull();
});
it('counts a class by Bangkok scheduled date without splitting month demand into a second month', () => {
    const e = evidence();
    addSession(e, '1', 23, 120);
    const r = buildWorkforceReport(e, { ...query, to: '2026-03-03' }, new Date('2026-03-04T00:00:00+07:00'));
    expect(r.totals.bookedHours.value).toBe(2);
    expect(r.totals.studentBookings.value).toBe(1);
    const next = buildWorkforceReport(e, { ...query, from: '2026-03-03', to: '2026-03-03' }, new Date('2026-03-04T00:00:00+07:00'));
    expect(next.totals.distinctClasses.value).toBe(0);
});
it('averages recurring unique students per covered weekday occurrence rather than dividing monthly distinct people', () => {
    const e = evidence();
    const nextMonday = 7 * 86400000;
    e.observations.push(...e.observations.map(o => ({ ...o, id: 'second' + o.id, observedAt: new Date(Date.parse(o.observedAt) + nextMonday).toISOString() })));
    const a = addSession(e, '1', 10, 60), b = addSession(e, '2', 10, 60);
    b.startAt = new Date(Date.parse(a.startAt) + nextMonday).toISOString();
    b.endAt = new Date(Date.parse(a.endAt!) + nextMonday).toISOString();
    b.historicalBookedStudentIds = a.historicalBookedStudentIds;
    e.studentCredits[1].wiseStudentId = e.studentCredits[0].wiseStudentId;
    const r = buildWorkforceReport(e, { ...query, to: '2026-03-09' }, new Date('2026-03-10T00:00:00+07:00'));
    expect(r.weekCells.find(c => c.weekday === 1 && c.startMinute === 600)!.uniqueStudents.value).toBe(1);
});
it('retains a curriculum filter on broad subject parents', () => {
    const e = evidence();
    e.observations.forEach(o => o.qualifications.push({ subject: 'Math', curriculum: 'Thai', level: 'G1-9', modality: 'onsite' }));
    const s = addSession(e, 'thai', 10, 60, 'Math');
    s.curriculum = 'Thai';
    const r = buildWorkforceReport(e, { ...query, curriculum: 'International' }, now);
    expect(r.subjects.find(s => s.subject === 'Math' && s.depth === 0)!.bookedHours.value).toBe(0);
});
it('retains undurationed class counts while hours and shared free time remain unknown', () => {
    const e = evidence();
    const s = addSession(e, 'missing-duration', 10, 60);
    s.endAt = null;
    s.scheduledMinutes = null;
    const r = buildWorkforceReport(e, query, now);
    expect(r.totals.distinctClasses.value).toBe(1);
    expect(r.totals.bookedHours.value).toBeNull();
    expect(r.totals.freeHours.value).toBeNull();
});
it('keeps incomplete empty retrieval unknown rather than claiming zero demand', () => {
    const e = evidence();
    e.sourceCoverage = [];
    const r = buildWorkforceReport(e, query, now);
    expect(r.totals.distinctClasses.value).toBeNull();
    expect(r.totals.bookedHours.value).toBeNull();
    expect(r.totals.creditConsumedHours.value).toBeNull();
});
