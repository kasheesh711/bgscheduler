import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { getDb } from "@/lib/db";
import { AutowriterReviewError, feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { isMissingRelationError } from "@/lib/feedback-autowriter/db-errors";
import {
  PAIR_LANGUAGES,
  clearPairLanguageOverride,
  loadPairLanguages,
  setPairLanguageOverride,
} from "@/lib/feedback-autowriter/pair-languages";

const PairKey = {
  wiseClassId: z.string().regex(/^[a-f0-9]{24}$/u),
  tutorKey: z.string().trim().min(1).max(100),
};
const PutBody = z.object({ ...PairKey, language: z.enum(PAIR_LANGUAGES) }).strict();
const DeleteBody = z.object(PairKey).strict();

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AutowriterReviewError("Invalid JSON body.", 400);
  }
}

/** Run an override write; before migration 0116 (SQLSTATE 42P01) it is a 409, not a failure. */
async function withOverrideTable<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isMissingRelationError(error)) throw new AutowriterReviewError("Class-language overrides need migration 0116 applied first.", 409);
    throw error;
  }
}

/**
 * The autowriter's class languages: every (class, tutor) pair with transcribed lessons in the last 90 days, labelled
 * English / Bilingual / Thai / Unknown, with the owner's overrides. Admin role only; page scope is enforced by the
 * proxy. Display only: routing does not read the labels yet.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) throw new AutowriterReviewError("Unauthorized", 401);
    if (session.user.role !== "admin") throw new AutowriterReviewError("Forbidden", 403);
    return NextResponse.json(await loadPairLanguages(getDb()));
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] pair languages load failed", error, "The class languages could not load.");
  }
}

/**
 * Owner only: set a pair's language (`{ wiseClassId, tutorKey, language }`) and return the reloaded payload. Display
 * only (routing does not read the label yet); page scope is enforced by the proxy.
 */
export async function PUT(request: NextRequest) {
  try {
    const actor = await requireClassroomOperationsOwner();
    const parsed = PutBody.safeParse(await readJson(request));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const db = getDb();
    await withOverrideTable(() => setPairLanguageOverride({ ...parsed.data, setBy: actor.email }, db));
    return NextResponse.json(await loadPairLanguages(db));
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] pair language override failed", error, "The class language could not be saved.");
  }
}

/**
 * Owner only: clear a pair's override (`{ wiseClassId, tutorKey }`), back to the automatic label, and return the
 * reloaded payload (also when there was nothing to clear). Display only; page scope is enforced by the proxy.
 */
export async function DELETE(request: NextRequest) {
  try {
    await requireClassroomOperationsOwner();
    const parsed = DeleteBody.safeParse(await readJson(request));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const db = getDb();
    await withOverrideTable(() => clearPairLanguageOverride(parsed.data, db));
    return NextResponse.json(await loadPairLanguages(db));
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] pair language override failed", error, "The class language override could not be cleared.");
  }
}
