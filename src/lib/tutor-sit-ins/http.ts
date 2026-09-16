import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { SitInError } from "./model";

export function sitInJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
export function sitInError(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "digest" in error &&
    error.digest === "HANGING_PROMISE_REJECTION"
  )
    throw error;
  if (error instanceof SitInError)
    return sitInJson({ error: error.message, code: error.code }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError)
    return sitInJson(
      { error: "Check the submitted fields and try again." },
      400,
    );
  // Drizzle wraps PostgreSQL errors. Keep constraints private while returning
  // a retryable conflict for a competing insert or serializable transaction.
  let cause: unknown = error;
  for (
    let depth = 0;
    depth < 4 && cause && typeof cause === "object";
    depth++
  ) {
    if (
      "code" in cause &&
      ["23505", "23514", "40001", "40P01"].includes(String(cause.code))
    )
      return sitInJson(
        {
          error:
            "This record changed or conflicts with another booking. Refresh and try again.",
        },
        409,
      );
    cause = "cause" in cause ? cause.cause : undefined;
  }
  console.error(
    "Tutor sit-in request failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return sitInJson(
    { error: "This request could not be completed. Refresh and try again." },
    500,
  );
}
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    throw new SitInError(403, "Request origin could not be verified.");
}
