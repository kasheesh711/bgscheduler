import { z } from "zod";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { demoFile } from "@/lib/hiring/demo";
import { demoReviewDocument } from "@/lib/hiring/demo-packet";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { ITEM_MAX, RUBRIC_ITEMS, type MockRubric, type RubricItem } from "@/lib/hiring/marking-sheet";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };
const input = z.object({
  draft: z.boolean(),
  behavioral: z.string().max(10000),
  offer: z.string().max(10000),
  rubric: z.object({
    items: z.partialRecord(z.enum(RUBRIC_ITEMS as [RubricItem, ...RubricItem[]]), z.number().min(0).max(ITEM_MAX).nullable()),
    comments: z.string().max(4000),
    stressTest: z.object({ listens: z.boolean(), explains: z.boolean(), plan: z.boolean() }).optional(),
    checksDone: z.boolean().optional(),
  }),
});

/** Demo mode only (`/hiring?demo=1`): the made-up candidate's packet in the real design. No database, nothing saved. */
export async function POST(request: Request) {
  try {
    await requireHiringAdmin();
    requireSameOrigin(request);
    const value = input.parse(await request.json());
    return new Response(await demoReviewDocument({ ...value, rubric: value.rubric as MockRubric }, new URL(request.url).origin), {
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
    });
  } catch (error) {
    return hiringError(error);
  }
}

/** The made-up résumé and paper that the demo packet links to. */
export async function GET(request: Request) {
  try {
    await requireHiringAdmin();
    return new Response(demoFile(new URL(request.url).searchParams.get("file") ?? ""), { headers: { ...headers, "Content-Type": "application/pdf" } });
  } catch (error) {
    return hiringError(error);
  }
}
