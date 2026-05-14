import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getTutorList } from "@/lib/data/tutors";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const tutors = await getTutorList();
    return NextResponse.json({ tutors });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load tutors";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
