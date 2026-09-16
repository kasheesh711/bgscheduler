import { NextRequest, NextResponse } from "next/server";
import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  appOrigin,
  finishCalendarOAuth,
  OAUTH_COOKIE,
  OAUTH_PATH,
  verifyOAuthState,
} from "@/lib/tutor-sit-ins/calendar";
export async function GET(request: NextRequest) {
  let success = false;
  try {
    const access = await requireSitInAccess();
    const state = verifyOAuthState(
      request.cookies.get(OAUTH_COOKIE)?.value || "",
      request.nextUrl.searchParams.get("state") || "",
      access.email,
      Date.now(),
      "microsoft",
    );
    const code = request.nextUrl.searchParams.get("code");
    if (!code || request.nextUrl.searchParams.has("error"))
      throw new Error("Consent not completed");
    await finishCalendarOAuth(access.email, code, state);
    success = true;
  } catch {
    /* OAuth codes and provider errors never enter logs or the return URL. */
  }
  const response = NextResponse.redirect(
    appOrigin() +
      "/tutor-sit-ins?calendar=" +
      (success ? "connected" : "error"),
  );
  response.cookies.set(OAUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: OAUTH_PATH,
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
