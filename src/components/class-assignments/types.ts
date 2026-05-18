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

export interface AssignmentSnapshotMeta {
  snapshotId: string | null;
  latestSyncFinishedAt: string | null;
  staleAgeMs: number | null;
  fresh: boolean;
}

export interface AssignmentLiveRoomBlock {
  wiseSessionId: string;
  wiseClassId: string | null;
  className: string | null;
  location: string;
  startMinute: number;
  endMinute: number;
  sessionType: string | null;
  wiseStatus: string | null;
}

export interface AssignmentRoomConflictWarning {
  wiseSessionId: string;
  assignedRoom: string;
  desiredLocation: string;
  message: string;
  blocker: AssignmentLiveRoomBlock;
}

export interface AssignmentDetail {
  run: ClassroomRun | null;
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
  snapshotMeta: AssignmentSnapshotMeta;
  liveRoomBlocks: AssignmentLiveRoomBlock[];
  roomConflictWarnings: AssignmentRoomConflictWarning[];
}
