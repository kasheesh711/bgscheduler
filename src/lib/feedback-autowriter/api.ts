import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { sqlStateOf } from "./db-errors";

/** A request the review API refuses on purpose (unknown class, a stale pin, an invalid verdict). */
export class AutowriterReviewError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409) {
    super(message);
    this.name = "AutowriterReviewError";
  }
}

/**
 * Shape-B error mapper for the autowriter review routes. Unknown errors are never serialized: database errors
 * can carry query parameters, and those hold lesson feedback.
 */
export function feedbackAutowriterErrorResponse(route: string, error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "digest" in error &&
    (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION") {
    throw error;
  }
  if (error instanceof AdminUsersAccessError) {
    return NextResponse.json(
      { error: error.status === 403 ? "Only Kevin can record autowriter verdicts or acknowledge incidents." : error.message },
      { status: error.status },
    );
  }
  if (error instanceof AutowriterReviewError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "The request payload is invalid.", issues: error.issues }, { status: 400 });
  }
  console.error(route, { errorName: error instanceof Error ? error.name : "UnknownError", sqlState: sqlStateOf(error) });
  return NextResponse.json({ error: fallback }, { status: 500 });
}
