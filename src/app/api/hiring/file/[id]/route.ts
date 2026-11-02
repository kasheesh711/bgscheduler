import { get } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hiringAssessmentFiles as f } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { assessmentPath } from "@/lib/hiring/assessment-files";
import { hiringError } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";

export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireHiringAdmin();
    const id = z.uuid().parse((await context.params).id);
    const [file] = await getDb().select().from(f).where(eq(f.id, id));
    if (!file || file.status !== "ready") throw new HiringError(404, "File not found.");
    if (file.path !== assessmentPath(id)) throw new HiringError(409, "The stored file record is not valid, so the file was not opened.");
    const blob = await get(file.path, { access: "private", useCache: false });
    if (!blob || blob.statusCode !== 200) throw new HiringError(404, "The file is gone from storage.");
    const name = encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(blob.stream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(blob.blob.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'; sandbox",
        "Content-Disposition": `inline; filename*=UTF-8''${name}`,
      },
    });
  } catch (error) {
    return hiringError(error);
  }
}
