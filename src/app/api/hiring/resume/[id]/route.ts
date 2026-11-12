import { z } from "zod";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError } from "@/lib/hiring/http";
import { resumeResponse } from "@/lib/hiring/resume-files";

export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireHiringAdmin();
    return await resumeResponse(z.uuid().parse((await context.params).id));
  } catch (error) {
    return hiringError(error);
  }
}
