import { DAY_MS } from "@/lib/credit-control/config";

export interface ChurnPackageRow {
  studentKey: string;
  studentName: string;
  parentName: string | null;
  remainingCredits: number;
  excludedReason: string | null;
}

export interface ChurnStudentTotal {
  studentKey: string;
  studentName: string;
  parentName: string;
  totalRemaining: number;
}

export interface ChurnZeroTrackingRow {
  studentKey: string;
  zeroSince: Date;
}

export interface ChurnInactiveRow {
  studentKey: string;
  source: string | null;
  removedAtRemaining: number | null;
}

export interface ChurnZeroUpsert {
  studentKey: string;
  studentName: string;
  parentName: string;
  zeroSince: Date;
  lastRemaining: number;
}

export interface ChurnInactivation {
  studentKey: string;
  studentName: string;
  parentName: string;
  removedAtRemaining: number;
}

export interface ChurnTransitions {
  zeroUpserts: ChurnZeroUpsert[];
  zeroClears: string[];
  toInactivate: ChurnInactivation[];
  toReactivate: string[];
}

/**
 * Roll raw package rows up to one total per student, summing remainingCredits
 * across the student's NON-excluded packages (Pretest/Trial excluded). This is
 * the "credits remaining" basis used for churn detection.
 */
export function aggregateStudentRemaining(rows: ChurnPackageRow[]): ChurnStudentTotal[] {
  const byStudent = new Map<string, ChurnStudentTotal>();
  for (const row of rows) {
    if (row.excludedReason) continue;
    const existing = byStudent.get(row.studentKey);
    if (existing) {
      existing.totalRemaining += row.remainingCredits;
    } else {
      byStudent.set(row.studentKey, {
        studentKey: row.studentKey,
        studentName: row.studentName,
        parentName: row.parentName ?? "",
        totalRemaining: row.remainingCredits,
      });
    }
  }
  return [...byStudent.values()];
}

/**
 * Pure churn state machine. Given current per-student balances plus the existing
 * zero-tracking and inactive sidecar state, decide which tracking rows to write or
 * clear, which students to auto-remove (>= thresholdDays continuously at <= 0
 * credits), and which to reactivate on a genuine top-up.
 *
 * Reactivation floor = max(removedAtRemaining, 0): auto-churned students (removed
 * at <= 0) rejoin on any positive balance; a manually-removed student who still
 * held credits only rejoins once they rise above that prior balance.
 */
export function computeChurnTransitions({
  students,
  tracking,
  inactive,
  now,
  thresholdDays,
}: {
  students: ChurnStudentTotal[];
  tracking: ChurnZeroTrackingRow[];
  inactive: ChurnInactiveRow[];
  now: Date;
  thresholdDays: number;
}): ChurnTransitions {
  const trackingByKey = new Map(tracking.map((row) => [row.studentKey, row]));
  const inactiveByKey = new Map(inactive.map((row) => [row.studentKey, row]));
  const thresholdMs = thresholdDays * DAY_MS;

  const transitions: ChurnTransitions = {
    zeroUpserts: [],
    zeroClears: [],
    toInactivate: [],
    toReactivate: [],
  };

  for (const student of students) {
    const tracked = trackingByKey.get(student.studentKey);
    const inactiveRow = inactiveByKey.get(student.studentKey);

    if (inactiveRow) {
      const floor = Math.max(inactiveRow.removedAtRemaining ?? 0, 0);
      if (student.totalRemaining > floor) {
        transitions.toReactivate.push(student.studentKey);
      }
      // An inactive student needs no zero-tracking; drop any stale row.
      if (tracked) transitions.zeroClears.push(student.studentKey);
      continue;
    }

    if (student.totalRemaining <= 0) {
      const zeroSince = tracked?.zeroSince ?? now;
      if (now.getTime() - zeroSince.getTime() >= thresholdMs) {
        transitions.toInactivate.push({
          studentKey: student.studentKey,
          studentName: student.studentName,
          parentName: student.parentName,
          removedAtRemaining: student.totalRemaining,
        });
        if (tracked) transitions.zeroClears.push(student.studentKey);
      } else {
        transitions.zeroUpserts.push({
          studentKey: student.studentKey,
          studentName: student.studentName,
          parentName: student.parentName,
          zeroSince,
          lastRemaining: student.totalRemaining,
        });
      }
    } else if (tracked) {
      transitions.zeroClears.push(student.studentKey);
    }
  }

  return transitions;
}
