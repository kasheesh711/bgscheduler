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

export interface WiseSessionClassId {
  _id?: string;
  name?: string;
  subject?: string;
  classType?: string;
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
  classId?: string | WiseSessionClassId;
  studentCount?: number;
  metadata?: { recurrenceId?: string; [key: string]: unknown };
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

export interface WiseLocationsResponse {
  data?: {
    locations?: string[];
  };
  [key: string]: unknown;
}

export interface WiseSessionUpdateResponse {
  status?: number;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface WiseActivityUser {
  _id?: string;
  name?: string;
  profilePicture?: string;
  role?: string;
  [key: string]: unknown;
}

export interface WiseActivityClassroom {
  _id?: string;
  name?: string;
  subject?: string;
  [key: string]: unknown;
}

export interface WiseActivityEventDetail {
  eventId?: string;
  eventName?: string;
  eventTimestamp?: string;
  payload?: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

export interface WiseActivityEvent {
  user?: WiseActivityUser;
  event?: WiseActivityEventDetail;
  classroom?: WiseActivityClassroom;
  participant?: WiseActivityUser;
  [key: string]: unknown;
}

export interface WiseActivityEventsResponse {
  data?: {
    events?: WiseActivityEvent[];
  };
  [key: string]: unknown;
}

export interface WiseSessionStatsResponse {
  data?: {
    sessionStats?: {
      totalScheduled?: number;
      totalLive?: number;
      totalLate?: number;
      totalCompleted?: number;
      [key: string]: unknown;
    };
  };
  [key: string]: unknown;
}

export interface WiseClassroomStatsResponse {
  data?: {
    courseStats?: Record<string, unknown>;
    classroomStats?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface WiseClassroomTrendsResponse {
  data?: {
    courseTrends?: Record<string, unknown>;
    classroomTrends?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface WiseMoneyAmount {
  value?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface WiseFeesPaidTrendPoint {
  timestamp?: string;
  count?: number;
  amount?: WiseMoneyAmount;
  [key: string]: unknown;
}

export interface WiseInstituteTrendsResponse {
  data?: {
    trends?: {
      feesPaid?: {
        trends?: WiseFeesPaidTrendPoint[];
      };
      [key: string]: unknown;
    };
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

export function getWiseSessionClassId(session: WiseSession): string | undefined {
  if (!session.classId) return undefined;
  return typeof session.classId === "string" ? session.classId : session.classId._id;
}

export function getWiseSessionClassName(session: WiseSession): string | undefined {
  if (!session.classId || typeof session.classId === "string") return undefined;
  return session.classId.name;
}

export function getWiseSessionClassSubject(session: WiseSession): string | undefined {
  if (!session.classId || typeof session.classId === "string") return undefined;
  return session.classId.subject;
}

export function getWiseSessionClassType(session: WiseSession): string | undefined {
  if (!session.classId || typeof session.classId === "string") return undefined;
  return session.classId.classType;
}

export function getWiseTagName(tag: WiseTag): string {
  return typeof tag === "string" ? tag : tag.name;
}
