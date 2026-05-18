import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { executeRangeSearch, generateSubSlots, rangeRequestSchema } from "@/lib/search/range-search";

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
    return NextResponse.json(await executeRangeSearch(db, {
      searchMode,
      dayOfWeek,
      date,
      startTime,
      endTime,
      durationMinutes,
      mode,
      filters,
      tutorGroupIds,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
