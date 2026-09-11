import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { resolveRoomLink } from "./service";
import { RoomBookingError } from "./model";
export const roomHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};
export const roomJson = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: roomHeaders });
export function roomError(error: unknown) {
  return error instanceof RoomBookingError
    ? roomJson({ error: error.message, code: error.code }, error.status)
    : roomJson(
        {
          error: "Room service unavailable. Please try again.",
          code: "ROOM_SERVICE_ERROR",
        },
        500,
      );
}
export async function roomActor(request: NextRequest) {
  return resolveRoomLink(
    getDb(),
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
  );
}
