import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hiringAssessmentFiles as f } from "@/lib/db/schema";
import { assessmentFileResponse } from "@/lib/hiring/assessment-files";
import { hiringError } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";
import { printItems, readPrintToken } from "@/lib/hiring/print-pack";

export const maxDuration = 60;

/** Public: the print link opens only the question papers of that link's paper tests. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; fileId: string }> }) {
  try {
    const { token, fileId } = await params;
    const { date, candidateId } = readPrintToken(token);
    const id = z.uuid().parse(fileId);
    const db = getDb();
    if (!(await printItems(db, date, candidateId)).some((item) => item.fileId === id)) throw new HiringError(404, "File not found.");
    const [file] = await db.select().from(f).where(eq(f.id, id));
    return await assessmentFileResponse(file);
  } catch (error) {
    return hiringError(error);
  }
}
