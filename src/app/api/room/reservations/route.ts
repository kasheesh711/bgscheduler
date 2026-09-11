import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { createRoomReservation } from "@/lib/room-booking/service";
import { roomActor, roomJson, roomError } from "@/lib/room-booking/http";
const input = z
  .object({
    roomId: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startMinute: z.number().int(),
    endMinute: z.number().int(),
    immediate: z.boolean().optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export async function POST(request: NextRequest) {
  try {
    const actor = await roomActor(request);
    const parsed = input.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return roomJson({ error: "Invalid room reservation." }, 400);
    return roomJson({
      reservation: await createRoomReservation(getDb(), actor, {
        ...parsed.data,
        source: "mobile",
      }),
    });
  } catch (error) {
    return roomError(error);
  }
}
