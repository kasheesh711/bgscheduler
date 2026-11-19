import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hiringPaperResults as p } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError } from "@/lib/hiring/http";
import { markedFile } from "@/lib/hiring/marked-file";

export const maxDuration = 60;

/** The scan of one paper result with the marking beside each page, built on request from the stored marks. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireHiringAdmin();
    const id = z.uuid().parse((await context.params).id);
    const db = getDb();
    const [paper] = await db.select().from(p).where(eq(p.id, id));
    return await markedFile(paper, db);
  } catch (error) {
    return hiringError(error);
  }
}
