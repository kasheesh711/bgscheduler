import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { applyRemovalRun } from "@/lib/tutor-offboarding/removal";
import { requireRemovalOperator } from "../../../removal-auth";
import type { RemovalApplyInput } from "@/lib/tutor-offboarding/removal-types";

const ApplyBody = z.object({
  previewToken: z.string().min(20).max(256),
  confirmed: z.literal(true),
  reason: z.string().trim().min(10).max(500),
  accountCount: z.number().int().nonnegative(),
}).strict();
const RunId = z.string().uuid();

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new TutorOffboardingError("Invalid JSON body.", 400);
  }
}

export const maxDuration = 300;

export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  try {
    const { db, viewer } = await requireRemovalOperator();
    const { runId } = await context.params;
    if (!RunId.safeParse(runId).success) throw new TutorOffboardingError("Removal preview not found.", 404);
    const body = ApplyBody.parse(await readJson(request)) as RemovalApplyInput;
    const run = await applyRemovalRun(viewer, runId, body, { db });
    return NextResponse.json({ run });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] removal apply failed", error, "The removal run could not be applied.");
  }
}
