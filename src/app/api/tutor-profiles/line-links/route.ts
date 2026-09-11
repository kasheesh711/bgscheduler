import type { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listRoomTutorLinks,
  reviewRoomTutorLink,
} from "@/lib/room-booking/admin";
import { roomJson, roomError } from "@/lib/room-booking/http";
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) return roomJson({ error: "Unauthorized" }, 401);
  try {
    return roomJson(await listRoomTutorLinks(getDb()));
  } catch (error) {
    return roomError(error);
  }
}
const schema = z
  .object({
    lineUserId: z.string().min(1).max(100),
    status: z.enum(["approved", "rejected", "revoked"]),
    canonicalKey: z.string().min(1).optional(),
  })
  .strict();
export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return roomJson({ error: "Unauthorized" }, 401);
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return roomJson({ error: "Invalid access change." }, 400);
  try {
    return roomJson({
      link: await reviewRoomTutorLink(getDb(), input.data, session.user.email),
    });
  } catch (error) {
    return roomError(error);
  }
}
