export type OverflowSolverStatus = "minimum_proven" | "best_found" | "no_complete_solution" | "unverified";
export type StudentHistoryTier = "verified_switches" | "online_attendance" | "onsite_only" | "unknown";

export interface StudentModeEvidence {
  studentId: string;
  tier: StudentHistoryTier;
  verifiedSwitches: number;
  observedOnsiteLessons: number;
  onlineAttended: number;
  attendedLessons: number;
  adjustedFrequency: number;
  firstLessonAt: string | null;
  lastLessonAt: string | null;
  lastOnlineAt: string | null;
  lookbackDays: 180;
}

export interface OverflowPlacement {
  wiseSessionId: string;
  tutor: string;
  student: string | null;
  startMinute: number;
  endMinute: number;
  originalRoom: string;
  room: string;
  status: "assigned" | "remote" | "no_room" | "needs_review";
  converted: boolean;
  released: boolean;
  /** Identifies the lesson, roster and tutor; deliberately independent of modality. */
  lessonKey: string;
}

export interface OverflowAction extends OverflowPlacement {
  kind: "relocate_online" | "switch_to_online" | "move_room" | "accommodate";
  teachingLocation: "classroom" | "dedicated_online_room" | "elsewhere";
  evidence: StudentModeEvidence | null;
}

export interface OverflowPlan {
  version: 1;
  algorithmVersion: "overflow-v1";
  assignmentDate: string;
  generatedAt: string;
  sourceSnapshotId: string | null;
  sourceCheckedAt: string | null;
  snapshotFinishedAt?: string | null;
  historyCheckedAt: string | null;
  status: OverflowSolverStatus;
  minimumSwitches: number | null;
  switchLowerBound: number | null;
  proposedSwitches: number;
  rankingComplete: boolean;
  baselineOverflow: number;
  actualRemainingOverflow: number;
  predictedRemainingOverflow: number;
  actualActions: OverflowAction[];
  proposedActions: OverflowAction[];
  predictedAssignments: OverflowPlacement[];
  accommodatedSessionIds: string[];
  warnings: string[];
  elapsedMs: number;
}

/** Stored metadata from older releases may not have an overflow plan. */
export function readOverflowPlan(metadata: Record<string, unknown> | null | undefined): OverflowPlan | null {
  const value = metadata?.overflowPlan as OverflowPlan | undefined;
  return value?.version === 1 && value.algorithmVersion === "overflow-v1"
    && Array.isArray(value.actualActions) && Array.isArray(value.proposedActions)
    && Array.isArray(value.predictedAssignments) ? value : null;
}
