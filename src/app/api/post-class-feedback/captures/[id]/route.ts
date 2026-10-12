import { get } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { postClassFeedbackCaptures } from "@/lib/db/schema";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { PostClassNotFoundError } from "@/lib/post-class-feedback/errors";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePostClassCapability("viewer");
    const id = z.uuid().parse((await context.params).id);
    const [capture] = await getDb().select().from(postClassFeedbackCaptures).where(eq(postClassFeedbackCaptures.id, id));
    if (!capture?.pathname || capture.uploadStatus !== "ready") throw new PostClassNotFoundError("Screenshot is not available.");
    const image = await get(capture.pathname, { access: "private" });
    if (!image || image.statusCode !== 200) throw new PostClassNotFoundError("Screenshot is not available.");
    return new Response(image.stream, { headers: { "Content-Type": capture.mime!, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline" } });
  } catch (error) { return postClassFeedbackErrorResponse("GET screenshot", error, "Could not open the screenshot."); }
}
