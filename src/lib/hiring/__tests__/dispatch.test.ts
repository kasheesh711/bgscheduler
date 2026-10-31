import { expect, it } from "vitest";
import {
  deliveryAuthorization,
  verifyDeliveryAuthorization,
  deliveryRequestSchema,
} from "../dispatch";

it("binds the worker signature to the complete body, short validity window and secret", () => {
  const body = JSON.stringify({ mode: "bookings" }),
    now = Date.parse("2026-10-31T00:00:00Z");
  const header = deliveryAuthorization(body, now, "test-secret");
  expect(
    verifyDeliveryAuthorization(body, header, now + 30000, "test-secret"),
  ).toBe(true);
  expect(
    verifyDeliveryAuthorization('{"mode":"all"}', header, now, "test-secret"),
  ).toBe(false);
  expect(
    verifyDeliveryAuthorization(body, header, now + 121000, "test-secret"),
  ).toBe(false);
  expect(verifyDeliveryAuthorization(body, header, now, "another-secret")).toBe(
    false,
  );
  expect(verifyDeliveryAuthorization(body, null, now, "test-secret")).toBe(
    false,
  );
});
it("does not accept arbitrary email or group recipients in a delivery test", () => {
  const base = {
    mode: "test",
    channel: "line",
    id: "00000000-0000-4000-8000-000000000001",
  };
  expect(
    deliveryRequestSchema.safeParse({
      ...base,
      lineUserId: "C" + "a".repeat(32),
    }).success,
  ).toBe(false);
  expect(
    deliveryRequestSchema.safeParse({ ...base, email: "someone@example.com" })
      .success,
  ).toBe(false);
  expect(
    deliveryRequestSchema.safeParse({
      ...base,
      lineUserId: "U" + "a".repeat(32),
    }).success,
  ).toBe(true);
});
