import { NextRequest, NextResponse } from "next/server";
import { toZonedTime } from "date-fns-tz";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import {
  buildCompareTutor,
  detectConflicts,
  findSharedFreeSlots,
  getStartOfTodayBkk,
} from "@/lib/search/compare";
import type { DateRange } from "@/lib/search/compare";
import { fetchPastSessionBlocks } from "@/lib/data/past-sessions";
import type { IndexedSessionBlock } from "@/lib/search/index";
import { TIMEZONE } from "@/lib/normalization/timezone";
import { API_STALE_THRESHOLD_MS } from "@/lib/ops/stale";
import type { CompareResponse, SnapshotMeta } from "@/lib/search/types";

const compareRequestSchema = z.object({
  tutorGroupIds: z.array(z.string()).min(1).max(3),
  mode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
  weekStart: z.string().optional(),
  fetchOnly: z.array(z.string()).optional(),
});

/** Get the Monday of the current week in Asia/Bangkok. */
function getCurrentMonday(): Date {
  // REL-08: canonical "now in Bangkok" via date-fns-tz toZonedTime.
  const now = toZonedTime(new Date(), TIMEZONE);
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

  const { tutorGroupIds, mode, dayOfWeek, date, weekStart: weekStartParam, fetchOnly } = parsed.data;
  const db = getDb();

  try {
    const startTime = Date.now();
    const index = await ensureIndex(db);
    const warnings: string[] = [];

    const snapshotMeta: SnapshotMeta = {
      snapshotId: index.snapshotId,
      syncedAt: index.builtAt.toISOString(),
      stale: Date.now() - index.builtAt.getTime() > API_STALE_THRESHOLD_MS,
    };

    if (snapshotMeta.stale) {
      warnings.push("Search data may be stale — last sync was more than 26 hours ago");
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

    // D-07 / PAST-01: historical-range trigger. If ANY day in the requested
    // dateRange is before startOfToday (BKK), fetch captured past_session_blocks
    // for the selected tutors' canonical keys and merge them into both
    // buildCompareTutor (via pastBlocks param) and findSharedFreeSlots (via a
    // cloned group with sessionBlocks extended — closes research Pitfall 16).
    const startOfTodayBkk = getStartOfTodayBkk();
    const isHistoricalRange = dateRange.start < startOfTodayBkk;

    let pastBlocksByCanonicalKey = new Map<string, IndexedSessionBlock[]>();
    if (isHistoricalRange) {
      // Sort canonical keys for stable cache-key ordering (Plan 03 fetcher
      // relies on argument-hash determinism for efficient cache reuse).
      const canonicalKeys = [...new Set(indexedGroups.map((g) => g.canonicalKey))].sort();
      pastBlocksByCanonicalKey = await fetchPastSessionBlocks(
        canonicalKeys,
        dateRange.start,
        dateRange.end,
      );
    }

    const allCompareTutors = indexedGroups.map((g) =>
      buildCompareTutor(
        g,
        weekdays,
        dateRange,
        pastBlocksByCanonicalKey.get(g.canonicalKey),
      ),
    );
    const conflicts = detectConflicts(allCompareTutors);

    // For findSharedFreeSlots: pre-merge past blocks into each group's
    // sessionBlocks so the function's existing `group.sessionBlocks` read (line
    // 315 of compare.ts) sees the full set. Closes Pitfall 16: without this
    // merge, historical-range compare would mark a tutor as "free" during a past
    // captured session. Non-historical ranges skip this extra allocation.
    const groupsForFreeSlots = isHistoricalRange
      ? indexedGroups.map((g) => {
          const past = pastBlocksByCanonicalKey.get(g.canonicalKey);
          if (!past || past.length === 0) return g;
          return { ...g, sessionBlocks: [...g.sessionBlocks, ...past] };
        })
      : indexedGroups;

    const sharedFreeSlots = findSharedFreeSlots(
      groupsForFreeSlots,
      weekdays ?? [0, 1, 2, 3, 4, 5, 6],
      dateRange,
    );

    // When fetchOnly is provided, only serialize the requested subset of tutors.
    // The full set is still used above for conflict/free-slot detection.
    const fetchOnlySet = fetchOnly ? new Set(fetchOnly) : null;
    const responseTutors = fetchOnlySet
      ? allCompareTutors.filter((t) => fetchOnlySet.has(t.tutorGroupId))
      : allCompareTutors;

    const response: CompareResponse = {
      snapshotMeta,
      tutors: responseTutors,
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
