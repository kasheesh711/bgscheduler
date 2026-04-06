import { WiseLeave } from "@/lib/wise/types";
import { toLocalTime } from "./timezone";

export interface NormalizedLeave {
  startTime: Date;
  endTime: Date;
  wiseLeaveId?: string;
}

/**
 * Normalize leaves from Wise availability responses.
 * Converts UTC to Asia/Bangkok and de-duplicates.
 */
export function normalizeLeaves(wiseLeaves: WiseLeave[]): NormalizedLeave[] {
  if (!wiseLeaves || wiseLeaves.length === 0) return [];

  const leaves: NormalizedLeave[] = wiseLeaves.map((l) => ({
    startTime: toLocalTime(l.startTime),
    endTime: toLocalTime(l.endTime),
    wiseLeaveId: l._id,
  }));

  return deduplicateLeaves(leaves);
}

/**
 * De-duplicate and merge overlapping leave windows.
 */
export function deduplicateLeaves(leaves: NormalizedLeave[]): NormalizedLeave[] {
  if (leaves.length <= 1) return leaves;

  // Sort by start time
  const sorted = [...leaves].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime()
  );

  const merged: NormalizedLeave[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.startTime.getTime() <= last.endTime.getTime()) {
      // Overlapping or adjacent — extend
      last.endTime = new Date(
        Math.max(last.endTime.getTime(), current.endTime.getTime())
      );
    } else {
      merged.push(current);
    }
  }

  return merged;
}
