import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { startTestDb, stopTestDb, truncateAll } from '@/tests/integration/db-helper';
import type { Database } from '@/lib/db';
import * as s from '@/lib/db/schema';
import { persistWorkforceSourceWindow } from '../observation-store';
import { loadWorkforceEvidence } from '../source-db';
import { query, window } from './fixtures';
let h: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => { h = await startTestDb(); }, 60000);
afterAll(async () => { if (h)
    await stopTestDb(h); });
beforeEach(async () => { await truncateAll(h.db); });
const db = () => h.db as unknown as Database;
it('versions corrections and refunds while an incomplete window neither replaces facts nor advances coverage', async () => {
    await persistWorkforceSourceWindow(db(), window());
    await persistWorkforceSourceWindow(db(), window('same', '2026-10-01T03:30:00Z'));
    expect(await h.db.select().from(s.workforceSessionVersions)).toHaveLength(1);
    expect(await h.db.select().from(s.workforceCreditVersions)).toHaveLength(1);
    await persistWorkforceSourceWindow(db(), window('bad', '2026-10-01T04:00:00Z', 0, false));
    let evidence = await loadWorkforceEvidence(db(), query, new Date('2026-10-01T05:00:00Z'));
    expect(evidence.studentCredits[0].netCredits).toBe(1);
    expect(evidence.sourceCoverage.filter(r => r.completeness === 'complete')).toHaveLength(2);
    expect(evidence.sourceCoverage.some(r => r.truncated)).toBe(true);
    await persistWorkforceSourceWindow(db(), window('refund', '2026-10-01T04:30:00Z', 0));
    evidence = await loadWorkforceEvidence(db(), query, new Date('2026-10-01T05:00:00Z'));
    expect(evidence.studentCredits[0].netCredits).toBe(0);
    expect(await h.db.select().from(s.workforceCreditVersions)).toHaveLength(2);
});
it('replaying a source window is idempotent', async () => {
    await persistWorkforceSourceWindow(db(), window());
    await persistWorkforceSourceWindow(db(), window());
    expect(await h.db.select().from(s.workforceCaptureRuns)).toHaveLength(1);
});
it('upgrades a failed source key on complete retry and preserves unknown historical normal charges', async () => {
    await persistWorkforceSourceWindow(db(), window('retry', '2026-10-01T03:00:00Z', 1, false));
    const complete = window('retry');
    complete.credits[0].normalCredits = null;
    complete.credits[0].evidenceStatus = 'unknown';
    complete.contractIssues = ['historical_normal_charge_unknown'];
    await persistWorkforceSourceWindow(db(), complete);
    const evidence = await loadWorkforceEvidence(db(), query, new Date('2026-10-01T05:00:00Z'));
    expect(evidence.sessions).toHaveLength(1);
    expect(evidence.studentCredits[0].normalCredits).toBeNull();
    expect(evidence.sourceCoverage.find(r => r.source === 'wise_history')?.completeness).toBe('complete');
});
it('retains all future departure context for an old report month and requires evidence to classify teaching admins', async () => {
 const [snapshot]=await h.db.insert(s.snapshots).values({active:true,createdAt:new Date('2026-10-01T03:00:00Z')}).returning();
 await h.db.insert(s.tutorWiseAccounts).values(['Aria','Office'].map((key,i)=>({wiseTeacherId:'admin'+i,wiseUserId:'adminuser'+i,canonicalKey:key,displayName:key,isOnlineVariant:false,status:'active',wiseRelation:'ADMIN',lastSnapshotId:snapshot.id,wiseJoinedOn:new Date('2026-02-01T00:00:00Z')})));
 const [group]=await h.db.insert(s.tutorIdentityGroups).values({snapshotId:snapshot.id,canonicalKey:'Aria',displayName:'Aria'}).returning();
 await h.db.insert(s.futureSessionBlocks).values({snapshotId:snapshot.id,groupId:group.id,wiseTeacherId:'admin0',wiseSessionId:'future2028',startTime:new Date('2028-01-01T03:00:00Z'),endTime:new Date('2028-01-01T04:00:00Z'),weekday:6,startMinute:600,endMinute:660,wiseStatus:'UPCOMING',studentIds:['st1']});
 const evidence=await loadWorkforceEvidence(db(),{...query,to:'2026-03-31',viewMonth:'2026-03'},new Date('2026-10-01T03:30:00Z'));
 expect(evidence.sessions.some(f=>f.wiseSessionId==='future2028')).toBe(true);
 expect(evidence.people.find(p=>p.canonicalKey==='Aria')?.role).toBe('teaching_admin');
 expect(evidence.people.find(p=>p.canonicalKey==='Office')?.role).toBeNull();
 expect(evidence.sourceCoverage.find(c=>c.source==='wise_future_snapshot')?.completeness).toBe('complete');
});
it('keeps historical future-booking facts while a fresh snapshot marks their absence for departure context',async()=>{
 const archived=window();archived.sessions[0].startAt='2026-12-01T03:00:00Z';archived.sessions[0].endAt='2026-12-01T04:00:00Z';archived.sessions[0].meetingStatus='UPCOMING';
 await persistWorkforceSourceWindow(db(),archived);
 await h.db.insert(s.snapshots).values({active:true,createdAt:new Date('2026-10-01T03:00:00Z')});
 const evidence=await loadWorkforceEvidence(db(),query,new Date('2026-10-01T03:30:00Z'));
 expect(evidence.sessions[0].meetingStatus).toBe('UPCOMING');expect(evidence.sessions[0].reasonCodes).toContain('absent_from_current_future_snapshot');
});
