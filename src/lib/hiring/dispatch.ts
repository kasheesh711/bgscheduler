import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HiringError, RESUME_TYPES, type ResumeExtension } from "./model";

export const deliveryRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.enum(["all", "bookings"]) }).strict(),
  // One waiting pre-screen form and nothing else: the controlled first send.
  z
    .object({
      mode: z.literal("one"),
      key: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:pre-screen$/),
    })
    .strict(),
  z
    .object({
      mode: z.literal("test"),
      channel: z.enum(["email", "line", "calendar"]),
      id: z.uuid(),
      lineUserId: z
        .string()
        .regex(/^U[0-9a-f]{32}$/)
        .optional(),
    })
    .strict(),
]);
export type DeliveryRequest = z.infer<typeof deliveryRequestSchema>;
export const resumeUploadRequestSchema = z
  .object({
    candidateId: z.uuid(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    extension: z.enum(Object.keys(RESUME_TYPES) as [ResumeExtension, ...ResumeExtension[]]),
  })
  .strict();
export type ResumeUploadRequest = z.infer<typeof resumeUploadRequestSchema>;

// Each signed route has its own context, so a signature for one cannot be replayed on another.
const DELIVERY = "hiring-delivery";
const RESUME_UPLOAD = "hiring-resume-upload";
const digest = (context: string, body: string, timestamp: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`${context}\n${timestamp}\n${body}`)
    .digest();

function authorization(context: string, body: string, now: number, secret: string | undefined) {
  if (!secret)
    throw new HiringError(
      503,
      "Hiring request authentication is not configured.",
    );
  const timestamp = String(Math.floor(now / 1000));
  return `HMAC-HIRING ${timestamp}.${digest(context, body, timestamp, secret).toString("hex")}`;
}
function verify(context: string, body: string, header: string | null, now: number, secret: string | undefined) {
  const parts = /^HMAC-HIRING (\d{10})\.([0-9a-f]{64})$/.exec(header ?? "");
  if (!secret || !parts || body.length > 2000) return false;
  const age = now / 1000 - Number(parts[1]);
  if (age < -30 || age > 120) return false;
  return timingSafeEqual(
    Buffer.from(parts[2], "hex"),
    digest(context, body, parts[1], secret),
  );
}
export const deliveryAuthorization = (body: string, now = Date.now(), secret = process.env.AUTH_SECRET) =>
  authorization(DELIVERY, body, now, secret);
export const verifyDeliveryAuthorization = (
  body: string,
  header: string | null,
  now = Date.now(),
  secret = process.env.AUTH_SECRET,
) => verify(DELIVERY, body, header, now, secret);
export const resumeUploadAuthorization = (body: string, now = Date.now(), secret = process.env.AUTH_SECRET) =>
  authorization(RESUME_UPLOAD, body, now, secret);
export const verifyResumeUploadAuthorization = (
  body: string,
  header: string | null,
  now = Date.now(),
  secret = process.env.AUTH_SECRET,
) => verify(RESUME_UPLOAD, body, header, now, secret);

/** Posts a signed body from the Mac (the worker, or a one-time pass that stores files) to the configured HTTPS application address. */
async function signedPost(route: string, body: string, signature: string) {
  const url = new URL(route, process.env.APP_BASE_URL || "https://bgscheduler.vercel.app");
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(
      "Hiring requests need the configured HTTPS application address.",
    );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: signature,
    },
    body,
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : `Hiring request returned ${response.status}.`,
    );
  return result;
}
export async function requestDelivery(value: DeliveryRequest) {
  const body = JSON.stringify(deliveryRequestSchema.parse(value));
  return (await signedPost("/api/internal/hiring-delivery", body, deliveryAuthorization(body))) as {
    sent: number;
    receipt?: Record<string, unknown>;
  };
}
/** A short-lived Blob token for one exact path. The Mac holds no Blob key. */
export async function requestResumeUploadToken(value: ResumeUploadRequest) {
  const body = JSON.stringify(resumeUploadRequestSchema.parse(value));
  const result = await signedPost("/api/internal/hiring-resume-upload", body, resumeUploadAuthorization(body));
  return result.token as string;
}
