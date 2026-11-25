import { getDb } from "@/lib/db";
import { hiringError } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";
import { printItems, readPrintToken, renderCovers } from "@/lib/hiring/print-pack";

export const maxDuration = 60;

/** Public: the print link is the only access check. One cover page for each paper test still to come. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { date, candidateId } = readPrintToken((await params).token);
    const items = await printItems(getDb(), date, candidateId);
    if (!items.length) throw new HiringError(404, "No paper tests are left to print for this day.");
    return new Response(new Uint8Array(await renderCovers(items)), {
      headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        // The page joins cover i to paper i, so it checks this order against its own list.
        "X-Print-Order": items.map((i) => `${i.candidateId}@${i.start.getTime()}`).join(",") },
    });
  } catch (error) {
    return hiringError(error);
  }
}
