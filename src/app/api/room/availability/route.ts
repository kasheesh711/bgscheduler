import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { getRoomDayView } from "@/lib/room-booking/service";
import { roomActor, roomJson, roomError } from "@/lib/room-booking/http";
export async function GET(request: NextRequest) {
  try {
    const actor = await roomActor(request);
    return roomJson(
      await getRoomDayView(
        getDb(),
        actor,
        new Date(),
        request.nextUrl.searchParams.get("date") ?? undefined,
      ),
    );
  } catch (error) {
    return roomError(error);
  }
}
