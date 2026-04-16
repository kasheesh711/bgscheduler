import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { executeSearch, getBlockingSessions } from "@/lib/search/engine";
import { parseTimeToMinutes } from "@/lib/normalization/timezone";
import type { RangeSearchResponse, RangeGridRow, TutorReviewResult, BlockingSessionInfo } from "@/lib/search/types";

const rangeRequestSchema = z.object({
  searchMode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.enum(["60", "90", "120"]).transform(Number).or(z.literal(60)).or(z.literal(90)).or(z.literal(120)),
  mode: z.enum(["online", "onsite", "either"]),
  filters: z
    .object({
      subject: z.string().optional(),
      curriculum: z.string().optional(),
      level: z.string().optional(),
    })
    .optional(),
  tutorGroupIds: z.array(z.string()).optional(),
});

function generateSubSlots(
  startTime: string,
  endTime: string,
  durationMinutes: number
): { start: string; end: string }[] {
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startTotal = startH * 60 + startM;
  const endTotal = endH * 60 + endM;

  const slots: { start: string; end: string }[] = [];
  let cursor = startTotal;

  while (cursor + durationMinutes <= endTotal) {
    const slotEnd = cursor + durationMinutes;
    const sh = Math.floor(cursor / 60);
    const sm = cursor % 60;
    const eh = Math.floor(slotEnd / 60);
    const em = slotEnd % 60;
    slots.push({
      start: `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`,
      end: `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`,
    });
    cursor = slotEnd;
  }

  return slots;
}

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

  const parsed = rangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { searchMode, dayOfWeek, date, startTime, endTime, durationMinutes, mode, filters, tutorGroupIds } =
    parsed.data;

  const subSlots = generateSubSlots(startTime, endTime, durationMinutes);
  if (subSlots.length === 0) {
    return NextResponse.json(
      { error: "Time range is too short for the selected class duration" },
      { status: 400 }
    );
  }

  const db = getDb();

  try {
    const index = await ensureIndex(db);

    // Build synthetic search request with all sub-slots
    const slots = subSlots.map((ss, i) => ({
      id: `range-${i}`,
      dayOfWeek: searchMode === "recurring" ? dayOfWeek : undefined,
      date: searchMode === "one_time" ? date : undefined,
      start: ss.start,
      end: ss.end,
      mode,
    }));

    const result = executeSearch(index, { searchMode, slots, filters });

    // Reshape per-slot results into grid
    const tutorMap = new Map<
      string,
      { row: Omit<RangeGridRow, "availability">; availability: (true | BlockingSessionInfo[])[] }
    >();
    const reviewMap = new Map<string, TutorReviewResult>();

    for (let i = 0; i < result.perSlotResults.length; i++) {
      const slotResult = result.perSlotResults[i];

      for (const tutor of slotResult.available) {
        if (!tutorMap.has(tutor.tutorGroupId)) {
          tutorMap.set(tutor.tutorGroupId, {
            row: {
              tutorGroupId: tutor.tutorGroupId,
              displayName: tutor.displayName,
              supportedModes: tutor.supportedModes,
              qualifications: tutor.qualifications,
            },
            availability: new Array<true | BlockingSessionInfo[]>(subSlots.length).fill([]),
          });
        }
        tutorMap.get(tutor.tutorGroupId)!.availability[i] = true;
      }

      for (const tutor of slotResult.needsReview) {
        if (!reviewMap.has(tutor.tutorGroupId)) {
          reviewMap.set(tutor.tutorGroupId, tutor);
        }
      }
    }

    // Fill in blocking session details for non-available cells
    for (const [tutorGroupId, entry] of tutorMap) {
      const group = index.tutorGroups.find((g) => g.id === tutorGroupId);
      if (!group) continue;

      for (let i = 0; i < subSlots.length; i++) {
        if (entry.availability[i] === true) continue;

        const ss = subSlots[i];
        const slotStartMin = parseTimeToMinutes(ss.start);
        const slotEndMin = parseTimeToMinutes(ss.end);
        const weekday = searchMode === "recurring"
          ? dayOfWeek!
          : new Date(date!).getDay();

        const blockingSessions = getBlockingSessions(
          group,
          searchMode,
          weekday,
          slotStartMin,
          slotEndMin,
          date,
        );

        entry.availability[i] = blockingSessions.length > 0 ? blockingSessions : [];
      }
    }

    // Filter to specific tutors if requested
    if (tutorGroupIds && tutorGroupIds.length > 0) {
      const idSet = new Set(tutorGroupIds);
      for (const [id] of tutorMap) {
        if (!idSet.has(id)) tutorMap.delete(id);
      }
      for (const [id] of reviewMap) {
        if (!idSet.has(id)) reviewMap.delete(id);
      }
    }

    // Sort grid by number of available slots (descending)
    const grid: RangeGridRow[] = [...tutorMap.values()]
      .sort((a, b) => {
        const aCount = a.availability.filter((c) => c === true).length;
        const bCount = b.availability.filter((c) => c === true).length;
        return bCount - aCount;
      })
      .map((entry) => ({ ...entry.row, availability: entry.availability }));

    const response: RangeSearchResponse = {
      snapshotMeta: result.snapshotMeta,
      subSlots,
      grid,
      needsReview: [...reviewMap.values()],
      latencyMs: result.latencyMs,
      warnings: result.warnings,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
