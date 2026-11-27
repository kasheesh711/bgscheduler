import { z } from "zod";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError } from "@/lib/hiring/http";
import { readPortfolio } from "@/lib/hiring/portfolio";

export const maxDuration = 60;

/** The Art & Design portfolio a candidate uploaded on the booking page. Staff with Hiring access only. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireHiringAdmin();
    const id = z.uuid().parse((await context.params).id);
    const file = await readPortfolio(id);
    return new Response(file.stream, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        // The file comes from outside, so it gets no scripts and no frame of another site.
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'; sandbox",
        // A download, because the sandbox rule stops the browser's own PDF viewer.
        "Content-Disposition": `attachment; filename="portfolio-${id}.${file.extension}"`,
      },
    });
  } catch (error) {
    return hiringError(error);
  }
}
