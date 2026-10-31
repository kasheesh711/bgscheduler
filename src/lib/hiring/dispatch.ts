import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HiringError } from "./model";

export const deliveryRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.enum(["all", "bookings"]) }).strict(),
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
const digest = (body: string, timestamp: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`hiring-delivery\n${timestamp}\n${body}`)
    .digest();

export function deliveryAuthorization(
  body: string,
  now = Date.now(),
  secret = process.env.AUTH_SECRET,
) {
  if (!secret)
    throw new HiringError(
      503,
      "Hiring delivery authentication is not configured.",
    );
  const timestamp = String(Math.floor(now / 1000));
  return `HMAC-HIRING ${timestamp}.${digest(body, timestamp, secret).toString("hex")}`;
}
export function verifyDeliveryAuthorization(
  body: string,
  header: string | null,
  now = Date.now(),
  secret = process.env.AUTH_SECRET,
) {
  const parts = /^HMAC-HIRING (\d{10})\.([0-9a-f]{64})$/.exec(header ?? "");
  if (!secret || !parts || body.length > 2000) return false;
  const age = now / 1000 - Number(parts[1]);
  if (age < -30 || age > 120) return false;
  return timingSafeEqual(
    Buffer.from(parts[2], "hex"),
    digest(body, parts[1], secret),
  );
}
export async function requestDelivery(value: DeliveryRequest) {
  const body = JSON.stringify(deliveryRequestSchema.parse(value));
  const url = new URL(
    "/api/internal/hiring-delivery",
    process.env.APP_BASE_URL || "https://bgscheduler.vercel.app",
  );
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(
      "Hiring delivery requires the configured HTTPS application address.",
    );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: deliveryAuthorization(body),
    },
    body,
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : `Hiring delivery returned ${response.status}.`,
    );
  return result as { sent: number; receipt?: Record<string, unknown> };
}
