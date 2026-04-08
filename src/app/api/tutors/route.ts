import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();

  try {
    const index = await ensureIndex(db);

    const tutors = index.tutorGroups.map((g) => ({
      tutorGroupId: g.id,
      displayName: g.displayName,
      supportedModes: g.supportedModes,
      subjects: [...new Set(g.qualifications.map((q) => q.subject))],
    }));

    tutors.sort((a, b) => a.displayName.localeCompare(b.displayName));

    return NextResponse.json({ tutors });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load tutors";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
