import { creditControlActive, CREDIT_CONTROL_RETIRED, CREDIT_CONTROL_RETIRED_MESSAGE } from "./mode";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import type { AppSessionUser } from "@/types/credit-control";

export async function requireCreditControlSession(): Promise<AppSessionUser> {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  const name = session?.user?.name?.trim() || email;

  if (!email || !name) {
    throw new Error("Unauthorized");
  }

  if (!creditControlActive()) throw new Error(CREDIT_CONTROL_RETIRED);
  return { email, name };
}

export function creditControlErrorResponse(route: string, error: unknown, fallbackMessage: string) {
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

  if (error instanceof Error && error.message === CREDIT_CONTROL_RETIRED) {
    return NextResponse.json({ error: CREDIT_CONTROL_RETIRED_MESSAGE, code: CREDIT_CONTROL_RETIRED }, { status: 503 });
  }
  console.error(route, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallbackMessage },
    { status: 500 },
  );
}
