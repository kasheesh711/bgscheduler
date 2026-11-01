import { get } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hiringCandidates as c } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";
import { cleanResumeName, storedResume } from "@/lib/hiring/resume-files";

export const maxDuration = 60;
const GONE = "The original résumé file is gone from storage. The extracted text stays in this panel.";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireHiringAdmin();
    const id = z.uuid().parse((await context.params).id);
    const [row] = await getDb()
      .select({ path: c.resumePath, name: c.resumeName, type: c.resumeType, storedAt: c.resumeStoredAt })
      .from(c)
      .where(eq(c.id, id));
    if (!row) throw new HiringError(404, "Candidate not found.");
    if (!row.path)
      throw new HiringError(
        404,
        row.storedAt
          ? "The original résumé was deleted by the retention rule. The extracted text stays in this panel."
          : "No original résumé file is stored for this candidate.",
      );
    const stored = storedResume(id, row.path, row.type);
    if (!stored) throw new HiringError(409, "The stored résumé record is not valid, so the file was not opened.");
    const blob = await get(stored.path, { access: "private", useCache: false });
    if (!blob || blob.statusCode !== 200) throw new HiringError(404, GONE);
    const name = encodeURIComponent(cleanResumeName(row.name ?? "", stored.extension)).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(blob.stream, {
      headers: {
        "Content-Type": stored.type,
        "Content-Length": String(blob.blob.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `${stored.extension === "pdf" ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
      },
    });
  } catch (error) {
    return hiringError(error);
  }
}
