import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import type { StudentPromotionActor } from "./data";

export interface StudentPromotionRouteContext {
  params: Promise<unknown>;
}

export async function requireStudentPromotionSession(): Promise<StudentPromotionActor> {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  const name = session?.user?.name?.trim() || email;
  if (!email || !name) throw new Error("Unauthorized");
  return { email, name };
}

export async function requireStudentPromotionRunId(context: StudentPromotionRouteContext): Promise<string> {
  const params = await context.params;
  if (!params || typeof params !== "object" || !("runId" in params)) {
    throw new Error("Student promotion run id is required");
  }
  const runId = (params as { runId?: unknown }).runId;
  if (typeof runId !== "string" || !runId.trim()) {
    throw new Error("Student promotion run id is required");
  }
  return runId;
}

export function studentPromotionErrorResponse(route: string, error: unknown, fallbackMessage: string) {
  if (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION"
  ) {
    throw error;
  }

  if (error instanceof Error && error.message === "Unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (error instanceof Error && /not found/i.test(error.message)) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  if (error instanceof Error && /(required|cannot|only|no verified|no pending|before July 1)/i.test(error.message)) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error(route, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallbackMessage },
    { status: 500 },
  );
}
