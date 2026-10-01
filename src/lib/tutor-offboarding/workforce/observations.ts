import { createHash } from "node:crypto";
import type { WorkforceDatedObservation, WorkforcePerson } from "./types";
export const WORKFORCE_OBSERVATION_MAX_AGE_MINUTES = 90;
export interface WorkforceObservationInput {
    sourceKey: string;
    snapshotId: string;
    observedAt: string;
    people: Array<{
        person: WorkforcePerson;
        observation: WorkforceDatedObservation;
    }>;
}
export interface CaptureResult {
    runId: string;
    versionsAdded: number;
    observationsAdded: number;
    complete: boolean;
}
function stable(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(stable);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    return value;
}
export function workforceContentHash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function observationCoverageEnd(observedAt: string, nextAt: string | null, errorAt: string | null): string {
    const start = Date.parse(observedAt);
    const bounds = [start + WORKFORCE_OBSERVATION_MAX_AGE_MINUTES * 60000, ...[nextAt, errorAt].filter((v): v is string => v !== null).map(Date.parse)];
    if (!Number.isFinite(start) || bounds.some(v => !Number.isFinite(v) || v < start))
        throw new Error("Invalid workforce observation boundary");
    return new Date(Math.min(...bounds)).toISOString();
}
/** Source-time/id fields are carried by lightweight observations, not content versions. */
export function personPayload(input: WorkforceObservationInput["people"][number]): Record<string, unknown> {
    const person = Object.fromEntries(Object.entries(input.person).filter(([key]) => !["firstObservedAt", "lastObservedAt"].includes(key)));
    const observation = Object.fromEntries(Object.entries(input.observation).filter(([key]) => !["id", "observedAt", "sourceSnapshotId", "sourceTimes"].includes(key)));
    const sort = <T>(rows: T[]) => [...rows].sort((a, b) => JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b))));
    return { person: { ...person, accounts: sort(input.person.accounts) }, observation: { ...observation, accounts: sort(input.observation.accounts), qualifications: sort(input.observation.qualifications), offeredWindows: sort(input.observation.offeredWindows), leaves: sort(input.observation.leaves) } };
}
import type { IdentityGroup } from "@/lib/normalization/identity";
import { normalizeTeacherTags } from "@/lib/normalization/qualifications";
import { normalizeWorkingHours } from "@/lib/normalization/availability";
import { getWiseTeacherUserId, type WiseTeacher, type WiseWorkingHourSlot, type WiseLeave } from "@/lib/wise/types";
export interface SnapshotAvailability {
    observedAt: string;
    workingHours?: WiseWorkingHourSlot[];
    leaves: WiseLeave[];
    complete: boolean;
    nearLeavesAt: string | null;
    farLeavesAt: string | null;
}
export function buildSnapshotWorkforceObservation(input: {
    sourceKey: string;
    snapshotId: string;
    observedAt: string;
    teachers: WiseTeacher[];
    groups: IdentityGroup[];
    modalities: Map<string, string>;
    availability: Map<string, SnapshotAvailability>;
}): WorkforceObservationInput {
    const dateOrNull = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const people = input.groups.map(group => {
        const teachers = group.members.map(member => input.teachers.find(t => t._id === member.wiseTeacherId)).filter((t): t is WiseTeacher => Boolean(t));
        const accounts = teachers.map(teacher => ({ wiseTeacherId: teacher._id, wiseUserId: getWiseTeacherUserId(teacher) ?? '', joinedAt: dateOrNull(teacher.joinedOn), relation: typeof teacher.relation === 'string' ? teacher.relation.trim().toUpperCase() : null, modality: input.modalities.get(teacher._id) === 'online' ? 'online' as const : input.modalities.get(teacher._id) === 'onsite' ? 'onsite' as const : null }));
        const isAdmin = accounts.some(a => a.relation === 'ADMIN');
        const records = teachers.map(t => input.availability.get(t._id));
        const qualifications = teachers.flatMap(teacher => {
            const normalized = normalizeTeacherTags(teacher.tags ?? [], teacher._id, teacher.name ?? '');
            return normalized.qualifications.map(q => ({ subject: q.subject, curriculum: q.curriculum, level: q.level, modality: accounts.find(a => a.wiseTeacherId === teacher._id)?.modality ?? null }));
        });
        const qualificationKnown = teachers.every(t => Array.isArray(t.tags) && normalizeTeacherTags(t.tags, t._id, t.name ?? '').issues.length === 0);
        const validWindows = records.every(r => r && Array.isArray(r.workingHours) && r.workingHours.every(w => typeof w.startTime === 'string' && typeof w.endTime === 'string' && /^\d{1,2}:\d{2}$/.test(w.startTime) && /^\d{1,2}:\d{2}$/.test(w.endTime) && normalizeWorkingHours([w]).every(n => Number.isFinite(n.startMinute) && Number.isFinite(n.endMinute) && n.startMinute >= 0 && n.endMinute <= 1440) && normalizeWorkingHours([w]).length > 0));
        const validLeaves = records.every(r => r && r.leaves.every(l => Number.isFinite(Date.parse(l.startTime)) && Number.isFinite(Date.parse(l.endTime)) && Date.parse(l.endTime) > Date.parse(l.startTime)));
        const availabilityKnown = records.every(r => r?.complete) && validWindows && validLeaves;
        const hasOffered = records.some(r => normalizeWorkingHours(r?.workingHours).length > 0);
        const role = isAdmin ? (qualifications.length > 0 || hasOffered ? 'teaching_admin' as const : null) : accounts.some(a => a.relation === 'TEACHER') ? 'tutor' as const : null;
        const reasonCodes = [...(!availabilityKnown ? ['availability_fetch_failed'] : []), ...(!qualificationKnown ? ['qualifications_incomplete'] : []), ...(role === null ? ['role_unknown'] : [])];
        const complete = availabilityKnown && qualificationKnown && role !== null;
        const times = (field: 'observedAt' | 'nearLeavesAt' | 'farLeavesAt') => records.map(r => r?.[field]).filter((v): v is string => Boolean(v)).sort()[0] ?? null;
        const observedAt = times('observedAt') ?? input.observedAt;
        const observation: WorkforceDatedObservation = { id: `${input.sourceKey}:${group.canonicalKey}`, canonicalKey: group.canonicalKey, observedAt, source: 'wise_snapshot', sourceSnapshotId: input.snapshotId, sourceTimes: { roster: input.observedAt, availability: times('observedAt'), nearLeaves: times('nearLeavesAt'), farLeaves: times('farLeavesAt') }, role, accounts, qualifications, offeredWindows: teachers.flatMap(t => normalizeWorkingHours(input.availability.get(t._id)?.workingHours).map(w => ({ ...w, modality: accounts.find(a => a.wiseTeacherId === t._id)?.modality ?? null, wiseUserId: getWiseTeacherUserId(t) }))), leaves: teachers.flatMap(t => (input.availability.get(t._id)?.leaves ?? []).filter(l => Number.isFinite(Date.parse(l.startTime)) && Number.isFinite(Date.parse(l.endTime))).map(l => ({ startAt: new Date(l.startTime).toISOString(), endAt: new Date(l.endTime).toISOString(), status: 'approved' as const, wiseUserId: getWiseTeacherUserId(t) }))), availabilityCompleteness: availabilityKnown ? 'complete' : 'unknown', qualificationCompleteness: qualificationKnown ? 'complete' : qualifications.length > 0 ? 'partial' : 'unknown', completeness: complete ? 'complete' : 'partial', reasonCodes };
        const joinedAt = accounts.map(a => a.joinedAt).filter((v): v is string => v !== null).sort()[0] ?? null;
        const person: WorkforcePerson = { canonicalKey: group.canonicalKey, displayName: group.displayName, role, rosterState: 'active', joinedAt, accounts, firstObservedAt: observedAt, lastObservedAt: observedAt, identityCompleteness: group.members.length === teachers.length && accounts.every(a => a.wiseUserId) ? 'complete' : 'unknown', reasonCodes };
        return { person, observation };
    });
    return { sourceKey: input.sourceKey, snapshotId: input.snapshotId, observedAt: input.observedAt, people };
}
