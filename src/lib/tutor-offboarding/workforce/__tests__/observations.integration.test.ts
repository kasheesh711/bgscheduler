import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestDb, stopTestDb, truncateAll } from '@/tests/integration/db-helper';
import type { Database } from '@/lib/db';
import * as s from '@/lib/db/schema';
import { captureWorkforceObservation } from '../observation-store';
import { loadWorkforceEvidence } from '../source-db';
import { capture, query } from './fixtures';
let h: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => { h = await startTestDb(); }, 60000);
afterAll(async () => { if (h)
    await stopTestDb(h); });
beforeEach(async () => { await truncateAll(h.db); });
const db = () => h.db as unknown as Database;
describe('durable workforce observations', () => {
    it('dedupes replay and unchanged payloads but retains genuine A B A changes', async () => {
        await captureWorkforceObservation(db(), capture());
        await captureWorkforceObservation(db(), capture());
        await captureWorkforceObservation(db(), capture('b', '2026-10-01T03:30:00Z'));
        expect(await h.db.select().from(s.workforcePersonVersions)).toHaveLength(1);
        expect(await h.db.select().from(s.workforcePersonObservations)).toHaveLength(2);
        await captureWorkforceObservation(db(), capture('c', '2026-10-01T04:00:00Z', 720));
        await captureWorkforceObservation(db(), capture('d', '2026-10-01T04:30:00Z'));
        expect(await h.db.select().from(s.workforcePersonVersions)).toHaveLength(3);
    });
    it('keeps complete payload when a teacher fetch fails and records the original failure boundary', async () => {
        await captureWorkforceObservation(db(), capture());
        await captureWorkforceObservation(db(), capture('fail', '2026-10-01T03:30:00Z', 0, false));
        const evidence = await loadWorkforceEvidence(db(), query, new Date('2026-10-01T05:00:00Z'));
        expect(evidence.observations).toHaveLength(2);
        expect(evidence.observations[0].qualifications[0].subject).toBe('Maths');
        expect(evidence.observations[1].availabilityCompleteness).toBe('unknown');
        expect(evidence.observations[1].observedAt).toBe('2026-10-01T03:30:00.000Z');
        expect(await h.db.select().from(s.workforcePersonVersions)).toHaveLength(1);
    });
    it('survives deletion of its source snapshot and keeps older readers usable', async () => {
        const [snap] = await h.db.insert(s.snapshots).values({ active: true }).returning();
        const input = capture();
        input.snapshotId = snap.id;
        await captureWorkforceObservation(db(), input);
        await h.db.execute(sql `delete from snapshots where id=${snap.id}`);
        expect(await h.db.select().from(s.workforcePersonVersions)).toHaveLength(1);
        expect(await h.db.select().from(s.workforceCaptureRuns)).toHaveLength(1);
    });
});
it('retries a partial capture with the same source key and preserves known availability despite unknown qualifications', async () => {
    const input = capture('partial');
    input.people[0].observation.qualificationCompleteness = 'unknown';
    input.people[0].observation.qualifications = [];
    input.people[0].observation.completeness = 'partial';
    await captureWorkforceObservation(db(), input);
    let evidence = await loadWorkforceEvidence(db(), query, new Date('2026-10-01T05:00:00Z'));
    expect(evidence.people).toHaveLength(1);
    expect(evidence.observations[0].offeredWindows).toHaveLength(1);
    expect(evidence.observations[0].qualificationCompleteness).toBe('unknown');
    await captureWorkforceObservation(db(), capture('partial'));
    evidence = await loadWorkforceEvidence(db(), query, new Date('2026-10-01T05:00:00Z'));
    expect(evidence.observations).toHaveLength(1);
    expect(evidence.observations[0].qualificationCompleteness).toBe('complete');
});
it('loads by original source time when an older baseline is imported later', async () => {
    await captureWorkforceObservation(db(), capture('new', '2026-10-01T04:00:00Z', 720));
    await captureWorkforceObservation(db(), capture('baseline', '2026-10-01T03:00:00Z'));
    const evidence = await loadWorkforceEvidence(db(), query, new Date('2026-10-01T05:00:00Z'));
    expect(evidence.observations.map(o => o.offeredWindows[0].endMinute)).toEqual([660, 720]);
    expect(evidence.people[0].lastObservedAt).toBe('2026-10-01T04:00:00.000Z');
});
