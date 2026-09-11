import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runRoomRefresh } from "@/lib/room-booking/refresh";
import { retryRoomEvents } from "@/lib/room-booking/bot";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit(
    {
      jobKey: "room_booking",
      triggerSource: "cron",
      requestMethod: request.method,
    },
    async () => {
      try {
        const result = await runRoomRefresh(getDb());
        await retryRoomEvents(getDb());
        return NextResponse.json(result, { status: result.ok ? 200 : 500 });
      } catch {
        return NextResponse.json(
          {
            ok: false,
            errorSummary:
              "Room occupancy refresh failed; previous evidence retained.",
          },
          { status: 500 },
        );
      }
    },
  );
}
