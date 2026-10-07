import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isDeliveryProblem, parseResendEvent, verifyResendSignature } from "../resend-webhook";

const rawSecret = Buffer.from("super-secret-bytes").toString("base64");
const secret = `whsec_${rawSecret}`;
const now = new Date("2026-10-07T03:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));
const body = JSON.stringify({ type: "email.bounced", created_at: "2026-10-07T02:59:58.000Z", data: { email_id: "re-msg-1", bounce: { type: "Permanent" } } });
const sign = (id: string, t: string, b: string) =>
  "v1," + createHmac("sha256", Buffer.from(rawSecret, "base64")).update(`${id}.${t}.${b}`).digest("base64");

describe("verifyResendSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body), body, now })).toBe(true);
  });
  it("accepts when one of several space-separated signatures matches", () => {
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: `v1,AAAA ${sign("msg_1", ts, body)}`, body, now })).toBe(true);
  });
  it("rejects bad signature", () => {
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body + " "), body, now })).toBe(false);
  });
  it("rejects stale timestamp (> 5 minutes)", () => {
    const old = String(Number(ts) - 301);
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: old, signature: sign("msg_1", old, body), body, now })).toBe(false);
  });
  it("rejects missing headers", () => {
    expect(verifyResendSignature({ secret, id: null, timestamp: ts, signature: "v1,x", body, now })).toBe(false);
  });
});

describe("parseResendEvent", () => {
  it("extracts type, message id, time and bounce type", () => {
    expect(parseResendEvent(body)).toEqual({
      type: "email.bounced", messageId: "re-msg-1",
      occurredAt: new Date("2026-10-07T02:59:58.000Z"), bounceType: "Permanent",
    });
  });
  it("returns null for junk", () => {
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe("isDeliveryProblem", () => {
  it("flags bounces and complaints only", () => {
    expect(isDeliveryProblem("email.bounced")).toBe(true);
    expect(isDeliveryProblem("email.complained")).toBe(true);
    expect(isDeliveryProblem("email.delivered")).toBe(false);
  });
});
