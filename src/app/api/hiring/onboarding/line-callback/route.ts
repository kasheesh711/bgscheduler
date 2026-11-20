import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { linkOnboardingLine, onboardingView } from "@/lib/hiring/onboarding";
import { hiringOrigin } from "@/lib/hiring/onboarding-config";
import { onboardingLineCookie, onboardingLineCookieOptions, readOnboardingLineSession, verifyOnboardingLine } from "@/lib/hiring/onboarding-line";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const session = origin === hiringOrigin()
    ? readOnboardingLineSession(request.cookies.get(onboardingLineCookie)?.value, searchParams.get("state"))
    : null;
  if (!session) return new NextResponse("This LINE sign-in expired. Open your onboarding link and try again.", { status: 400 });
  const back = new URL(`/hiring/onboarding/${session.token}`, hiringOrigin());
  try {
    const code = searchParams.get("code");
    if (!code || code.length > 2048) throw new Error("LINE sign-in did not complete.");
    const db = getDb();
    const view = await onboardingView(db, session.token);
    if (view.submitted && !view.linked) await linkOnboardingLine(db, session.token, await verifyOnboardingLine(code, session));
  } catch {
    back.searchParams.set("line", "review");
  }
  const response = NextResponse.redirect(back);
  response.cookies.set(onboardingLineCookie, "", { ...onboardingLineCookieOptions, maxAge: 0 });
  return response;
}
