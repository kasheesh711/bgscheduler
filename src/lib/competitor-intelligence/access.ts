import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  COMPETITOR_INTELLIGENCE_ROUTE,
  hasCompetitorIntelligenceAccess,
} from "./access-policy";

export {
  COMPETITOR_INTELLIGENCE_ROUTE,
  hasCompetitorIntelligenceAccess,
};

export interface CompetitorIntelligenceUser {
  email: string;
  name: string;
  role: "admin";
}

export async function requireCompetitorIntelligenceSession(): Promise<CompetitorIntelligenceUser> {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  const name = session?.user?.name?.trim() || email;
  if (!email || !name) {
    throw new Error("Unauthorized");
  }
  if (!hasCompetitorIntelligenceAccess(session?.user?.allowedPages, session?.user?.role)) {
    throw new Error("Forbidden");
  }
  return { email, name, role: "admin" };
}

export function competitorIntelligenceErrorResponse(error: unknown, fallbackMessage: string) {
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
  if (error instanceof Error && error.message === "Forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  console.error(fallbackMessage, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallbackMessage },
    { status: 500 },
  );
}
