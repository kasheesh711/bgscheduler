import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listTutorRoomProfilesWithSuggestions } from "@/lib/classrooms/room-profiles";
import { bangkokDateKey } from "@/lib/room-capacity/dates";

export async function GET() {
  if (!await auth()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await listTutorRoomProfilesWithSuggestions(getDb(), bangkokDateKey(new Date()))); }
  catch { return NextResponse.json({ error: "Unable to load teacher room profiles" }, { status: 500 }); }
}
