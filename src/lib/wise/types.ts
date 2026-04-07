// ── Wise API response types ─────────────────────────────────────────────

export interface WiseUserReference {
  _id: string;
  name?: string;
  [key: string]: unknown;
}

export interface WiseTeacher {
  _id: string;
  userId?: string | WiseUserReference;
  name?: string;
  tags?: WiseTag[];
  [key: string]: unknown;
}

export interface WiseTagObject {
  _id: string;
  name: string;
  [key: string]: unknown;
}

export type WiseTag = string | WiseTagObject;

export interface WiseAvailabilityResponse {
  workingHours?: {
    slots?: WiseWorkingHourSlot[];
  };
  leaves?: WiseLeave[];
  [key: string]: unknown;
}

export interface WiseWorkingHourSlot {
  day: number | string; // 0=Sunday .. 6=Saturday or Wise weekday name
  startTime: string; // "HH:mm" or ISO
  endTime: string;
  [key: string]: unknown;
}

export interface WiseLeave {
  _id?: string;
  startTime: string; // ISO UTC
  endTime: string;
  [key: string]: unknown;
}

export interface WiseSession {
  _id: string;
  userId?: string | WiseUserReference;
  teacherName?: string;
  teacherId?: string;
  scheduledStartTime: string; // ISO UTC
  scheduledEndTime: string;
  meetingStatus?: string;
  type?: string;
  title?: string;
  location?: string;
  [key: string]: unknown;
}

export interface WiseTeachersResponse {
  data?: {
    teachers?: WiseTeacher[];
  };
  [key: string]: unknown;
}

export interface WiseAvailabilityEnvelope {
  data?: WiseAvailabilityResponse;
  [key: string]: unknown;
}

export interface WiseSessionsResponse {
  data?: {
    sessions?: WiseSession[];
    page_number?: number;
    page_count?: number;
    totalRecords?: number;
  };
  [key: string]: unknown;
}

export function getWiseUserId(
  userRef: string | WiseUserReference | undefined
): string | undefined {
  if (!userRef) return undefined;
  return typeof userRef === "string" ? userRef : userRef._id;
}

export function getWiseUserName(
  userRef: string | WiseUserReference | undefined
): string | undefined {
  if (!userRef || typeof userRef === "string") return undefined;
  return userRef.name;
}

export function getWiseTeacherUserId(teacher: WiseTeacher): string | undefined {
  return getWiseUserId(teacher.userId);
}

export function getWiseTeacherDisplayName(teacher: WiseTeacher): string {
  return getWiseUserName(teacher.userId) ?? teacher.name ?? teacher._id;
}

export function getWiseSessionTeacherUserId(
  session: WiseSession
): string | undefined {
  return getWiseUserId(session.userId) ?? session.teacherId;
}

export function getWiseTagName(tag: WiseTag): string {
  return typeof tag === "string" ? tag : tag.name;
}
