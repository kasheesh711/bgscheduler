import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { loadTerminationSnapshot } from "../termination-sync";
import { buildTerminationMatches } from "../termination-source";
import type { PersonSignals } from "../types";
import { workforceContentHash } from "./observations";
import type { WorkforceDatedObservation, WorkforceEvidence, WorkforcePerson, WorkforceQuery, WorkforceSession, WorkforceSourceCoverage, StudentCreditEvidence } from "./types";
async function sequential<T extends unknown[]>(queries: [...T]): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
    const results: unknown[] = [];
    for (const query of queries) results.push(await query);
    return results as { [K in keyof T]: Awaited<T[K]> };
}
type PersonPayload = {
    person: WorkforcePerson;
    observation: WorkforceDatedObservation;
};
type SessionPayload = {
    session: WorkforceSession;
    tutorFacts: WorkforceEvidence['tutorFacts'];
    participants: WorkforceEvidence['historicalBookedParticipants'];
};
/** SELECT only. Departure context includes all taught history and future classes, independent of report filters. */
export async function loadWorkforceEvidence(db: Database, query: WorkforceQuery, now: Date): Promise<WorkforceEvidence> {
    return withDatabaseTransaction(db, async tx => {
        await tx.execute(sql`set transaction isolation level repeatable read read only`);
        return loadWorkforceEvidenceInTransaction(tx, query, now);
    });
}
export async function loadWorkforceEvidenceInTransaction(db: Database, _query: WorkforceQuery, now: Date): Promise<WorkforceEvidence> {
    const [versions, observations, runs, sessionVersions, creditVersions, mappings, accounts, active] = await sequential([
        db.select().from(s.workforcePersonVersions).where(lte(s.workforcePersonVersions.observedAt, now)).orderBy(asc(s.workforcePersonVersions.observedAt), asc(s.workforcePersonVersions.versionOrder)),
        db.select().from(s.workforcePersonObservations).where(lte(s.workforcePersonObservations.observedAt, now)).orderBy(asc(s.workforcePersonObservations.observedAt)),
        db.select().from(s.workforceCaptureRuns).where(lte(s.workforceCaptureRuns.observedAt, now)).orderBy(asc(s.workforceCaptureRuns.observedAt)),
        db.selectDistinctOn([s.workforceSessionVersions.wiseSessionId]).from(s.workforceSessionVersions).where(lte(s.workforceSessionVersions.observedAt, now)).orderBy(asc(s.workforceSessionVersions.wiseSessionId), desc(s.workforceSessionVersions.observedAt), desc(s.workforceSessionVersions.versionOrder)),
        db.selectDistinctOn([s.workforceCreditVersions.wiseSessionId, s.workforceCreditVersions.wiseStudentId]).from(s.workforceCreditVersions).where(lte(s.workforceCreditVersions.observedAt, now)).orderBy(asc(s.workforceCreditVersions.wiseSessionId), asc(s.workforceCreditVersions.wiseStudentId), desc(s.workforceCreditVersions.observedAt), desc(s.workforceCreditVersions.versionOrder)),
        db.select().from(s.workforceSubjectMappings), db.select().from(s.tutorWiseAccounts),
        db.select().from(s.snapshots).where(eq(s.snapshots.active, true)).limit(1),
    ]);
    const versionById = new Map(versions.map(v => [v.id, v]));
    const people = new Map<string, WorkforcePerson>();
    for (const version of versions) {
        const payload = version.payload as unknown as PersonPayload, old = people.get(version.canonicalKey);
        const joined = [old?.joinedAt, payload.person.joinedAt].filter((v): v is string => Boolean(v) && Number.isFinite(Date.parse(v!))).sort();
        people.set(version.canonicalKey, { ...payload.person, joinedAt: joined[0] ?? null, firstObservedAt: old?.firstObservedAt ?? version.observedAt.toISOString(), lastObservedAt: version.observedAt.toISOString() });
    }
    const dated: WorkforceDatedObservation[] = observations.map(row => {
        const version = row.versionId ? versionById.get(row.versionId) : undefined;
        const payload = version?.payload as unknown as PersonPayload | undefined;
        return { ...(payload?.observation ?? { role: null, accounts: [], qualifications: [], offeredWindows: [], leaves: [], availabilityCompleteness: 'unknown', qualificationCompleteness: 'unknown', completeness: 'unknown', reasonCodes: ['no_complete_person_observation'] }), ...row.quality, id: row.id, canonicalKey: row.canonicalKey, observedAt: row.observedAt.toISOString() } as WorkforceDatedObservation;
    });
    for (const observation of dated) {
        const person = people.get(observation.canonicalKey);
        if (!person) continue;
        if (!person.firstObservedAt || observation.observedAt < person.firstObservedAt) person.firstObservedAt = observation.observedAt;
        if (!person.lastObservedAt || observation.observedAt > person.lastObservedAt) person.lastObservedAt = observation.observedAt;
    }
    for (const account of accounts) {
        const prior = people.get(account.canonicalKey);
        const mapped = { wiseTeacherId: account.wiseTeacherId, wiseUserId: account.wiseUserId ?? '', joinedAt: account.wiseJoinedOn?.toISOString() ?? null, relation: account.wiseRelation, modality: account.isOnlineVariant ? 'online' as const : null };
        if (prior) {
            if (!prior.accounts.some(a => a.wiseTeacherId === account.wiseTeacherId))
                prior.accounts.push(mapped);
            if (mapped.joinedAt && (!prior.joinedAt || mapped.joinedAt < prior.joinedAt))
                prior.joinedAt = mapped.joinedAt;
        }
        else
            people.set(account.canonicalKey, { canonicalKey: account.canonicalKey, displayName: account.canonicalKey, role: account.wiseRelation === 'TEACHER' ? 'tutor' : null, rosterState: account.status === 'absent' ? 'off_roster' : 'active', joinedAt: mapped.joinedAt, accounts: [mapped], firstObservedAt: null, lastObservedAt: null, identityCompleteness: account.status === 'identity_conflict' ? 'unknown' : 'complete', reasonCodes: ['no_durable_availability_observation'] });
    }
    for (const person of people.values()) {
        const currentAccounts = accounts.filter(a => a.canonicalKey === person.canonicalKey);
        if (currentAccounts.length) person.rosterState = currentAccounts.some(a => a.status !== 'absent') ? 'active' : 'off_roster';
    }
    const sessions = new Map<string, WorkforceSession>(), tutorFacts = new Map<string, WorkforceEvidence['tutorFacts'][number]>(), participants = new Map<string, WorkforceEvidence['historicalBookedParticipants'][number]>();
    for (const row of sessionVersions) {
        const payload = row.payload as unknown as SessionPayload;
        sessions.set(row.wiseSessionId, { ...payload.session, observedAt: row.observedAt.toISOString() });
        for (const fact of payload.tutorFacts)
            tutorFacts.set(fact.id, fact);
        for (const fact of payload.participants)
            participants.set(fact.wiseSessionId, fact);
    }
    const ownership = new Map<string, Set<string>>();
    for (const person of people.values())
        for (const account of person.accounts)
            for (const id of [account.wiseTeacherId, account.wiseUserId])
                if (id)
                    ownership.set(id, new Set([...(ownership.get(id) ?? []), person.canonicalKey]));
    for (const session of sessions.values())
        if (!session.canonicalTutorKeys.length) {
            const keys = new Set([...(session.wiseTeacherIds ?? []), ...(session.wiseUserIds ?? [])].flatMap(id => [...(ownership.get(id) ?? [])]));
            if (keys.size === 1)
                session.canonicalTutorKeys = [...keys];
            else
                session.reasonCodes = [...session.reasonCodes, 'unresolved_teacher_identity'];
        }
    const currentFutureIds = new Set<string>();
    const snapshotAge = active[0] ? now.getTime() - active[0].createdAt.getTime() : NaN;
    const futureFresh = Number.isFinite(snapshotAge) && snapshotAge >= 0 && snapshotAge <= 90 * 60000;
    if (active[0]) {
        const future = await db.select({ block: s.futureSessionBlocks, canonicalKey: s.tutorIdentityGroups.canonicalKey }).from(s.futureSessionBlocks).innerJoin(s.tutorIdentityGroups, eq(s.tutorIdentityGroups.id, s.futureSessionBlocks.groupId)).where(and(eq(s.futureSessionBlocks.snapshotId, active[0].id), gt(s.futureSessionBlocks.endTime, now)));
        for (const { block, canonicalKey } of future) {
            currentFutureIds.add(block.wiseSessionId);
            const old = sessions.get(block.wiseSessionId);
            const fact: WorkforceSession = { wiseSessionId: block.wiseSessionId, wiseClassId: block.wiseClassId, classTitle: block.title, startAt: block.startTime.toISOString(), endAt: block.endTime.toISOString(), scheduledMinutes: (block.endTime.getTime() - block.startTime.getTime()) / 60000, canonicalTutorKeys: [canonicalKey], wiseTeacherIds: [block.wiseTeacherId], historicalBookedStudentIds: block.studentIds, participantCompleteness: block.studentIds ? 'complete' : 'unknown', completeness: block.studentIds ? 'complete' : 'partial', meetingStatus: block.wiseStatus, attendanceStatus: null, modality: block.sessionType === 'OFFLINE' ? 'onsite' : block.sessionType === 'SCHEDULED' ? 'online' : null, subject: null, curriculum: null, level: null, observedAt: active[0].createdAt.toISOString(), reasonCodes: block.studentIds ? [] : ['historical_participants_unknown'] };
            if (!old || Date.parse(old.observedAt ?? '') < active[0].createdAt.getTime())
                sessions.set(block.wiseSessionId, fact);
            else if (!old.canonicalTutorKeys.includes(canonicalKey)) {
                old.canonicalTutorKeys = [...new Set([...old.canonicalTutorKeys, canonicalKey])];
                old.completeness = 'partial';
                old.reasonCodes.push('snapshot_teacher_conflict');
            }
        }
    }
    if (futureFresh) for (const fact of sessions.values()) if (Date.parse(fact.endAt ?? fact.startAt) > now.getTime() && !currentFutureIds.has(fact.wiseSessionId)) fact.reasonCodes = [...new Set([...fact.reasonCodes, 'absent_from_current_future_snapshot'])];
    for (const person of people.values())
        if (person.accounts.some(a => a.relation === 'ADMIN')) {
            const knownTeaching = dated.some(o => o.canonicalKey === person.canonicalKey && ((o.qualificationCompleteness !== 'unknown' && o.qualifications.length > 0) || (o.availabilityCompleteness === 'complete' && o.offeredWindows.length > 0))) || [...sessions.values()].some(f => f.canonicalTutorKeys.includes(person.canonicalKey) && !['CANCELLED', 'CANCELED', 'MISSED', 'NO_SHOW'].includes((f.meetingStatus ?? '').toUpperCase()));
            person.role = knownTeaching ? 'teaching_admin' : null;
            if (!knownTeaching)
                person.reasonCodes = [...new Set([...person.reasonCodes, 'teaching_admin_not_established'])];
        }
    const credits = new Map<string, StudentCreditEvidence>();
    for (const row of creditVersions)
        credits.set(JSON.stringify([row.wiseSessionId, row.wiseStudentId]), { ...row.payload, observedAt: row.observedAt.toISOString() } as unknown as StudentCreditEvidence);
    const snapshot = await loadTerminationSnapshot(db);
    const matchingPeople: PersonSignals[] = [...people.values()].map(p => ({ canonicalKey: p.canonicalKey, displayName: p.displayName, accounts: accounts.filter(a => a.canonicalKey === p.canonicalKey).map(a => ({ wiseTeacherId: a.wiseTeacherId, wiseUserId: a.wiseUserId, displayName: a.displayName, email: a.email })) } as PersonSignals));
    const marks = buildTerminationMatches(matchingPeople, snapshot, now);
    const coverage = runs.filter(r => r.kind === 'history').map(r => r.coverage as unknown as WorkforceSourceCoverage);
    coverage.push({ source: 'wise_future_snapshot', requestedFrom: _query.from, requestedTo: _query.to, returnedFrom: null, returnedTo: null, observedAt: active[0]?.createdAt.toISOString(), pagesRequested: 0, pagesReturned: 0, recordsReturned: [...sessions.values()].filter(f => Date.parse(f.endAt ?? f.startAt) > now.getTime()).length, truncated: false, completeness: futureFresh ? 'complete' : 'unknown', issueCodes: futureFresh ? [] : [active[0] ? 'future_snapshot_stale' : 'future_snapshot_missing'] });
    if (snapshot.checkedAt)
        coverage.push({ source: 'termination_sheet', requestedFrom: _query.from, requestedTo: _query.to, returnedFrom: null, returnedTo: null, observedAt: snapshot.checkedAt, pagesRequested: 1, pagesReturned: 1, recordsReturned: snapshot.rows.length, truncated: false, completeness: marks.source.status === 'ready' ? 'complete' : 'partial', issueCodes: [...marks.source.unmatched.map(() => 'unmatched_termination_identity'), ...(marks.source.status === 'ready' ? [] : [`termination_source_${marks.source.status}`])] });
    return { revision: workforceContentHash({ runs: runs.map(r => [r.id, r.complete]), versions: versions.map(v => v.id), sessions: sessionVersions.map(v => v.id), credits: creditVersions.map(v => v.id), mappings, sheet: [snapshot.checkedAt, snapshot.lastError, marks.source.status], active: active[0]?.id }), people: [...people.values()], observations: dated, sessions: [...sessions.values()], tutorFacts: [...tutorFacts.values()], historicalBookedParticipants: [...participants.values()], studentCredits: [...credits.values()], subjectMappings: mappings.map(m => ({ ...m, reviewedAt: m.reviewedAt?.toISOString() ?? null })), terminationMarks: Object.entries(marks.byKey).map(([canonicalKey, e]) => ({ canonicalKey, effectiveAt: null, markedAt: e.checkedAt, status: 'complete', sourceId: String(e.sourceRow) })), sourceCoverage: coverage };
}
