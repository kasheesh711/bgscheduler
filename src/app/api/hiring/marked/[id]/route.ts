import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hiringAssessmentFiles as f, hiringCandidates as c, hiringPaperResults as p } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { readAssessmentBytes } from "@/lib/hiring/assessment-files";
import { hiringError } from "@/lib/hiring/http";
import { buildMarkedPaper } from "@/lib/hiring/marked-paper";
import { HiringError } from "@/lib/hiring/model";

export const maxDuration = 60;

/** The scan of one paper result with the marking beside each page, built on request from the stored marks. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireHiringAdmin();
    const id = z.uuid().parse((await context.params).id);
    const db = getDb();
    const [paper] = await db.select().from(p).where(eq(p.id, id));
    if (!paper?.marks || !paper.fileId) throw new HiringError(404, "This paper has no marks or no scan yet.");
    const [file] = await db.select().from(f).where(eq(f.id, paper.fileId));
    const [candidate] = await db.select({ name: c.name }).from(c).where(eq(c.id, paper.candidateId));
    if (!file || file.status !== "ready" || !candidate) throw new HiringError(404, "The scan was not found.");
    const scan = await readAssessmentBytes(file, AbortSignal.timeout(30_000));
    const pdf = await buildMarkedPaper({ scan, candidate: candidate.name, subject: paper.subject, marks: paper.marks, aiMarks: paper.aiMarks, markSchemeUsed: paper.markSchemeUsed }).catch(() => {
      throw new HiringError(422, "The marked paper could not be made from this scan. Open the scan and the marks separately.");
    });
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'; sandbox",
        "Content-Disposition": `inline; filename="marked-paper.pdf"`,
      },
    });
  } catch (error) {
    return hiringError(error);
  }
}
