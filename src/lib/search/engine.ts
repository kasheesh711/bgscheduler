import {
  SearchIndex,
  IndexedTutorGroup,
} from "./index";
import {
  SearchRequest,
  SearchSlot,
  SearchResponse,
  SlotResult,
  TutorResult,
  TutorReviewResult,
  SnapshotMeta,
  SearchFilters,
} from "./types";
import { parseTimeToMinutes } from "@/lib/normalization/timezone";

/**
 * Execute a search against the in-memory index.
 */
export function executeSearch(
  index: SearchIndex,
  request: SearchRequest,
  staleThresholdMs: number = 35 * 60 * 1000 // 35 minutes
): SearchResponse {
  const startTime = Date.now();
  const warnings: string[] = [];

  const snapshotMeta: SnapshotMeta = {
    snapshotId: index.snapshotId,
    syncedAt: index.builtAt.toISOString(),
    stale: Date.now() - index.builtAt.getTime() > staleThresholdMs,
  };

  if (snapshotMeta.stale) {
    warnings.push("Search data may be stale — last sync was more than 35 minutes ago");
  }

  const perSlotResults: SlotResult[] = [];

  for (const slot of request.slots) {
    const result = searchSlot(index, slot, request.searchMode, request.filters);
    perSlotResults.push(result);
  }

  // Compute intersection: tutors available in ALL slots
  const intersection = computeIntersection(perSlotResults);

  return {
    snapshotMeta,
    normalizedSlots: request.slots,
    perSlotResults,
    intersection,
    latencyMs: Date.now() - startTime,
    warnings,
  };
}

function searchSlot(
  index: SearchIndex,
  slot: SearchSlot,
  mode: "recurring" | "one_time",
  filters?: SearchFilters
): SlotResult {
  const startMinute = parseTimeToMinutes(slot.start);
  const endMinute = parseTimeToMinutes(slot.end);
  const weekday = slot.dayOfWeek ?? (slot.date ? new Date(slot.date).getDay() : -1);

  if (weekday < 0 || weekday > 6) {
    return { slotId: slot.id, available: [], needsReview: [] };
  }

  const candidates = index.byWeekday.get(weekday) ?? [];
  const available: TutorResult[] = [];
  const needsReview: TutorReviewResult[] = [];
  const seen = new Set<string>();

  for (const group of candidates) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);

    const reviewReasons: string[] = [];

    // Check for data issues → Needs Review
    if (group.dataIssues.length > 0) {
      reviewReasons.push(...group.dataIssues.map((i) => `${i.type}: ${i.message}`));
    }

    // Check modality
    if (group.supportedModes.length === 0) {
      reviewReasons.push("Unresolved modality");
    } else if (slot.mode !== "either") {
      if (!group.supportedModes.includes(slot.mode)) {
        continue; // Skip — doesn't match mode at all
      }
    }

    // Check availability window covers the slot
    const hasWindow = group.availabilityWindows.some((w) => {
      if (w.weekday !== weekday) return false;
      if (w.startMinute > startMinute || w.endMinute < endMinute) return false;
      // Check modality on window level
      if (slot.mode !== "either" && w.modality !== "both" && w.modality !== slot.mode) return false;
      return true;
    });

    if (!hasWindow) continue;

    // Check qualification filters
    if (filters && !matchesFilters(group, filters)) continue;

    // Check blocking: sessions
    const blocked = mode === "recurring"
      ? isBlockedRecurring(group, weekday, startMinute, endMinute)
      : isBlockedOneTime(group, slot.date!, startMinute, endMinute);

    if (blocked) continue;

    // Check blocking: leaves
    const onLeave = mode === "recurring"
      ? hasRecurringLeaveConflict(group, weekday, startMinute, endMinute)
      : hasOneTimeLeaveConflict(group, slot.date!, startMinute, endMinute);

    if (onLeave) continue;

    // Decide: Available or Needs Review
    const result: TutorResult = {
      tutorGroupId: group.id,
      displayName: group.displayName,
      supportedModes: group.supportedModes,
      qualifications: group.qualifications,
      underlyingWiseRecords: group.wiseRecords.map((r) => ({
        wiseTeacherId: r.wiseTeacherId,
        wiseDisplayName: r.wiseDisplayName,
        isOnline: r.isOnline,
      })),
    };

    if (reviewReasons.length > 0) {
      needsReview.push({ ...result, reasons: reviewReasons });
    } else {
      available.push(result);
    }
  }

  return { slotId: slot.id, available, needsReview };
}

/**
 * For recurring mode: any future session on the same weekday/time blocks.
 */
function isBlockedRecurring(
  group: IndexedTutorGroup,
  weekday: number,
  startMinute: number,
  endMinute: number
): boolean {
  return group.sessionBlocks.some(
    (s) =>
      s.isBlocking &&
      s.weekday === weekday &&
      s.startMinute < endMinute &&
      s.endMinute > startMinute
  );
}

/**
 * For one-time mode: only direct date overlap blocks.
 */
function isBlockedOneTime(
  group: IndexedTutorGroup,
  dateStr: string,
  startMinute: number,
  endMinute: number
): boolean {
  const targetDate = new Date(dateStr);
  const targetDay = targetDate.toISOString().slice(0, 10);

  return group.sessionBlocks.some((s) => {
    if (!s.isBlocking) return false;
    const sessionDay = s.startTime.toISOString().slice(0, 10);
    if (sessionDay !== targetDay) return false;
    return s.startMinute < endMinute && s.endMinute > startMinute;
  });
}

/**
 * Check if any leave overlaps with a recurring weekday/time.
 * For recurring, we check any leave that falls on the same weekday.
 */
function hasRecurringLeaveConflict(
  group: IndexedTutorGroup,
  weekday: number,
  startMinute: number,
  endMinute: number
): boolean {
  for (const leave of group.leaves) {
    // Check each day of the leave range
    const leaveStart = leave.startTime;
    const leaveEnd = leave.endTime;
    const current = new Date(leaveStart);

    while (current <= leaveEnd) {
      if (current.getDay() === weekday) {
        // Leave is on this weekday — check time overlap
        const leaveStartMin = leaveStart.getHours() * 60 + leaveStart.getMinutes();
        const leaveEndMin = leaveEnd.getHours() * 60 + leaveEnd.getMinutes();

        // For multi-day leaves, the whole day is blocked
        const isMultiDay =
          leaveEnd.getTime() - leaveStart.getTime() > 24 * 60 * 60 * 1000;

        if (isMultiDay || (leaveStartMin < endMinute && leaveEndMin > startMinute)) {
          return true;
        }
      }
      current.setDate(current.getDate() + 1);
    }
  }
  return false;
}

/**
 * Check if any leave overlaps with a specific date/time.
 */
function hasOneTimeLeaveConflict(
  group: IndexedTutorGroup,
  dateStr: string,
  startMinute: number,
  endMinute: number
): boolean {
  const targetDate = new Date(dateStr);
  const targetStart = new Date(targetDate);
  targetStart.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
  const targetEnd = new Date(targetDate);
  targetEnd.setHours(Math.floor(endMinute / 60), endMinute % 60, 0, 0);

  return group.leaves.some(
    (l) => l.startTime < targetEnd && l.endTime > targetStart
  );
}

function matchesFilters(group: IndexedTutorGroup, filters: SearchFilters): boolean {
  if (!filters.subject && !filters.curriculum && !filters.level) return true;

  return group.qualifications.some((q) => {
    if (filters.subject && q.subject.toLowerCase() !== filters.subject.toLowerCase()) return false;
    if (filters.curriculum && q.curriculum.toLowerCase() !== filters.curriculum.toLowerCase())
      return false;
    if (filters.level && q.level.toLowerCase() !== filters.level.toLowerCase()) return false;
    return true;
  });
}

function computeIntersection(slotResults: SlotResult[]): TutorResult[] {
  if (slotResults.length === 0) return [];
  if (slotResults.length === 1) return slotResults[0].available;

  // Get IDs available in ALL slots
  const availableSets = slotResults.map(
    (sr) => new Set(sr.available.map((t) => t.tutorGroupId))
  );

  const intersectionIds = [...availableSets[0]].filter((id) =>
    availableSets.every((s) => s.has(id))
  );

  // Return tutor details from first slot (they're the same across slots)
  const tutorMap = new Map(
    slotResults[0].available.map((t) => [t.tutorGroupId, t])
  );

  return intersectionIds.map((id) => tutorMap.get(id)!).filter(Boolean);
}
