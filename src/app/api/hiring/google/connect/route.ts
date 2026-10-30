import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { beginGoogleConnection, GOOGLE_COOKIE } from "@/lib/hiring/google";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
export async function POST(request: Request) {
  try {
    const actor = await requireHiringAdmin();
    requireSameOrigin(request);
    const { cookie, url } = beginGoogleConnection(
      actor,
      new URL(request.url).origin,
    );
    (await cookies()).set(GOOGLE_COOKIE, cookie, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/hiring/google",
      maxAge: 600,
    });
    return NextResponse.json({ url });
  } catch (error) {
    return hiringError(error);
  }
}
