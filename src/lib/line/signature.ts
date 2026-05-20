import { createHmac, timingSafeEqual } from "crypto";

export function verifyLineSignature(input: {
  rawBody: string;
  channelSecret: string | undefined;
  signature: string | null;
}): boolean {
  const secret = input.channelSecret?.trim();
  const signature = input.signature?.trim();
  if (!secret || !signature) return false;

  const expected = createHmac("sha256", secret)
    .update(input.rawBody)
    .digest("base64");

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
