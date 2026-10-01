import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import type { SourceWindowResult } from "./types";
import { personPayload, workforceContentHash, type CaptureResult, type WorkforceObservationInput } from "./observations";
function date(value: string): Date {
    const result = new Date(value);
    if (!Number.isFinite(result.getTime()))
        throw new Error("Invalid workforce source time");
    return result;
}
async function captureRun(db: Database, input: {
    sourceKey: string;
    kind: string;
    observedAt: string;
    complete: boolean;
    coverage: Record<string, unknown>;
    sourceSnapshotId?: string;
}) {
    if (!input.sourceKey.trim())
        throw new Error("Missing workforce source key");
    const [existing] = await db.select().from(s.workforceCaptureRuns).where(eq(s.workforceCaptureRuns.sourceKey, input.sourceKey)).limit(1);
    if (existing) {
        if (existing.kind !== input.kind || existing.observedAt.getTime() !== date(input.observedAt).getTime())
            throw new Error("Workforce source key reused for another observation");
        if (existing.complete || !input.complete)
            return { run: existing, replay: true };
        await db.delete(s.workforcePersonObservations).where(eq(s.workforcePersonObservations.runId, existing.id));
        const [run] = await db.update(s.workforceCaptureRuns).set({ complete: true, coverage: input.coverage }).where(eq(s.workforceCaptureRuns.id, existing.id)).returning();
        return { run, replay: false };
    }
    const [run] = await db.insert(s.workforceCaptureRuns).values({ ...input, observedAt: date(input.observedAt) }).returning();
    return { run, replay: false };
}
export async function captureWorkforceObservation(db: Database, input: WorkforceObservationInput): Promise<CaptureResult> {
    if (new Set(input.people.map(p => p.person.canonicalKey)).size !== input.people.length)
        throw new Error("Duplicate workforce person observation");
    return withDatabaseTransaction(db, async (tx) => {
        await tx.execute(sql `select pg_advisory_xact_lock(hashtext('workforce-history-capture'))`);
        const complete = input.people.every(p => p.observation.completeness === 'complete');
        const { run, replay } = await captureRun(tx, { sourceKey: input.sourceKey, kind: 'roster', observedAt: input.observedAt, complete, sourceSnapshotId: input.snapshotId, coverage: { people: input.people.length } });
        if (replay)
            return { runId: run.id, versionsAdded: 0, observationsAdded: 0, complete: run.complete };
        let versionsAdded = 0;
        for (const item of input.people) {
            if (item.observation.canonicalKey !== item.person.canonicalKey)
                throw new Error('Mismatched workforce identity');
            const observedAt = date(item.observation.observedAt);
            const [previous] = await tx.select().from(s.workforcePersonVersions).where(and(eq(s.workforcePersonVersions.canonicalKey, item.person.canonicalKey), lte(s.workforcePersonVersions.observedAt, observedAt))).orderBy(desc(s.workforcePersonVersions.observedAt), desc(s.workforcePersonVersions.versionOrder)).limit(1);
            let versionId = previous?.id ?? null;
            if (item.observation.availabilityCompleteness === 'complete' || item.observation.qualificationCompleteness !== 'unknown' || !previous) {
                const payload = personPayload(item), contentHash = workforceContentHash(payload);
                if (previous?.contentHash !== contentHash) {
                    const [version] = await tx.insert(s.workforcePersonVersions).values({ canonicalKey: item.person.canonicalKey, observedAt, contentHash, payload }).returning();
                    versionId = version.id;
                    versionsAdded++;
                }
            }
            const quality = Object.fromEntries(Object.entries(item.observation).filter(([key]) => !["id", "accounts", "qualifications", "offeredWindows", "leaves"].includes(key)));
            await tx.insert(s.workforcePersonObservations).values({ runId: run.id, canonicalKey: item.person.canonicalKey, versionId, observedAt, quality });
        }
        return { runId: run.id, versionsAdded, observationsAdded: input.people.length, complete };
    });
}
/** Retrieval-complete windows can contain unknown financial fields. Partial retrieval never replaces facts. */
export async function persistWorkforceSourceWindow(db: Database, window: SourceWindowResult): Promise<CaptureResult> {
    return withDatabaseTransaction(db, async (tx) => {
        await tx.execute(sql `select pg_advisory_xact_lock(hashtext('workforce-history-capture'))`);
        const complete = window.complete && window.completeness === 'complete' && !window.truncated;
        const coverage = { source: 'wise_history', requestedFrom: window.requestedWindow.from, requestedTo: window.requestedWindow.to, returnedFrom: window.returnedWindow.from, returnedTo: window.returnedWindow.to, observedAt: window.observedAt, ...window.paging, truncated: window.truncated, completeness: complete ? 'complete' : window.completeness === 'complete' ? 'partial' : window.completeness, issueCodes: window.contractIssues };
        const { run, replay } = await captureRun(tx, { sourceKey: window.sourceKey, kind: 'history', observedAt: window.observedAt, complete, coverage });
        if (replay || !complete)
            return { runId: run.id, versionsAdded: 0, observationsAdded: 0, complete: run.complete };
        const observedAt = date(window.observedAt);
        const priorSessions = await tx.selectDistinctOn([s.workforceSessionVersions.wiseSessionId]).from(s.workforceSessionVersions).where(lte(s.workforceSessionVersions.observedAt, observedAt)).orderBy(asc(s.workforceSessionVersions.wiseSessionId), desc(s.workforceSessionVersions.observedAt), desc(s.workforceSessionVersions.versionOrder));
        const creditSessionIds = [...new Set(window.credits.map(credit => credit.wiseSessionId))];
        const latestCreditAt = new Date(Math.max(observedAt.getTime(), ...window.credits.map(credit => date(credit.observedAt ?? window.observedAt).getTime())));
        const priorCredits: Array<typeof s.workforceCreditVersions.$inferSelect> = [];
        for (let offset = 0; offset < creditSessionIds.length; offset += 500) {
            priorCredits.push(...await tx.select().from(s.workforceCreditVersions).where(and(
                inArray(s.workforceCreditVersions.wiseSessionId, creditSessionIds.slice(offset, offset + 500)),
                lte(s.workforceCreditVersions.observedAt, latestCreditAt),
            )).orderBy(desc(s.workforceCreditVersions.observedAt), desc(s.workforceCreditVersions.versionOrder)));
        }
        const latestSessions = new Map<string, string>();
        const creditsByKey = new Map<string, typeof priorCredits>();
        for (const row of priorSessions)
            if (!latestSessions.has(row.wiseSessionId))
                latestSessions.set(row.wiseSessionId, row.contentHash);
        for (const row of priorCredits) {
            const key = JSON.stringify([row.wiseSessionId, row.wiseStudentId]);
            creditsByKey.set(key, [...(creditsByKey.get(key) ?? []), row]);
        }
        const tutorBySession = new Map<string, typeof window.evidence.tutorFacts>();
        const participantsBySession = new Map<string, typeof window.evidence.historicalBookedParticipants>();
        for (const fact of window.evidence.tutorFacts) tutorBySession.set(fact.wiseSessionId, [...(tutorBySession.get(fact.wiseSessionId) ?? []), fact]);
        for (const fact of window.evidence.historicalBookedParticipants) participantsBySession.set(fact.wiseSessionId, [...(participantsBySession.get(fact.wiseSessionId) ?? []), fact]);
        const seenSessionHashes = new Map<string, string>();
        const seenCreditHashes = new Map<string, string>();
        const sessions = new Map<string, typeof s.workforceSessionVersions.$inferInsert>();
        for (const session of window.sessions) {
            const fact = Object.fromEntries(Object.entries(session).filter(([key]) => key !== "observedAt"));
            const payload = { session: fact, tutorFacts: tutorBySession.get(session.wiseSessionId) ?? [], participants: participantsBySession.get(session.wiseSessionId) ?? [] };
            const contentHash = workforceContentHash(payload);
            if (seenSessionHashes.has(session.wiseSessionId) && seenSessionHashes.get(session.wiseSessionId) !== contentHash)
                throw new Error('Conflicting workforce session');
            seenSessionHashes.set(session.wiseSessionId, contentHash);
            if (latestSessions.get(session.wiseSessionId) !== contentHash)
                sessions.set(session.wiseSessionId, { wiseSessionId: session.wiseSessionId, contentHash, observedAt, startAt: date(session.startAt), runId: run.id, payload });
        }
        const credits = new Map<string, typeof s.workforceCreditVersions.$inferInsert>();
        for (const credit of window.credits) {
            const payload = Object.fromEntries(Object.entries(credit).filter(([field]) => field !== "observedAt"));
            const key = JSON.stringify([credit.wiseSessionId, credit.wiseStudentId]), contentHash = workforceContentHash(payload);
            if (seenCreditHashes.has(key) && seenCreditHashes.get(key) !== contentHash)
                throw new Error('Conflicting workforce credit');
            seenCreditHashes.set(key, contentHash);
            const creditObservedAt = credit.observedAt ? date(credit.observedAt) : observedAt;
            const prior = creditsByKey.get(key)?.find(row => row.observedAt.getTime() <= creditObservedAt.getTime());
            if (prior?.contentHash !== contentHash)
                credits.set(key, { wiseSessionId: credit.wiseSessionId, wiseStudentId: credit.wiseStudentId, contentHash, observedAt: creditObservedAt, runId: run.id, payload });
        }
        for (const rows of [Array.from(sessions.values())])
            for (let i = 0; i < rows.length; i += 500)
                await tx.insert(s.workforceSessionVersions).values(rows.slice(i, i + 500));
        const creditRows = Array.from(credits.values());
        for (let i = 0; i < creditRows.length; i += 500)
            await tx.insert(s.workforceCreditVersions).values(creditRows.slice(i, i + 500));
        return { runId: run.id, versionsAdded: sessions.size + credits.size, observationsAdded: 1, complete: true };
    });
}
