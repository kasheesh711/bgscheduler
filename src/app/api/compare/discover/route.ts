import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { buildCompareTutor, detectConflicts } from "@/lib/search/compare";
import { parseTimeToMinutes } from "@/lib/normalization/timezone";
import { API_STALE_THRESHOLD_MS } from "@/lib/ops/stale";
import type { IndexedTutorGroup } from "@/lib/search/index";
import type { DiscoverResponse, DiscoverCandidate, SnapshotMeta } from "@/lib/search/types";

const discoverRequestSchema = z.object({
  existingTutorGroupIds: z.array(z.string()).max(2),
  mode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  modeFilter: z.enum(["online", "onsite", "either"]).optional(),
  filters: z
    .object({
      subject: z.string().optional(),
      curriculum: z.string().optional(),
      level: z.string().optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = discoverRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { existingTutorGroupIds, mode, dayOfWeek, date, startTime, endTime, modeFilter, filters } =
    parsed.data;

  const db = getDb();

  try {
    const start = Date.now();
    const index = await ensureIndex(db);

    const snapshotMeta: SnapshotMeta = {
      snapshotId: index.snapshotId,
      syncedAt: index.syncedAt.toISOString(),
      stale: Date.now() - index.syncedAt.getTime() > API_STALE_THRESHOLD_MS,
    };

    const existingSet = new Set(existingTutorGroupIds);
    const existingGroups = existingTutorGroupIds
      .map((id) => index.tutorGroups.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);
    const existingCompareTutors = existingGroups.map((g) => buildCompareTutor(g));

    const weekday = dayOfWeek ?? (date ? new Date(date).getDay() : undefined);
    const slotStartMin = startTime ? parseTimeToMinutes(startTime) : undefined;
    const slotEndMin = endTime ? parseTimeToMinutes(endTime) : undefined;
    const requestedMode = modeFilter ?? "either";

    const candidates: DiscoverCandidate[] = [];

    for (const group of index.tutorGroups) {
      if (existingSet.has(group.id)) continue;

      if (modeFilter && modeFilter !== "either") {
        if (!group.supportedModes.includes(modeFilter)) continue;
      }

      if (filters) {
        const matchesQuals = group.qualifications.some((q) => {
          if (filters.subject && q.subject.toLowerCase() !== filters.subject.toLowerCase()) return false;
          if (filters.curriculum && q.curriculum.toLowerCase() !== filters.curriculum.toLowerCase()) return false;
          if (filters.level && q.level.toLowerCase() !== filters.level.toLowerCase()) return false;
          return true;
        });
        if (!matchesQuals && (filters.subject || filters.curriculum || filters.level)) continue;
      }

      const freeSlots: { start: string; end: string }[] = [];

      if (weekday !== undefined && slotStartMin !== undefined && slotEndMin !== undefined) {
        const hasWindow = hasAvailabilityWindow(
          group,
          weekday,
          slotStartMin,
          slotEndMin,
          requestedMode,
        );
        const isBlocked = hasBlockingSession(
          group,
          mode,
          weekday,
          slotStartMin,
          slotEndMin,
          date,
        );
        const onLeave = hasLeaveConflict(
          group,
          mode,
          weekday,
          slotStartMin,
          slotEndMin,
          date,
        );

        if (hasWindow && !isBlocked && !onLeave) {
          freeSlots.push({ start: startTime!, end: endTime! });
        }
      }

      const candidateCompareTutor = buildCompareTutor(group);
      const allCompareTutors = [...existingCompareTutors, candidateCompareTutor];
      const conflicts = detectConflicts(allCompareTutors);
      const candidateConflicts = conflicts.filter(
        (c) => c.tutorA.tutorGroupId === group.id || c.tutorB.tutorGroupId === group.id,
      );

      const hasDataIssues = group.dataIssues.length > 0 || group.supportedModes.length === 0;
      const dataIssueReasons = [
        ...group.dataIssues.map((i) => `${i.type}: ${i.message}`),
        ...(group.supportedModes.length === 0 ? ["Unresolved modality"] : []),
      ];

      candidates.push({
        tutorGroupId: group.id,
        displayName: group.displayName,
        supportedModes: group.supportedModes,
        qualifications: group.qualifications,
        conflictCount: candidateConflicts.length,
        conflicts: candidateConflicts,
        freeSlots,
        hasDataIssues,
        dataIssueReasons,
      });
    }

    candidates.sort((a, b) => {
      if (a.hasDataIssues !== b.hasDataIssues) return a.hasDataIssues ? 1 : -1;
      if (a.conflictCount !== b.conflictCount) return a.conflictCount - b.conflictCount;
      return b.freeSlots.length - a.freeSlots.length;
    });

    const response: DiscoverResponse = {
      snapshotMeta,
      candidates,
      latencyMs: Date.now() - start,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Discover failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function hasAvailabilityWindow(
  group: IndexedTutorGroup,
  weekday: number,
  startMinute: number,
  endMinute: number,
  requestedMode: "online" | "onsite" | "either",
): boolean {
  return group.availabilityWindows.some((w) => {
    if (w.weekday !== weekday || w.startMinute > startMinute || w.endMinute < endMinute) {
      return false;
    }
    if (requestedMode === "either") return true;
    return w.modality === "both" || w.modality === requestedMode;
  });
}

function hasBlockingSession(
  group: IndexedTutorGroup,
  mode: "recurring" | "one_time",
  weekday: number,
  startMinute: number,
  endMinute: number,
  date?: string,
): boolean {
  const targetDay = date ? localDateKey(date) : null;

  return group.sessionBlocks.some((s) => {
    if (!s.isBlocking || s.startMinute >= endMinute || s.endMinute <= startMinute) {
      return false;
    }
    if (mode === "one_time") {
      return targetDay !== null && localDateKey(s.startTime) === targetDay;
    }
    return s.weekday === weekday;
  });
}

function hasLeaveConflict(
  group: IndexedTutorGroup,
  mode: "recurring" | "one_time",
  weekday: number,
  startMinute: number,
  endMinute: number,
  date?: string,
): boolean {
  if (mode === "one_time" && date) {
    const targetStart = dateAtMinute(date, startMinute);
    const targetEnd = dateAtMinute(date, endMinute);
    return group.leaves.some((l) => l.startTime < targetEnd && l.endTime > targetStart);
  }

  return group.leaves.some((leave) => {
    const leaveStart = leave.startTime;
    const leaveEnd = leave.endTime;
    const isMultiDay = leaveEnd.getTime() - leaveStart.getTime() > 24 * 60 * 60 * 1000;

    if (isMultiDay) {
      const cursor = new Date(leaveStart);
      while (cursor <= leaveEnd) {
        if (cursor.getUTCDay() === weekday) return true;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return false;
    }

    if (leaveStart.getUTCDay() !== weekday) return false;
    const leaveStartMin = leaveStart.getUTCHours() * 60 + leaveStart.getUTCMinutes();
    const leaveEndMin = leaveEnd.getUTCHours() * 60 + leaveEnd.getUTCMinutes();
    return leaveStartMin < endMinute && leaveEndMin > startMinute;
  });
}

function dateAtMinute(date: string, minute: number): Date {
  const [year, month, day] = localDateKey(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60, 0, 0));
}

function localDateKey(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  // SearchIndex timestamps are normalized to Bangkok wall-clock values before
  // indexing. UTC accessors keep that normalized date stable under any host TZ.
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
