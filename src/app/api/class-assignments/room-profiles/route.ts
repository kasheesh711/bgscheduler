import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listTutorRoomProfiles } from "@/lib/classrooms/room-profiles";

export async function GET() {
  if (!await auth()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await listTutorRoomProfiles(getDb())); }
  catch { return NextResponse.json({ error: "Unable to load teacher room profiles" }, { status: 500 }); }
}
