import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { buildCompareTutor, detectConflicts } from "@/lib/search/compare";
import { parseTimeToMinutes } from "@/lib/normalization/timezone";
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
      syncedAt: index.builtAt.toISOString(),
      stale: Date.now() - index.builtAt.getTime() > 35 * 60 * 1000,
    };

    const existingSet = new Set(existingTutorGroupIds);
    const existingGroups = existingTutorGroupIds
      .map((id) => index.tutorGroups.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);
    const existingCompareTutors = existingGroups.map((g) => buildCompareTutor(g));

    const weekday = dayOfWeek ?? (date ? new Date(date).getDay() : undefined);
    const slotStartMin = startTime ? parseTimeToMinutes(startTime) : undefined;
    const slotEndMin = endTime ? parseTimeToMinutes(endTime) : undefined;

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
        const hasWindow = group.availabilityWindows.some(
          (w) => w.weekday === weekday && w.startMinute <= slotStartMin && w.endMinute >= slotEndMin,
        );
        const isBlocked = group.sessionBlocks.some(
          (s) =>
            s.isBlocking &&
            s.weekday === weekday &&
            s.startMinute < slotEndMin &&
            s.endMinute > slotStartMin,
        );
        if (hasWindow && !isBlocked) {
          freeSlots.push({ start: startTime!, end: endTime! });
        }
      }

      const candidateCompareTutor = buildCompareTutor(group);
      const allCompareTutors = [...existingCompareTutors, candidateCompareTutor];
      const allIndexedGroups = [...existingGroups, group];
      const conflicts = detectConflicts(allCompareTutors, allIndexedGroups);
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
