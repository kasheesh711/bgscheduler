import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { tokenKindSchema, HiringError, VISIT_LINK_DAYS } from "./model";
import { openShortToken, sealShortToken } from "../short-token";

// A visit link lives VISIT_LINK_DAYS (model.ts). `inviteExpiresAt` holds the same second, so a new link ends the old one.
export { VISIT_LINK_DAYS };

export function bookingToken(
  id: string,
  kind: (typeof tokenKindSchema.options)[number],
  expires: Date,
  secret = process.env.AUTH_SECRET,
) {
  if (!secret) throw new HiringError(503, "Booking links are not configured.");
  z.uuid().parse(id);
  // Body: booking uuid (16 bytes) + kind index (1) + expiry seconds (4). 50 characters in all.
  const body = Buffer.alloc(21);
  Buffer.from(id.replace(/-/g, ""), "hex").copy(body);
  body[16] = tokenKindSchema.options.indexOf(kind);
  body.writeUInt32BE(Math.floor(expires.getTime() / 1000), 17);
  return sealShortToken("hiring-link", body, secret);
}
function readShort(token: string, secret: string) {
  const body = openShortToken("hiring-link", token, secret);
  if (body?.length !== 21) throw new Error();
  const hex = body.subarray(0, 16).toString("hex");
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    kind: tokenKindSchema.options[body[16]],
    exp: body.readUInt32BE(17),
  };
}
export function readBookingToken(
  token: string,
  now = new Date(),
  secret = process.env.AUTH_SECRET,
) {
  try {
    if (!secret || token.length > 600) throw new Error();
    if (!token.includes(".")) {
      const value = z.object({ id: z.uuid(), kind: tokenKindSchema, exp: z.number().int() }).parse(readShort(token, secret));
      if (value.exp <= now.getTime() / 1000) throw new Error();
      return value;
    }
    // Older `payload.signature` links, sent before 25 Nov 2026, stay valid until they expire.
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
      .object({ id: z.uuid(), kind: tokenKindSchema, exp: z.number().int() })
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
