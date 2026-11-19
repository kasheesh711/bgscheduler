import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { hiringPaperResults as p } from "@/lib/db/schema";
import { hiringError } from "@/lib/hiring/http";
import { markedFile } from "@/lib/hiring/marked-file";
import { briefMock } from "@/lib/hiring/service";

export const maxDuration = 60;

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const db = getDb();
    const mock = await briefMock((await params).token, db, new Date());
    const [paper] = await db.select().from(p).where(and(eq(p.candidateId, mock.candidateId), eq(p.subject, mock.subjects[0]), eq(p.status, "done")));
    return await markedFile(paper, db);
  } catch (error) {
    return hiringError(error);
  }
}
