import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  tutorBusinessProfilePatchSchema,
  upsertTutorBusinessProfile,
  listTutorBusinessProfiles,
} from "@/lib/tutor-business-profiles";
import { clearSearchIndex } from "@/lib/search/index";

const importCommitSchema = z.object({
  rows: z.array(z.object({
    canonicalKey: z.string().trim().min(1),
    patch: tutorBusinessProfilePatchSchema,
  }).strict()).min(1).max(200),
}).strict();

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = importCommitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  try {
    const activeProfiles = await listTutorBusinessProfiles(db);
    const activeByKey = new Map(activeProfiles.map((profile) => [profile.canonicalKey, profile]));
    const saved = [];
    const skipped = [];

    for (const row of parsed.data.rows) {
      const activeProfile = activeByKey.get(row.canonicalKey);
      if (!activeProfile) {
        skipped.push({ canonicalKey: row.canonicalKey, reason: "Tutor not found in active snapshot" });
        continue;
      }
      saved.push(await upsertTutorBusinessProfile(
        db,
        row.canonicalKey,
        activeProfile.displayName,
        row.patch,
      ));
    }

    if (saved.length > 0) clearSearchIndex();
    return NextResponse.json({ savedCount: saved.length, skipped, profiles: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to commit tutor profile import";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
