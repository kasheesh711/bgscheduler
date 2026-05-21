import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listTutorBusinessProfiles } from "@/lib/tutor-business-profiles";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const profiles = await listTutorBusinessProfiles(getDb());
    return NextResponse.json({ profiles });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load tutor profiles";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
