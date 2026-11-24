import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { hiringPaperResults as p } from "@/lib/db/schema";
import { hiringError } from "@/lib/hiring/http";
import { markedFile } from "@/lib/hiring/marked-file";
import { paperCheckView } from "@/lib/hiring/paper-check";

export const maxDuration = 60;

/** Public: the head's link is the only access check (paperCheckView). The marked paper, as the dashboard shows it. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const db = getDb();
    const view = await paperCheckView((await params).token, db);
    const [paper] = await db.select().from(p).where(eq(p.id, view.id));
    return await markedFile(paper, db);
  } catch (error) {
    return hiringError(error);
  }
}
