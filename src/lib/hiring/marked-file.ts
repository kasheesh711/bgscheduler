import { eq } from "drizzle-orm";
import { type Database } from "@/lib/db";
import { hiringAssessmentFiles as f, hiringCandidates as c, hiringPaperResults as p } from "@/lib/db/schema";
import { readAssessmentBytes } from "./assessment-files";
import { buildMarkedPaper } from "./marked-paper";
import { HiringError } from "./model";

export async function markedFile(paper: typeof p.$inferSelect | undefined, db: Database) {
  if (!paper?.marks || !paper.fileId) throw new HiringError(404, "This paper has no marks or no scan yet.");
  const [file] = await db.select().from(f).where(eq(f.id, paper.fileId));
  const [candidate] = await db.select({ name: c.name }).from(c).where(eq(c.id, paper.candidateId));
  if (!file || file.status !== "ready" || file.kind !== "paper_scan" || file.candidateId !== paper.candidateId || !candidate) throw new HiringError(404, "The scan was not found.");
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
}
