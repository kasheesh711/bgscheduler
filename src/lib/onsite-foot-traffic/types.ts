export const FOOT_TRAFFIC_HISTORY_START = "2026-03-01";
export const FOOT_TRAFFIC_RESEARCH_END = "2026-09-30";
export const FOOT_TRAFFIC_TIME_ZONE = "Asia/Bangkok";
export const FOOT_TRAFFIC_REPORT_MAX_DAYS = 366;

export type FootTrafficExclusionReason =
  | "cancelled"
  | "missed"
  | "not_ended"
  | "not_onsite"
  | "missing_location"
  | "unknown_room"
  | "online_only_room"
  | "no_attendance_evidence";

export interface FootTrafficFilters {
  startDate: string;
  endDate: string;
  rooms?: string[];
  weekdays?: number[];
}

export interface FootTrafficSessionRecord {
  wiseSessionId: string;
  attendanceDate: string;
  scheduledStartAt: Date | string;
  scheduledEndAt: Date | string;
  wiseStatus: string;
  sessionType: string | null;
  normalizedLocation: string | null;
  roomName: string | null;
  roomCategory: string | null;
  subject: string | null;
  tutorName: string | null;
  scheduledStudentCount: number | null;
  participantCount: number;
  countedVisitCount: number;
  missingAttendanceEvidenceCount: number;
  missingStableIdCount: number;
  isCountedOnsite: boolean;
  exclusionReason: FootTrafficExclusionReason | null;
}

export interface FootTrafficVisitRecord {
  wiseSessionId: string;
  participantKey: string;
  studentFingerprint: string | null;
  attendanceDate: string;
  consumedCredits: number;
}

export interface FootTrafficVisitDetail {
  attendanceDate: string;
  startTime: string;
  weekStart: string;
  month: string;
  studentFingerprint: string | null;
  wiseSessionId: string;
  room: string;
  subject: string | null;
  tutor: string | null;
  consumedCredits: number;
}

export interface FootTrafficSummary {
  studentVisits: number;
  uniqueStudents: number;
  onsiteClasses: number;
  averageVisitsPerClass: number;
  unidentifiedVisits: number;
}

export interface FootTrafficPeriodRow extends FootTrafficSummary {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  isPartial: boolean;
}

export interface FootTrafficBreakdownRow extends FootTrafficSummary {
  key: string;
  label: string;
}

export interface FootTrafficDataQuality {
  totalPastSessions: number;
  countedOnsiteSessions: number;
  excludedSessions: number;
  cancelledSessions: number;
  missedSessions: number;
  notEndedSessions: number;
  nonOnsiteSessions: number;
  missingLocationSessions: number;
  unknownRoomSessions: number;
  onlineOnlyRoomSessions: number;
  sessionsWithoutAttendanceEvidence: number;
  participantsWithoutAttendanceEvidence: number;
  unidentifiedVisits: number;
}

export interface FootTrafficMeta {
  requestedStartDate: string;
  requestedEndDate: string;
  effectiveStartDate: string;
  effectiveEndDate: string;
  coverageStartDate: string | null;
  coverageEndDate: string | null;
  latestCompletedDate: string;
  dataAsOf: string | null;
  lastSuccessfulSyncAt: string | null;
  sourceSyncRunId: string | null;
  timeZone: typeof FOOT_TRAFFIC_TIME_ZONE;
  source: "Wise PAST sessions";
  isEndDateCapped: boolean;
  isSeptemberMonthToDate: boolean;
  rooms: string[];
  weekdays: number[];
  availableRooms: string[];
}

export interface FootTrafficDashboardPayload {
  meta: FootTrafficMeta;
  summary: FootTrafficSummary;
  weekly: FootTrafficPeriodRow[];
  monthly: FootTrafficPeriodRow[];
  byWeekday: FootTrafficBreakdownRow[];
  byRoom: FootTrafficBreakdownRow[];
  dataQuality: FootTrafficDataQuality;
}

export type FootTrafficExportGrain = "weekly" | "monthly" | "weekday" | "room" | "visits";

export interface FootTrafficReportSnapshot {
  id: string;
  createdByEmail: string;
  createdAt: string;
  expiresAt: string;
  payload: FootTrafficDashboardPayload;
}

export interface FootTrafficSyncResult {
  ok: boolean;
  skipped: boolean;
  runId: string | null;
  mode: "rolling" | "backfill";
  startDate: string;
  endDate: string;
  fetchedSessionCount: number;
  storedSessionCount: number;
  visitCount: number;
  unknownRoomCount: number;
  missingAttendanceEvidenceCount: number;
  missingStableIdCount: number;
}
