import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { PostClassAccessError } from "./access";

import {
  PostClassConflictError,
  PostClassNotFoundError,
  PostClassValidationError,
} from "./errors";

export function postClassFeedbackErrorResponse(route: string, error: unknown, fallback: string) {
  if (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION"
  ) {
    throw error;
  }

  if (error instanceof PostClassAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof Error && error.message === "Unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (error instanceof PostClassValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "The request payload is invalid.", issues: error.issues }, { status: 400 });
  }
  if (error instanceof PostClassNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof PostClassConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  // Never serialize an unknown error object: database/HTTP clients can attach
  // request parameters or response bodies containing private feedback text.
  console.error(route, {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    { error: fallback },
    { status: 500 },
  );
}
