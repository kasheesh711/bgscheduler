import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AutowriterReviewError, feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { loadAutowriterReview } from "@/lib/feedback-autowriter/review-data";

/**
 * Quality and Review tabs of the autowriter dashboard (read-only). Admin role only: the payload carries the
 * posted feedback text. Page scope is enforced by the proxy as for the dashboard route. Before migration 0101 the
 * payload is `{ available: false, reason: "review_tables_missing" }` with HTTP 200 (an optional table, not a
 * failure); any other error is a 500.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) throw new AutowriterReviewError("Unauthorized", 401);
    if (session.user.role !== "admin") throw new AutowriterReviewError("Forbidden", 403);
    return NextResponse.json(await loadAutowriterReview(getDb()));
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] review load failed", error, "The autowriter review could not load.");
  }
}
