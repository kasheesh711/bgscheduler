export interface ClassroomRun {
  id: string;
  assignmentDate: string;
  status: "completed" | "published" | "partial" | "failed";
  forceReassign: boolean;
  totalSessions: number;
  assignedCount: number;
  needsReviewCount: number;
  noRoomCount: number;
  remoteCount: number;
  publishedCount: number;
  failedPublishCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClassroomRoom {
  id: string;
  name: string;
  hasTv: boolean;
  capacity: number;
  category: "standard" | "overflow_only" | "online_only";
  active: boolean;
  sortOrder: number;
}

export interface ClassroomRow {
  id: string;
  runId: string;
  tutorDisplayName: string;
  wiseTeacherId: string;
  wiseTeacherUserId: string | null;
  wiseSessionId: string;
  wiseClassId: string | null;
  startTime: string;
  endTime: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  sessionType: string | null;
  currentWiseLocation: string | null;
  studentName: string | null;
  studentCount: number | null;
  subject: string | null;
  classType: string | null;
  title: string | null;
  minCapacity: number;
  needsTv: boolean;
  preferredRoom: string | null;
  overrideRoom: string | null;
  assignedRoom: string;
  status: "assigned" | "needs_review" | "no_room" | "remote";
  warnings: string[];
  publishStatus: "not_published" | "skipped" | "success" | "failed";
  publishError: string | null;
}

export interface AssignmentDetail {
  run: ClassroomRun | null;
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
  wiseWritebackEnabled: boolean;
}
