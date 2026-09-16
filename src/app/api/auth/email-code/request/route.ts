import { NextResponse } from "next/server";
import { z } from "zod";
import { EMAIL_CODE_COOKIE, EMAIL_CODE_TTL_MS, emailCodeEmail, emailCodeEnabled, emailCodeSameOrigin } from "@/lib/auth/email-code-policy";
import { EmailCodeLimitError, emailCodeSenderKeys, requestEmailCode } from "@/lib/auth/email-code";

export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  if (!emailCodeSameOrigin(request)) return NextResponse.json({ error: "Open sign-in from this website." }, { status: 403, headers });
  if (!emailCodeEnabled() || !emailCodeSenderKeys().length)
    return NextResponse.json({ error: "Email sign-in is temporarily unavailable. Please try again later." }, { status: 503, headers });
  try {
    if (Number(request.headers.get("content-length")) > 2048) return NextResponse.json({ error: "Request too large" }, { status: 413, headers });
    const { email } = z.object({ email: emailCodeEmail }).strict().parse(await request.json());
    const result = await requestEmailCode(email, request);
    const response = NextResponse.json({ challengeId: result.challengeId, expiresIn: 600, retryAfter: 60,
      message: "If this email has access, a sign-in code is on its way. Check your inbox and junk folder." }, { status: 202, headers });
    response.cookies.set(EMAIL_CODE_COOKIE, result.binding, { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/api/auth", maxAge: EMAIL_CODE_TTL_MS / 1000 });
    return response;
  } catch (error) {
    if (error instanceof EmailCodeLimitError) return NextResponse.json({ error: error.message, retryAfter: error.retryAfter }, { status: 429, headers: { ...headers, "Retry-After": String(error.retryAfter) } });
    if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400, headers });
    console.error("Email login request failed");
    return NextResponse.json({ error: "Email sign-in is temporarily unavailable. Please try again later." }, { status: 503, headers });
  }
}
