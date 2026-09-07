import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { RoomProfileError, updateTutorRoomProfile } from "@/lib/classrooms/room-profiles";

const bodySchema = z.object({ roomIds: z.array(z.uuid()).min(1).max(3), revision: z.number().int().positive() });
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ canonicalKey: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose one to three rooms and provide the current revision" }, { status: 400 });
  try {
    return NextResponse.json(await updateTutorRoomProfile(getDb(), { ...parsed.data, canonicalKey: (await params).canonicalKey, actor: session.user.email }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof RoomProfileError ? error.message : "Unable to update room profile" }, { status: error instanceof RoomProfileError ? error.status : 500 });
  }
}
