import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { buildCompareTutor, detectConflicts, findSharedFreeSlots } from "@/lib/search/compare";
import type { DateRange } from "@/lib/search/compare";
import type { CompareResponse, SnapshotMeta } from "@/lib/search/types";

const compareRequestSchema = z.object({
  tutorGroupIds: z.array(z.string()).min(1).max(3),
  mode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
  weekStart: z.string().optional(),
});

/** Get the Monday of the current week in Asia/Bangkok. */
function getCurrentMonday(): Date {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }),
  );
  const day = now.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
  return monday;
}

function parseMondayDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function formatIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

  const parsed = compareRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { tutorGroupIds, mode, dayOfWeek, date, weekStart: weekStartParam } = parsed.data;
  const db = getDb();

  try {
    const startTime = Date.now();
    const index = await ensureIndex(db);
    const warnings: string[] = [];

    const snapshotMeta: SnapshotMeta = {
      snapshotId: index.snapshotId,
      syncedAt: index.builtAt.toISOString(),
      stale: Date.now() - index.builtAt.getTime() > 35 * 60 * 1000,
    };

    if (snapshotMeta.stale) {
      warnings.push("Search data may be stale — last sync was more than 35 minutes ago");
    }

    const indexedGroups = tutorGroupIds
      .map((id) => index.tutorGroups.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);

    if (indexedGroups.length === 0) {
      return NextResponse.json(
        { error: "No matching tutor groups found in active snapshot" },
        { status: 404 },
      );
    }

    // Compute week range
    const mondayDate = weekStartParam ? parseMondayDate(weekStartParam) : getCurrentMonday();
    const sundayEnd = addDays(mondayDate, 7);
    const dateRange: DateRange = { start: mondayDate, end: sundayEnd };

    const weekdays: number[] | undefined =
      dayOfWeek !== undefined
        ? [dayOfWeek]
        : date
          ? [new Date(date).getDay()]
          : undefined;

    const compareTutors = indexedGroups.map((g) => buildCompareTutor(g, weekdays, dateRange));
    const conflicts = detectConflicts(compareTutors, indexedGroups);
    const sharedFreeSlots = findSharedFreeSlots(
      indexedGroups,
      weekdays ?? [0, 1, 2, 3, 4, 5, 6],
      dateRange,
    );

    const response: CompareResponse = {
      snapshotMeta,
      tutors: compareTutors,
      conflicts,
      sharedFreeSlots,
      weekStart: formatIsoDate(mondayDate),
      weekEnd: formatIsoDate(addDays(mondayDate, 6)),
      latencyMs: Date.now() - startTime,
      warnings,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compare failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
