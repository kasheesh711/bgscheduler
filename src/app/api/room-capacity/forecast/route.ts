import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { sqlStateOf } from "@/lib/db/sql-state";
import { getRoomCapacityForecast } from "@/lib/room-capacity/data";

/**
 * drizzle-orm 0.45 wraps every driver error in a DrizzleQueryError whose
 * message is `Failed query: <sql>`, so it names the room_capacity_* table on
 * ANY failure (timeout, dropped connection, permission). Only SQLSTATE 42P01
 * (undefined_table: a relation this read needs is not migrated yet) earns the
 * typed missing payload. Anything else must stay a 500.
 */
function isMissingForecastTableError(error: unknown): boolean {
  return sqlStateOf(error) === "42P01";
}

function missingForecastBody(scenario: string) {
  return {
    model: {
      status: "missing",
      modelRunId: null,
      sourceLabel: null,
      forecastStart: null,
      forecastEnd: null,
      importedAt: null,
    },
    scenario,
    scenarios: [],
    generatedAt: new Date().toISOString(),
    weekdayResults: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((weekdayName, weekday) => ({
      weekday,
      weekdayName,
      roomSlotFullDate: null,
      roomTutorFullDate: null,
      roomSlotReason: null,
      roomTutorReason: null,
    })),
    weekendDemandBreakpoint: null,
    weekendDemandCaptureReadiness: null,
    monthlyDrivers: [],
  };
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const scenario = request.nextUrl.searchParams.get("scenario") || "Base";

  try {
    const data = await getRoomCapacityForecast(getDb(), { scenario });
    return NextResponse.json(data);
  } catch (error) {
    if (isMissingForecastTableError(error)) {
      return NextResponse.json(missingForecastBody(scenario));
    }
    const message = error instanceof Error ? error.message : "Failed to load room capacity forecast";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
