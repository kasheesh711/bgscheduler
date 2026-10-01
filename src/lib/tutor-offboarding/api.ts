import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { sqlStateOf } from "@/lib/db/sql-state";
import { isMissingSchemaError, TutorOffboardingError } from "./errors";

/**
 * Shape B error mapper for the Tutor Offboarding routes. Unknown errors are never serialized: database errors can
 * carry query parameters, and those hold admin notes and emails.
 */
export function tutorOffboardingErrorResponse(route: string, error: unknown, fallback: string): NextResponse {
  if (typeof error === "object" && error !== null && (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION") {
    throw error;
  }
  if (error instanceof TutorOffboardingError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof AdminUsersAccessError) {
    return NextResponse.json(
      { error: error.status === 403 ? "Only the website owner can change who can remove tutors." : error.message },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "The request payload is invalid.", issues: error.issues }, { status: 400 });
  }
  if (isMissingSchemaError(error)) {
    return NextResponse.json({ error: "Tutor Offboarding is not set up yet (database migration pending)." }, { status: 503 });
  }
  console.error(route, { errorName: error instanceof Error ? error.name : "UnknownError", sqlState: sqlStateOf(error) });
  return NextResponse.json({ error: fallback }, { status: 500 });
}
