import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AutowriterReviewError, feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { isMissingRelationError } from "@/lib/feedback-autowriter/db-errors";
import type { AutowriterReviewUnavailable } from "@/lib/feedback-autowriter/review-data";
import { AUTOWRITER_TUTORS } from "@/lib/feedback-autowriter/roster";
import { ALL_TUTORS, TREND_RANGES, loadAutowriterTrends } from "@/lib/feedback-autowriter/trends";

const TUTOR_KEYS: ReadonlySet<string> = new Set([ALL_TUTORS, ...AUTOWRITER_TUTORS.map((tutor) => tutor.canonicalKey)]);

const TrendsQuery = z.object({
  days: z.coerce.number().pipe(z.literal(TREND_RANGES)).default(14),
  /** `*` for all tutors, or a roster tutor's key. */
  tutor: z.string().refine((value) => TUTOR_KEYS.has(value), "Not a roster tutor.").default(ALL_TUTORS),
});

/**
 * Daily trend series of the autowriter dashboard (read-only): `?days=14|30|90&tutor=<tutorKey|*>`. Admin role only,
 * as the dashboard route; page scope is enforced by the proxy. An invalid range or an unknown tutor is a 400. Before
 * migration 0101 (a review table missing, SQLSTATE 42P01) the payload is `{ available: false, reason:
 * "review_tables_missing" }` with HTTP 200, as the review route's (an optional table, not a failure); any other error
 * is a 500.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.email) throw new AutowriterReviewError("Unauthorized", 401);
    if (session.user.role !== "admin") throw new AutowriterReviewError("Forbidden", 403);
    const parsed = TrendsQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    try {
      return NextResponse.json(await loadAutowriterTrends(getDb(), { days: parsed.data.days, tutorKey: parsed.data.tutor }));
    } catch (error) {
      if (!isMissingRelationError(error)) throw error;
      const missing: AutowriterReviewUnavailable = { available: false, reason: "review_tables_missing" };
      return NextResponse.json(missing);
    }
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] trends load failed", error, "The autowriter trends could not load.");
  }
}
