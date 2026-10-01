import { it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '@/lib/db';
vi.mock('../source-db', () => ({ loadWorkforceEvidence: vi.fn() }));
import { loadWorkforceEvidence } from '../source-db';
import { getWorkforceReport, getWorkforceDrilldown } from '../service';
import { evidence, query, now, addSession } from './calculation-fixtures';
beforeEach(() => { vi.mocked(loadWorkforceEvidence).mockResolvedValue(evidence()); });
it('keeps revision stable across response generation times and rejects stale drilldowns', async () => {
    const db = {} as Database;
    const a = await getWorkforceReport(db, query, now), b = await getWorkforceReport(db, query, now);
    expect(a.reportRevision).toBe(b.reportRevision);
    await expect(getWorkforceDrilldown(db, { ...query, kind: 'person', key: 'Aria', reportRevision: 'stale' }, now)).rejects.toMatchObject({ status: 409 });
});
it('resolves subject and week cell keys through the same report and contributor calculations', async () => {
    const e = evidence();
    addSession(e, '1', 10, 60);
    vi.mocked(loadWorkforceEvidence).mockResolvedValue(e);
    const db = {} as Database;
    const report = await getWorkforceReport(db, query, now);
    const subject = report.subjects.find(s => s.subject === 'Physics')!;
    const detail = await getWorkforceDrilldown(db, { ...query, kind: 'subject_cell', key: subject.key, reportRevision: report.reportRevision }, now);
    expect(detail.contributors.wiseSessionIds).toContain('1');
    const week = report.weekCells.find(c => c.weekday === 1 && c.startMinute === 600)!;
    const weekDetail = await getWorkforceDrilldown(db, { ...query, kind: 'subject_cell', key: week.key, reportRevision: report.reportRevision }, now);
    expect(weekDetail.contributors.wiseSessionIds).toContain('1');
});
it('includes other-subject commitments in a shared subject pool and bounds detail pages', async () => {
    const e = evidence();
    for (let i = 0; i < 3; i++)
        addSession(e, String(i), 10 + i, 60, 'Physics');
    vi.mocked(loadWorkforceEvidence).mockResolvedValue(e);
    const db = {} as Database;
    const report = await getWorkforceReport(db, { ...query, subject: 'Math' }, now);
    const subject = report.subjects.find(s => s.subject === 'Math')!;
    const detail = await getWorkforceDrilldown(db, { ...query, subject: 'Math', kind: 'subject_cell', key: subject.key, reportRevision: report.reportRevision, pageSize: 1 }, now);
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0].reasonCodes).toContain('OTHER_SUBJECT_COMMITMENT');
    expect(detail.nextCursor).toBe('1');
    expect(detail.contributors.wiseSessionIds).toEqual(['0']);
});
it('propagates loader failures and refuses unknown detail keys', async () => {
    const db = {} as Database;
    const report = await getWorkforceReport(db, query, now);
    await expect(getWorkforceDrilldown(db, { ...query, kind: 'subject_cell', key: 'not-a-cell', reportRevision: report.reportRevision }, now)).rejects.toMatchObject({ status: 404 });
    vi.mocked(loadWorkforceEvidence).mockRejectedValue(new Error('source failed'));
    await expect(getWorkforceReport(db, query, now)).rejects.toThrow('source failed');
});
