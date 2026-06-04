export type WorkflowStatus =
  | "new"
  | "needs_review"
  | "in_progress"
  | "done"
  | "ignored"
  | "canceled_by_tutor";

export type SheetWriteStatus = "not_required" | "pending" | "success" | "failed";

export interface LeaveRequestRow {
  id: string;
  sourceRowNumber: number;
  sourceSubmittedAt: string | null;
  tutorName: string;
  tutorEmail: string | null;
  tutorDisplayName: string | null;
  matchConfidence: string;
  startDate: string | null;
  endDate: string | null;
  timePeriod: string | null;
  specificTimeText: string | null;
  leaveStartTime?: string | null;
  leaveEndTime?: string | null;
  startMinute?: number | null;
  endMinute?: number | null;
  normalizationStatus: string;
  normalizationError: string | null;
  reportedAffectedClasses: string | null;
  sourceSheetStatus: string | null;
  workflowStatus: WorkflowStatus;
  staffNote: string | null;
  sheetWriteStatus: SheetWriteStatus;
  sheetWriteError: string | null;
  affectedClassCount: number;
  cancellationPreviewCount: number;
  unread: boolean;
  updatedAt?: string;
}

export interface LeaveListResponse {
  cards: {
    total: number;
    new: number;
    needsReview: number;
    sheetWriteFailed: number;
    affectedClasses: number;
  };
  unreadActionCount: number;
  timeline: TimelineBucket[];
  requests: LeaveRequestRow[];
  googleSheets?: {
    connected: boolean;
    writeConnected?: boolean;
    email: string | null;
    lastError: string | null;
  };
}

export interface TimelineBucket {
  date: string;
  total: number;
  needsAction: number;
  affectedClasses: number;
}

export interface AffectedLineContact {
  linkId: string;
  contactId: string;
  lineUserId: string;
  displayName: string | null;
  linkedParentLabel: string | null;
  linkedStudentLabel: string | null;
  lineChatUrl: string | null;
}

export interface AffectedStudentContact {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string | null;
  lineContacts: AffectedLineContact[];
}

export interface AffectedSession {
  id: string;
  wiseClassId: string | null;
  wiseSessionId: string;
  startTime: string;
  endTime: string;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  sessionType: string | null;
  location: string | null;
  studentName: string | null;
  studentCount: number | null;
  subject: string | null;
  classType: string | null;
  title: string | null;
  overlapMinutes: number;
  cancelPreviewSelected: boolean;
  students: AffectedStudentContact[];
}

export interface ActivityLog {
  id: string;
  actionType: string;
  status: string;
  message: string | null;
  errorMessage: string | null;
  createdByEmail: string | null;
  createdAt: string;
  requestPayload: Record<string, unknown>;
}

export interface LeaveRequestDetail {
  request: LeaveRequestRow & {
    rawValues: Record<string, unknown>;
    reason: string | null;
    makeupOptions: string | null;
    certificateUrl: string | null;
    situationText: string | null;
    daysNotice: number | null;
    lateNotice: string | null;
    adminFee: number | null;
    emergencyUsed: number | null;
    matchReason: string | null;
    firstSeenAt?: string;
    lastSeenAt?: string;
    statusUpdatedAt?: string | null;
    sheetWrittenAt?: string | null;
  };
  affectedSessions: AffectedSession[];
  activityLog: ActivityLog[];
}
