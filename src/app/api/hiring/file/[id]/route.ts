import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hiringAssessmentFiles as f } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { assessmentFileResponse } from "@/lib/hiring/assessment-files";
import { hiringError } from "@/lib/hiring/http";

export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireHiringAdmin();
    const id = z.uuid().parse((await context.params).id);
    const [file] = await getDb().select().from(f).where(eq(f.id, id));
    return await assessmentFileResponse(file);
  } catch (error) {
    return hiringError(error);
  }
}
