// ── Wise API response types ─────────────────────────────────────────────

export interface WiseTeacher {
  _id: string;
  userId?: string;
  name: string;
  tags?: WiseTag[];
  [key: string]: unknown;
}

export interface WiseTag {
  _id: string;
  name: string;
  [key: string]: unknown;
}

export interface WiseAvailabilityResponse {
  workingHours?: {
    slots?: WiseWorkingHourSlot[];
  };
  leaves?: WiseLeave[];
  [key: string]: unknown;
}

export interface WiseWorkingHourSlot {
  day: number; // 0=Sunday .. 6=Saturday
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

export interface WisePaginatedResponse<T> {
  data: T[];
  total?: number;
  page?: number;
  limit?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}
