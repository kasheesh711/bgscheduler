import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { isMissingSchemaError, TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { listRemovalRuns, previewRemovalRun } from "@/lib/tutor-offboarding/removal";
import { requireRemovalOperator } from "../removal-auth";

const PreviewBody = z.object({
  canonicalKeys: z.array(z.string().trim().min(1).max(200)).min(1).max(100)
    .refine((keys) => new Set(keys).size === keys.length, "Duplicate people are not allowed."),
}).strict();

export const maxDuration = 120;

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new TutorOffboardingError("Invalid JSON body.", 400);
  }
}

/** GET history is admin-readable; POST preview requires a freshly read removal capability. */
export async function GET() {
  try {
    await requireTutorOffboardingAdmin();
    return NextResponse.json({ runs: await listRemovalRuns() });
  } catch (error) {
    if (isMissingSchemaError(error)) return NextResponse.json({ available: false, reason: "not_set_up" });
    return tutorOffboardingErrorResponse("[tutor-offboarding] removal run list failed", error, "Removal history could not load.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const { viewer } = await requireRemovalOperator();
    const parsed = PreviewBody.parse(await readJson(request));
    const run = await previewRemovalRun(viewer, parsed.canonicalKeys);
    return NextResponse.json({ run });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] removal preview failed", error, "A removal preview could not be created.");
  }
}
