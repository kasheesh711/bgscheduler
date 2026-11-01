import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HiringError } from "./model";
export function hiringError(error: unknown) {
  const code =
    (error as { code?: string; cause?: { code?: string } } | null)?.cause
      ?.code ?? (error as { code?: string } | null)?.code;
  if (code === "23P01")
    return NextResponse.json(
      { error: "This appointment was just taken. Please choose another time." },
      { status: 409 },
    );
  if (error instanceof HiringError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    // A rule written for Kevin is a full sentence. A stock range message needs the setting's name to be useful.
    const where = issue && issue.code !== "custom" && issue.path.length ? `${issue.path.join(" ")}: ` : "";
    return NextResponse.json(
      { error: issue ? `${where}${issue.message}` : "Invalid input." },
      { status: 400 },
    );
  }
  console.error(
    "Hiring request failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return NextResponse.json(
    {
      error:
        "Hiring could not complete this request. Check setup and try again.",
    },
    { status: 503 },
  );
}
export function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new HiringError(403, "Open this form from Scheduling.");
}
