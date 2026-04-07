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

    const subjects = new Set<string>();
    const curriculums = new Set<string>();
    const levels = new Set<string>();

    for (const group of index.tutorGroups) {
      for (const q of group.qualifications) {
        subjects.add(q.subject);
        curriculums.add(q.curriculum);
        levels.add(q.level);
      }
    }

    return NextResponse.json({
      subjects: [...subjects].sort(),
      curriculums: [...curriculums].sort(),
      levels: [...levels].sort(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load filters";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
