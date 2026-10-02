import { describe, expect, it } from 'vitest';
import { workforceContentHash, observationCoverageEnd } from '../observations';
describe('workforce observation normalization', () => {
    it('hashes equivalent object keys identically without discarding null or source semantics', () => {
        expect(workforceContentHash({ b: 2, a: { y: null, x: 1 } })).toBe(workforceContentHash({ a: { x: 1, y: null }, b: 2 }));
        expect(workforceContentHash({ credits: null })).not.toBe(workforceContentHash({ credits: 0 }));
    });
    it('closes observed history after 90 minutes and never projects across an outage', () => {
        expect(observationCoverageEnd('2026-10-01T03:00:00Z', null, null)).toBe('2026-10-01T04:30:00.000Z');
        expect(observationCoverageEnd('2026-10-01T03:00:00Z', '2026-10-01T03:30:00Z', null)).toBe('2026-10-01T03:30:00.000Z');
        expect(observationCoverageEnd('2026-10-01T03:00:00Z', null, '2026-10-01T03:10:00Z')).toBe('2026-10-01T03:10:00.000Z');
    });
    it('rejects invalid observation times and reversed boundaries', () => {
        expect(() => observationCoverageEnd('invalid', null, null)).toThrow();
        expect(() => observationCoverageEnd('2026-10-01T03:00:00Z', '2026-10-01T02:00:00Z', null)).toThrow();
    });
});
import { buildSnapshotWorkforceObservation } from '../observations';
it('captures linked accounts as one person while a failed variant makes capacity unknown and preserves qualifications', () => {
    const people = buildSnapshotWorkforceObservation({ sourceKey: 'sync:x', snapshotId: 'x', observedAt: '2026-10-01T03:00:00Z', teachers: [{ _id: 't1', userId: 'u1', name: 'Aria', relation: 'TEACHER', joinedOn: '2026-01-01', tags: ['Maths International G1-9'] }, { _id: 't2', userId: 'u2', name: 'Aria Online', relation: 'TEACHER', joinedOn: '2026-02-01', tags: [] }], groups: [{ canonicalKey: 'Aria', displayName: 'Aria', members: [{ wiseTeacherId: 't1', wiseUserId: 'u1', wiseDisplayName: 'Aria', isOnlineVariant: false }, { wiseTeacherId: 't2', wiseUserId: 'u2', wiseDisplayName: 'Aria Online', isOnlineVariant: true }] }], modalities: new Map([['t1', 'onsite'], ['t2', 'online']]), availability: new Map([['t1', { observedAt: '2026-10-01T03:05:00Z', workingHours: [{ day: 4, startTime: '10:00', endTime: '12:00' }], leaves: [], complete: true, nearLeavesAt: '2026-10-01T03:05:00Z', farLeavesAt: '2026-10-01T01:00:00Z' }]]) });
    expect(people.people).toHaveLength(1);
    expect(people.people[0].person.accounts).toHaveLength(2);
    expect(people.people[0].person.joinedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(people.people[0].observation.availabilityCompleteness).toBe('unknown');
    expect(people.people[0].observation.reasonCodes).toContain('availability_fetch_failed');
    expect(people.people[0].observation.sourceTimes?.farLeaves).toBe('2026-10-01T01:00:00Z');
});
it('treats an explicit empty schedule as known zero but does not classify a nonteaching ADMIN as a teaching admin', () => {
    const result = buildSnapshotWorkforceObservation({ sourceKey: 'zero', snapshotId: 'x', observedAt: '2026-10-01T03:00:00Z', teachers: [{ _id: 'a', userId: 'ua', name: 'Office', relation: 'ADMIN', tags: [] }], groups: [{ canonicalKey: 'Office', displayName: 'Office', members: [{ wiseTeacherId: 'a', wiseUserId: 'ua', wiseDisplayName: 'Office', isOnlineVariant: false }] }], modalities: new Map(), availability: new Map([['a', { observedAt: '2026-10-01T03:00:00Z', workingHours: [], leaves: [], complete: true, nearLeavesAt: '2026-10-01T03:00:00Z', farLeavesAt: '2026-10-01T03:00:00Z' }]]) });
    expect(result.people[0].person.role).toBeNull();
    expect(result.people[0].observation.availabilityCompleteness).toBe('complete');
    expect(result.people[0].observation.offeredWindows).toEqual([]);
});
it('retains exact valid qualifications alongside unmapped tags as partial evidence',()=>{
 const result=buildSnapshotWorkforceObservation({sourceKey:'mixed',snapshotId:'x',observedAt:'2026-10-01T03:00:00Z',teachers:[{_id:'a',userId:'ua',name:'Teacher',relation:'TEACHER',tags:['Math (Int.) Y2-8','Unmapped label']}],groups:[{canonicalKey:'Teacher',displayName:'Teacher',members:[{wiseTeacherId:'a',wiseUserId:'ua',wiseDisplayName:'Teacher',isOnlineVariant:false}]}],modalities:new Map([['a','onsite']]),availability:new Map([['a',{observedAt:'2026-10-01T03:00:00Z',workingHours:[],leaves:[],complete:true,nearLeavesAt:null,farLeavesAt:null}]])});
 expect(result.people[0].observation.qualifications[0].subject).toBe('Math');expect(result.people[0].observation.qualificationCompleteness).toBe('partial');expect(result.people[0].observation.availabilityCompleteness).toBe('complete');
});
