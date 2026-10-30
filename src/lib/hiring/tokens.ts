import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { kindSchema, HiringError, type InterviewKind } from "./model";

export function bookingToken(
  id: string,
  kind: InterviewKind,
  expires: Date,
  secret = process.env.AUTH_SECRET,
) {
  if (!secret) throw new HiringError(503, "Booking links are not configured.");
  const payload = Buffer.from(
    JSON.stringify({ id, kind, exp: Math.floor(expires.getTime() / 1000) }),
  ).toString("base64url");
  return (
    payload +
    "." +
    createHmac("sha256", secret).update(payload).digest("base64url")
  );
}
export function readBookingToken(
  token: string,
  now = new Date(),
  secret = process.env.AUTH_SECRET,
) {
  try {
    if (!secret || token.length > 600) throw new Error();
    const [payload, signature, extra] = token.split(".");
    const expected = createHmac("sha256", secret).update(payload).digest();
    const actual = Buffer.from(signature ?? "", "base64url");
    if (
      extra ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new Error();
    const value = z
      .object({ id: z.uuid(), kind: kindSchema, exp: z.number().int() })
      .strict()
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    if (value.exp <= now.getTime() / 1000) throw new Error();
    return value;
  } catch {
    throw new HiringError(
      404,
      "This booking link is invalid or has expired. Contact BeGifted for a new link.",
    );
  }
}
