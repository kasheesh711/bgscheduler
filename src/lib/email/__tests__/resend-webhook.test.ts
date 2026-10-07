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
  it("rejects malformed secrets that decode to a short key", () => {
    const forged = "v1," + createHmac("sha256", Buffer.alloc(0)).update(`msg_1.${ts}.${body}`).digest("base64");
    for (const bad of ["whsec_", "whsec_!!!!", ""]) {
      expect(verifyResendSignature({ secret: bad, id: "msg_1", timestamp: ts, signature: forged, body, now })).toBe(false);
    }
  });
  it("rejects a timestamp more than 300s in the future", () => {
    const future = String(Number(ts) + 301);
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: future, signature: sign("msg_1", future, body), body, now })).toBe(false);
  });
  it("accepts a timestamp exactly 300s old", () => {
    const edge = String(Number(ts) - 300);
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: edge, signature: sign("msg_1", edge, body), body, now })).toBe(true);
  });
  it("rejects a non-numeric timestamp", () => {
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: "abc", signature: sign("msg_1", "abc", body), body, now })).toBe(false);
  });
  it("handles same-length wrong signatures", () => {
    const wrong = sign("msg_1", ts, body + "x");
    const good = sign("msg_1", ts, body);
    expect(wrong.length).toBe(good.length);
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: `${wrong} ${good}`, body, now })).toBe(true);
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: wrong, body, now })).toBe(false);
  });
  it("rejects non-v1 candidates", () => {
    const value = sign("msg_1", ts, body).slice(3);
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: `v1a,${value} v2,${value}`, body, now })).toBe(false);
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
  it("survives hostile inputs", () => {
    for (const junk of ["null", "[]", "\"str\"", JSON.stringify({ type: 5 })]) {
      expect(parseResendEvent(junk)).toBeNull();
    }
    expect(parseResendEvent(JSON.stringify({ type: "email.sent", data: "x" }))).toEqual({ type: "email.sent", messageId: null, occurredAt: null, bounceType: null });
    expect(parseResendEvent(JSON.stringify({ type: "email.bounced", data: { bounce: null } }))?.bounceType).toBeNull();
    expect(parseResendEvent(JSON.stringify({ type: "email.sent", created_at: "garbage" }))?.occurredAt).toBeNull();
  });
  it("returns null for junk", () => {
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe("isDeliveryProblem", () => {
  it("flags bounces, complaints, delays and failures", () => {
    expect(isDeliveryProblem("email.bounced")).toBe(true);
    expect(isDeliveryProblem("email.complained")).toBe(true);
    expect(isDeliveryProblem("email.delivery_delayed")).toBe(true);
    expect(isDeliveryProblem("email.failed")).toBe(true);
    expect(isDeliveryProblem("email.delivered")).toBe(false);
  });
});
