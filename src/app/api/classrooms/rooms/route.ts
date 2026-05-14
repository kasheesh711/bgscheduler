import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listClassroomRooms } from "@/lib/classrooms/data";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rooms = await listClassroomRooms(getDb());
    return NextResponse.json({ rooms });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load classroom rooms";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
