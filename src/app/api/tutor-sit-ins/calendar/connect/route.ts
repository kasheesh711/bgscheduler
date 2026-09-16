import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  assertSameOrigin,
  sitInError,
  sitInJson,
} from "@/lib/tutor-sit-ins/http";
import {
  beginCalendarOAuth,
  calendarConnectSchema,
  OAUTH_COOKIE,
  OAUTH_PATH,
} from "@/lib/tutor-sit-ins/calendar";
export async function POST(request: Request) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    const body = await request.text();
    const { provider } = calendarConnectSchema.parse(
      body.trim() ? JSON.parse(body) : {},
    );
    const result = beginCalendarOAuth(
      access.email,
      new URL(request.url).origin,
      provider,
    );
    const response = sitInJson({ url: result.url });
    response.cookies.set(OAUTH_COOKIE, result.cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      path: OAUTH_PATH,
      maxAge: 600,
    });
    return response;
  } catch (e) {
    return sitInError(e);
  }
}
