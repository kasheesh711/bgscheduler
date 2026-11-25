import { createHmac, timingSafeEqual } from "node:crypto";

// Short signed link tokens: base64url(body + 16-byte HMAC-SHA256). No "." in the token, so a reader
// can tell it from the older `payload.signature` JSON form, which stays readable until it expires.
const MAC_BYTES = 16;
const mac = (purpose: string, body: Buffer, secret: string) =>
  createHmac("sha256", secret).update(`${purpose}:`).update(body).digest().subarray(0, MAC_BYTES);

export function sealShortToken(purpose: string, body: Buffer, secret: string) {
  return Buffer.concat([body, mac(purpose, body, secret)]).toString("base64url");
}

/** The body, or null when the token is malformed or the signature is wrong. */
export function openShortToken(purpose: string, token: string, secret: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{1,600}$/.test(token)) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length <= MAC_BYTES || raw.toString("base64url") !== token) return null;
  const body = raw.subarray(0, raw.length - MAC_BYTES);
  return timingSafeEqual(raw.subarray(raw.length - MAC_BYTES), mac(purpose, body, secret)) ? body : null;
}
