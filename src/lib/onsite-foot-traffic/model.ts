import { createHmac } from "node:crypto";

import { isOnsiteSessionType } from "@/lib/classrooms/session-mode";
import { normalizeRoomLabel } from "@/lib/room-capacity/analysis";
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import type { WiseSession } from "@/lib/wise/types";

import type {
  FootTrafficExclusionReason,
  FootTrafficSessionRecord,
  FootTrafficVisitRecord,
} from "./types";

export interface FootTrafficRoomDefinition {
  name: string;
  category: "standard" | "overflow_only" | "online_only";
  active: boolean;
}

export interface ClassifiedFootTrafficSession {
  session: FootTrafficSessionRecord;
  visits: FootTrafficVisitRecord[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function participantId(value: unknown): string | null {
  if (typeof value === "string") return stringValue(value);
  const item = record(value);
  if (!item) return null;
  const nestedUser = record(item.userId);
  return stringValue(item.wiseUserId) ??
    stringValue(item._id) ??
    stringValue(item.id) ??
    stringValue(item.studentId) ??
    stringValue(item.participantId) ??
    stringValue(item.userId) ??
    stringValue(nestedUser?._id) ??
    stringValue(nestedUser?.id);
}

function participantCredits(value: unknown): number | null {
  const item = record(value);
  if (!item) return null;
  return finiteNumber(item.creditsConsumed) ??
    finiteNumber(item.consumedCredits) ??
    finiteNumber(item.creditConsumed) ??
    finiteNumber(item.creditApplied) ??
    finiteNumber(item.credits);
}

function participantIsTeacher(value: unknown): boolean {
  const item = record(value);
  if (!item) return false;
  if (item.isTeacher === true || String(item.isTeacher ?? "").toLowerCase() === "true") return true;
  const roles = [item.profile, item.role, item.userType, record(item.userId)?.role]
    .map((candidate) => stringValue(candidate)?.toLowerCase())
    .filter(Boolean);
  return roles.some((role) => role === "teacher" || role === "tutor" || role === "instructor");
}

function uniqueParticipants(session: WiseSession): unknown[] {
  const raw = [
    ...(Array.isArray(session.participants) ? session.participants : []),
    ...(Array.isArray(session.students) ? session.students : []),
  ];
  const seen = new Set<string>();
  return raw.filter((participant, index) => {
    const id = participantId(participant);
    const key = id ? `id:${id}` : `anonymous:${index}:${JSON.stringify(participant)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function subjectForSession(session: WiseSession): string | null {
  const sessionRecord = session as Record<string, unknown>;
  const classRecord = record(session.classId);
  return stringValue(classRecord?.subject) ??
    stringValue(sessionRecord.classSubject) ??
    stringValue(sessionRecord.subject);
}

function tutorForSession(session: WiseSession): string | null {
  if (stringValue(session.teacherName)) return stringValue(session.teacherName);
  if (typeof session.userId !== "string") return stringValue(session.userId?.name);
  return null;
}

function resolveRoom(
  location: string | null,
  rooms: readonly FootTrafficRoomDefinition[],
): FootTrafficRoomDefinition | null {
  if (!location) return null;
  const key = normalizeRoomLabel(location).toLocaleLowerCase("en-US");
  return rooms.find((room) =>
    room.active && normalizeRoomLabel(room.name).toLocaleLowerCase("en-US") === key) ?? null;
}

export function fingerprintStudentId(studentId: string, secret: string): string {
  if (!secret.trim()) throw new Error("FOOT_TRAFFIC_PSEUDONYM_SECRET must not be empty");
  return createHmac("sha256", secret).update(studentId.trim(), "utf8").digest("hex");
}

function exclusionForSession(
  status: string,
  sessionType: string | null,
  location: string | null,
  room: FootTrafficRoomDefinition | null,
  scheduledEndAt: Date,
  now: Date,
): FootTrafficExclusionReason | null {
  const normalizedStatus = status.trim().toUpperCase().replace(/[- ]/g, "_");
  if (["CANCELLED", "CANCELED"].includes(normalizedStatus)) return "cancelled";
  if (["MISSED", "NO_SHOW", "NOSHOW"].includes(normalizedStatus)) return "missed";
  if (normalizedStatus !== "ENDED" || scheduledEndAt.getTime() > now.getTime()) return "not_ended";
  if (!isOnsiteSessionType(sessionType)) return "not_onsite";
  if (!location) return "missing_location";
  if (!room) return "unknown_room";
  if (room.category === "online_only") return "online_only_room";
  return null;
}

/**
 * Converts one Wise PAST-list session into the privacy-minimal canonical model.
 * Student names, raw student IDs, session titles and class names are never
 * returned, which prevents callers from accidentally persisting them.
 */
export function classifyWisePastSession(input: {
  session: WiseSession;
  rooms: readonly FootTrafficRoomDefinition[];
  pseudonymSecret: string;
  now?: Date;
}): ClassifiedFootTrafficSession | null {
  const { session, rooms, pseudonymSecret, now = new Date() } = input;
  const wiseSessionId = stringValue(session._id);
  const scheduledStartAt = new Date(session.scheduledStartTime);
  const scheduledEndAt = new Date(session.scheduledEndTime);
  if (!wiseSessionId || Number.isNaN(scheduledStartAt.getTime()) || Number.isNaN(scheduledEndAt.getTime())) {
    return null;
  }

  const sessionRecord = session as Record<string, unknown>;
  const status = stringValue(session.meetingStatus) ??
    stringValue(sessionRecord.status) ??
    "UNKNOWN";
  const sessionType = stringValue(session.type) ??
    stringValue(sessionRecord.sessionType) ??
    stringValue(record(session.classId)?.classType);
  const location = stringValue(session.location);
  const normalizedLocation = location ? normalizeRoomLabel(location) : null;
  const room = resolveRoom(location, rooms);
  let exclusionReason = exclusionForSession(
    status,
    sessionType,
    location,
    room,
    scheduledEndAt,
    now,
  );
  const participants = uniqueParticipants(session);
  const visits: FootTrafficVisitRecord[] = [];
  let missingAttendanceEvidenceCount = 0;
  let missingStableIdCount = 0;

  if (!exclusionReason) {
    participants.forEach((participant, index) => {
      if (participantIsTeacher(participant)) return;
      const credits = participantCredits(participant);
      if (credits === null || credits <= 0) {
        missingAttendanceEvidenceCount += 1;
        return;
      }
      const stableId = participantId(participant);
      if (!stableId) missingStableIdCount += 1;
      visits.push({
        wiseSessionId,
        participantKey: stableId
          ? fingerprintStudentId(stableId, pseudonymSecret)
          : `unidentified:${wiseSessionId}:${index}`,
        studentFingerprint: stableId ? fingerprintStudentId(stableId, pseudonymSecret) : null,
        attendanceDate: bangkokDateKey(scheduledStartAt),
        consumedCredits: credits,
      });
    });
    if (visits.length === 0) exclusionReason = "no_attendance_evidence";
  }

  return {
    session: {
      wiseSessionId,
      attendanceDate: bangkokDateKey(scheduledStartAt),
      scheduledStartAt,
      scheduledEndAt,
      wiseStatus: status,
      sessionType,
      normalizedLocation,
      roomName: room?.name ?? null,
      roomCategory: room?.category ?? null,
      subject: subjectForSession(session),
      tutorName: tutorForSession(session),
      scheduledStudentCount: finiteNumber(session.studentCount),
      participantCount: participants.filter((participant) => !participantIsTeacher(participant)).length,
      countedVisitCount: visits.length,
      missingAttendanceEvidenceCount,
      missingStableIdCount,
      isCountedOnsite: visits.length > 0,
      exclusionReason,
    },
    visits,
  };
}
