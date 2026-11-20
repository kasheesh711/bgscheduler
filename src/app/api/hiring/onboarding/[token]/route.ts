import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { submitOnboarding } from "@/lib/hiring/onboarding";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    requireSameOrigin(request);
    const view = await submitOnboarding(getDb(), (await params).token, await request.json());
    return NextResponse.json({ saved: true, ...view });
  } catch (error) {
    return hiringError(error);
  }
}
