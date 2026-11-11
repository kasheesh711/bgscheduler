import { normalizeTutorName } from "./rooms";
import { isOnlineSessionType } from "./session-mode";

export const CLASSROOM_ALGORITHM_VERSION = "room-pairs-v2";
export const CONTINUITY_GAP_MINUTES = 15;

export interface TutorRoomPolicy {
  canonicalKey: string;
  revision: number;
  rooms: string[];
  unavailableRooms?: string[];
}

export type TutorRoomPolicies = ReadonlyMap<string, TutorRoomPolicy>;

export function classroomContinuityEnabled(): boolean {
  return process.env.CLASSROOM_CONTINUITY_ENABLED !== "false";
}

/** Production callers supply the resolved canonical key. Never persist a guessed identity. */
export function assignmentTutorKey(row: { canonicalKey?: string | null; groupId?: string; tutorDisplayName: string }): string {
  return row.canonicalKey?.toLowerCase() || normalizeTutorName(row.tutorDisplayName).replace(/\s+Online$/i, "").toLowerCase();
}

export function policyForTutor(row: { canonicalKey?: string | null }, policies?: TutorRoomPolicies): TutorRoomPolicy | undefined {
  return row.canonicalKey ? policies?.get(row.canonicalKey.toLowerCase()) : undefined;
}

export const physicalRoom = (name: string) => name.trim().toLowerCase().replace(/\s+\(tv\)$/, "");

export function connectedRoomBlocks<T extends {
  canonicalKey?: string | null; groupId?: string; tutorDisplayName: string;
  startMinute: number; endMinute: number; sessionType?: string | null;
}>(rows: T[]): T[][] {
  const tutors = new Map<string, T[]>();
  for (const row of rows) {
    const key = assignmentTutorKey(row);
    tutors.set(key, [...(tutors.get(key) ?? []), row]);
  }
  const blocks: T[][] = [];
  for (const group of tutors.values()) {
    group.sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
    let block: T[] = [];
    for (const row of group) {
      const prior = block.at(-1), gap = prior ? row.startMinute - prior.endMinute : -1;
      const connected = gap >= 0 && (gap <= CONTINUITY_GAP_MINUTES
        || (gap < 60 && (isOnlineSessionType(prior?.sessionType) || isOnlineSessionType(row.sessionType))));
      if (!connected) { if (block.length) blocks.push(block); block = []; }
      block.push(row);
    }
    if (block.length) blocks.push(block);
  }
  return blocks;
}

export interface RoomQualityMetrics {
  consecutivePairs: number;
  roomChanges: number;
  outsideUsualRooms: number;
  profiledAssignments: number;
  usualRoomCoverage: number | null;
  distinctTeacherRooms: number;
  continuitySearchExhausted?: boolean;
  continuityNodes?: number;
}

interface QualityRow {
  canonicalKey?: string | null;
  groupId?: string;
  tutorDisplayName: string;
  wiseSessionId: string;
  startMinute: number;
  endMinute: number;
  assignedRoom: string;
  status: string;
  sessionType?: string | null;
}

export function roomQualityMetrics(rows: QualityRow[], policies?: TutorRoomPolicies): RoomQualityMetrics {
  const tutors = new Map<string, QualityRow[]>();
  for (const row of rows) {
    const key = assignmentTutorKey(row);
    tutors.set(key, [...(tutors.get(key) ?? []), row]);
  }
  let consecutivePairs = 0, roomChanges = 0, outsideUsualRooms = 0, profiledAssignments = 0, distinctTeacherRooms = 0;
  const holds = (row: QualityRow) => row.status === "assigned" || row.status === "needs_review";
  for (const group of tutors.values()) {
    group.sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.wiseSessionId.localeCompare(b.wiseSessionId));
    distinctTeacherRooms += new Set(group.filter(holds).map(row => physicalRoom(row.assignedRoom))).size;
    for (let i = 0; i < group.length; i++) {
      const row = group[i];
      if (!holds(row)) continue;
      const policy = policyForTutor(row, policies);
      if (policy?.rooms.length) {
        profiledAssignments++;
        if (!policy.rooms.slice(0, 2).some(room => physicalRoom(room) === physicalRoom(row.assignedRoom))) outsideUsualRooms++;
      }
      const prior = group[i - 1];
      if (!prior || !holds(prior)) continue;
      const gap = row.startMinute - prior.endMinute;
      if (gap < 0 || (gap > CONTINUITY_GAP_MINUTES
        && !(gap < 60 && (isOnlineSessionType(prior.sessionType) || isOnlineSessionType(row.sessionType))))) continue;
      consecutivePairs++;
      if (physicalRoom(prior.assignedRoom) !== physicalRoom(row.assignedRoom)) roomChanges++;
    }
  }
  return { consecutivePairs, roomChanges, outsideUsualRooms, profiledAssignments, distinctTeacherRooms,
    usualRoomCoverage: profiledAssignments ? (profiledAssignments - outsideUsualRooms) / profiledAssignments : null };
}

export function roomPolicySnapshot(policies: TutorRoomPolicies): TutorRoomPolicy[] {
  return [...policies.values()].sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
}

export function policiesFromMetadata(metadata: Record<string, unknown>): Map<string, TutorRoomPolicy> {
  const policies = new Map<string, TutorRoomPolicy>();
  for (const value of Array.isArray(metadata.roomPolicies) ? metadata.roomPolicies : []) {
    if (!value || typeof value !== "object") continue;
    const policy = value as TutorRoomPolicy;
    if (typeof policy.canonicalKey !== "string" || !Array.isArray(policy.rooms) || !policy.rooms.every(room => typeof room === "string")) continue;
    policies.set(policy.canonicalKey.toLowerCase(), policy);
  }
  return policies;
}
