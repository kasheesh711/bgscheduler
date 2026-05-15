import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getRoomCapacityForecast } from "@/lib/room-capacity/data";

function isMissingForecastTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("room_capacity_model_runs") ||
    message.includes("room_capacity_forecast_drivers") ||
    message.includes("room_capacity_demand_mix") ||
    message.includes("room_capacity_package_mix")
  );
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
