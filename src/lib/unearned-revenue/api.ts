import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { UnearnedRevenueAccessError } from "./access";
import { UnearnedRevenueDataError } from "./data";

function isNextControlFlowError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.startsWith("NEXT_REDIRECT") || error.message.startsWith("NEXT_HTTP_ERROR_FALLBACK"));
}

export function unearnedRevenueErrorResponse(
  context: string,
  error: unknown,
  fallback = "Unearned revenue request failed",
): NextResponse {
  if (isNextControlFlowError(error)) throw error;
  if (error instanceof UnearnedRevenueAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof UnearnedRevenueDataError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid request", issues: error.issues },
      { status: 400 },
    );
  }
  console.error(context, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 500 },
  );
}
