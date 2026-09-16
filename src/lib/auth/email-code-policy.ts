import { isIP } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isPreviewEnvironment } from "@/lib/preview-policy";

export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_CODE_RESEND_MS = 60_000;
export const EMAIL_CODE_WINDOW_MS = 15 * 60_000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_COOKIE = "bgs-email-code";
export const emailCodeEmail = z.string().trim().toLowerCase().email().max(254);
export const emailCodeCredentials = z.object({
  email: emailCodeEmail,
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
});

export function emailCodeEnabled() {
  return process.env.AUTH_EMAIL_CODE_ENABLED === "true" && !isPreviewEnvironment();
}

export function emailCodeHash(kind: string, ...values: string[]) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("Authentication is not configured");
  return createHmac("sha256", secret).update(JSON.stringify(["email-code-v1", kind, ...values])).digest("hex");
}

export function equalDigest(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right)
    && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function emailCodeIp(request: Request) {
  // Vercel overwrites this header. Never trust caller-controlled forwarding headers.
  const value = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for")?.trim() : null;
  return value && isIP(value) ? value : "unknown";
}

export function emailCodeBinding(request: Request) {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(EMAIL_CODE_COOKIE + "="))?.slice(EMAIL_CODE_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function emailCodeSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin
    && request.headers.get("sec-fetch-site") !== "cross-site";
}
