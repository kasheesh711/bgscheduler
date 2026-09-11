import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { cancelRoomReservation } from "@/lib/room-booking/service";
import { roomActor, roomJson, roomError } from "@/lib/room-booking/http";
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await roomActor(request);
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success)
      return roomJson({ error: "Invalid booking ID." }, 400);
    return roomJson({
      reservation: await cancelRoomReservation(getDb(), id, { userId: actor }),
    });
  } catch (error) {
    return roomError(error);
  }
}
