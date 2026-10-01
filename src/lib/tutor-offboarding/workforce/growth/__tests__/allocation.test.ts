import { it, expect } from 'vitest';
import { allocateGrowthCapacity } from '../allocation';
import { growthCourse } from '../lifecycle';
import type { GrowthAllocationInput } from '../types';
const math = growthCourse('Math', 'International', 'G1-9'), physics = growthCourse('Physics', 'International', 'G1-9');
const at = (hour: number) => new Date(Date.parse('2026-10-05T00:00:00+07:00') + hour * 3600000).toISOString();
function input(): GrowthAllocationInput { return { month: '2026-10', supply: [{ canonicalKey: 'A', startAt: at(8), endAt: at(16), courseKeys: [math.courseKey, physics.courseKey] }], demand: [], commitments: [], completeness: 'complete', reasonCodes: [], bufferPercent: 0, observedAt: ['2026-10-01T00:00:00Z'] }; }
it('allocates one shared eight-hour tutor pool once against simultaneous course demand', () => { const i = input(); i.demand = [{ ...math, startAt: at(8), endAt: at(16), hours: 8 }, { ...physics, startAt: at(8), endAt: at(16), hours: 8 }]; const r = allocateGrowthCapacity(i); expect(r.requiredHours.value).toBe(16); expect(r.allocatedHours.value).toBe(8); expect(r.cells.reduce((s, c) => s + (c.requiredHours.value! - c.allocatedHours.value!), 0)).toBe(8); });
it('allocates nonoverlapping slots and deduplicates linked account supply', () => { const i = input(); i.supply.push({ ...i.supply[0] }); i.demand = [{ ...math, startAt: at(8), endAt: at(12), hours: 4 }, { ...physics, startAt: at(12), endAt: at(16), hours: 4 }]; const r = allocateGrowthCapacity(i); expect(r.allocatedHours.value).toBe(8); expect(r.additionalWeeklyHours.value).toBe(0); });
it('reserves assigned commitments first and does not add them twice on top of modeled demand', () => { const i = input(); i.supply[0].endAt = at(9); i.demand = [{ ...math, startAt: at(8), endAt: at(9), hours: 1 }, { ...physics, startAt: at(8), endAt: at(9), hours: 1 }]; i.commitments = [{ wiseSessionId: 'p', canonicalKey: 'A', subject: 'Physics', courseKey: physics.courseKey, startAt: at(8), endAt: at(9) }]; const r = allocateGrowthCapacity(i); expect(r.requiredHours.value).toBe(2); expect(r.allocatedHours.value).toBe(1); expect(r.cells.find(c => c.subject === 'Physics')!.allocatedHours.value).toBe(.5); expect(r.cells.filter(c => c.subject === 'Math').every(c => c.allocatedHours.value === 0)).toBe(true); });
it('uses dated commitment floor when twelve booked hours exceed model ten', () => { const i = input(); i.demand = [{ ...math, startAt: at(8), endAt: at(20), hours: 10 }]; i.commitments = [{ wiseSessionId: 'm', canonicalKey: 'A', subject: 'Math', courseKey: math.courseKey, startAt: at(8), endAt: at(20) }]; expect(allocateGrowthCapacity(i).requiredHours.value).toBe(12); });
it('handles quarter-hour intersections and buffer as extra availability above minimum', () => { const i = input(); i.supply = []; i.demand = [{ ...math, startAt: at(10.25), endAt: at(10.5), hours: 8 }]; i.bufferPercent = 20; const r = allocateGrowthCapacity(i); expect(r.additionalWeeklyHours.value).toBe(2); expect(r.bufferedAdditionalWeeklyHours.value).toBe(2.4); expect(r.cells[0].startMinute).toBe(615); expect(r.cells[0].endMinute).toBe(630); });
it('normalizes five Mondays by five occurrences and keeps unknown supply gaps unavailable', () => { const i = input(); i.month = '2026-03'; i.supply = []; i.demand = Array.from({ length: 5 }, (_, k) => ({ ...math, startAt: new Date(Date.parse('2026-03-02T10:00:00+07:00') + k * 7 * 86400000).toISOString(), endAt: new Date(Date.parse('2026-03-02T11:00:00+07:00') + k * 7 * 86400000).toISOString(), hours: 1 })); expect(allocateGrowthCapacity(i).additionalWeeklyHours.value).toBe(1); i.completeness = 'unknown'; expect(allocateGrowthCapacity(i).additionalWeeklyHours.value).toBeNull(); });
it('uses augmenting paths rather than a greedy subject ordering', () => { const i = input(); i.supply = [{ canonicalKey: 'Flexible', startAt: at(8), endAt: at(9), courseKeys: [math.courseKey, physics.courseKey] }, { canonicalKey: 'MathOnly', startAt: at(8), endAt: at(9), courseKeys: [math.courseKey] }]; i.demand = [{ ...math, startAt: at(8), endAt: at(9), hours: 1 }, { ...physics, startAt: at(8), endAt: at(9), hours: 1 }]; expect(allocateGrowthCapacity(i).additionalWeeklyHours.value).toBe(0); });
it('preserves actual unknown-subject commitments and deterministic attribution', () => {
    const i = input();
    i.supply[0].endAt = at(9);
    i.demand = [{ ...math, startAt: at(8), endAt: at(9), hours: 1 }];
    i.commitments = [{ wiseSessionId: 'unknown', canonicalKey: 'A', subject: null, courseKey: null, startAt: at(8), endAt: at(9) }];
    const a = allocateGrowthCapacity(i), b = allocateGrowthCapacity({ ...i, supply: [...i.supply].reverse(), demand: [...i.demand].reverse() });
    expect(a).toEqual(b);
    expect(a.allocatedHours.value).toBe(1);
    expect(a.cells[0].allocatedHours.value).toBe(0);
    expect(a.additionalWeeklyHours.completeness).toBe('partial');
    expect(a.reasonCodes).toContain('UNMAPPED_BOOKING_COMMITMENT');
});
it('counts unmapped actual commitments in the institution-wide requirement even without model demand', () => {
    const i = input();
    i.supply[0].endAt = at(9);
    i.commitments = [{ wiseSessionId: 'unmapped', canonicalKey: 'A', subject: null, courseKey: null, startAt: at(8), endAt: at(9) }];
    const r = allocateGrowthCapacity(i);
    expect(r.requiredHours.value).toBe(1);
    expect(r.allocatedHours.value).toBe(1);
    expect(r.cells).toHaveLength(0);
    expect(r.additionalWeeklyHours.completeness).toBe('partial');
});
it('distributes only residual monthly model demand when fixed bookings occupy a different weekday', () => {
    const i = input();
    i.demand = [{ ...math, startAt: at(8), endAt: at(18), hours: 10 }];
    i.commitments = [{ wiseSessionId: 'tuesday', canonicalKey: 'A', subject: 'Math', courseKey: math.courseKey, startAt: new Date(Date.parse(at(8)) + 86400000).toISOString(), endAt: new Date(Date.parse(at(13)) + 86400000).toISOString() }];
    expect(allocateGrowthCapacity(i).requiredHours.value).toBe(10);
});
