import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hiringError } from "@/lib/hiring/http";
import { HiringError, runtimeWritesAllowed } from "@/lib/hiring/model";
import { onboardingView } from "@/lib/hiring/onboarding";
import { hiringOrigin } from "@/lib/hiring/onboarding-config";
import { beginOnboardingLine, onboardingLineCookie, onboardingLineCookieOptions } from "@/lib/hiring/onboarding-line";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    if (new URL(request.url).origin !== hiringOrigin() || !runtimeWritesAllowed()) {
      throw new HiringError(503, "Open the onboarding link on the BeGifted site.");
    }
    const { token } = await params;
    const view = await onboardingView(getDb(), token);
    if (!view.submitted || view.linked) return NextResponse.redirect(new URL(`/hiring/onboarding/${token}`, hiringOrigin()));
    const { url, cookie } = beginOnboardingLine(token);
    const response = NextResponse.redirect(url);
    response.cookies.set(onboardingLineCookie, cookie, onboardingLineCookieOptions);
    return response;
  } catch (error) {
    return hiringError(error);
  }
}
