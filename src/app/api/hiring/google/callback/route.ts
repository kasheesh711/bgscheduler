import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireHiringAdmin } from "@/lib/hiring/access";
import {
  appOrigin,
  finishGoogleConnection,
  GOOGLE_COOKIE,
} from "@/lib/hiring/google";
export async function GET(request: Request) {
  const jar = await cookies();
  try {
    const actor = await requireHiringAdmin();
    const params = new URL(request.url).searchParams;
    if (params.has("error")) throw new Error("Connection declined");
    await finishGoogleConnection(
      actor,
      params.get("code") || "",
      params.get("state") || "",
      jar.get(GOOGLE_COOKIE)?.value || "",
    );
    return NextResponse.redirect(appOrigin() + "/hiring?google=connected");
  } catch {
    return NextResponse.redirect(appOrigin() + "/hiring?google=failed");
  } finally {
    jar.set(GOOGLE_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/hiring/google",
      maxAge: 0,
    });
  }
}
