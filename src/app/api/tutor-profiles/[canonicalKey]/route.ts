import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  getActiveTutorDisplayNameByCanonicalKey,
  tutorBusinessProfilePatchSchema,
  upsertTutorBusinessProfile,
} from "@/lib/tutor-business-profiles";
import { clearSearchIndex } from "@/lib/search/index";

type TutorProfileRouteContext = { params: Promise<{ canonicalKey: string }> };

async function canonicalKeyFromContext(ctx: TutorProfileRouteContext) {
  const params = await ctx.params;
  return decodeURIComponent(params.canonicalKey);
}

export async function PATCH(
  request: NextRequest,
  ctx: TutorProfileRouteContext,
) {
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

  const parsed = tutorBusinessProfilePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const canonicalKey = await canonicalKeyFromContext(ctx);
  const displayName = await getActiveTutorDisplayNameByCanonicalKey(db, canonicalKey);
  if (!displayName) {
    return NextResponse.json({ error: "Tutor not found in active snapshot" }, { status: 404 });
  }

  try {
    const profile = await upsertTutorBusinessProfile(db, canonicalKey, displayName, parsed.data);
    clearSearchIndex();
    return NextResponse.json({ profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save tutor profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
