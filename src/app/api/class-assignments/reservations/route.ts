import type { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  loadRoomDay,
  cancelRoomReservation,
  roomAvailabilityStatus,
} from "@/lib/room-booking/service";
import { roomDate } from "@/lib/room-booking/model";
import { roomJson, roomError } from "@/lib/room-booking/http";
export async function GET(request: NextRequest) {
  if (!(await auth())) return roomJson({ error: "Unauthorized" }, 401);
  const date = request.nextUrl.searchParams.get("date") ?? roomDate();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00+07:00`))
  )
    return roomJson({ error: "Invalid date." }, 400);
  try {
    const day = await loadRoomDay(getDb(), date);
    return roomJson({
      date,
      rooms: day.rooms,
      availabilityStatus: roomAvailabilityStatus(day),
      uncertain: day.uncertain,
      checkedAt: day.state?.checkedAt ?? null,
      lastError: day.state?.lastError ?? null,
      reservations: day.reservations,
    });
  } catch (error) {
    return roomError(error);
  }
}
export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return roomJson({ error: "Unauthorized" }, 401);
  const input = z
    .object({ id: z.string().uuid() })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!input.success) return roomJson({ error: "Invalid booking ID." }, 400);
  try {
    return roomJson({
      reservation: await cancelRoomReservation(getDb(), input.data.id, {
        adminEmail: session.user.email,
      }),
    });
  } catch (error) {
    return roomError(error);
  }
}
