import { describe, expect, it } from "vitest";
import { rejectionSendAt } from "../decisions";

describe("rejectionSendAt", () => {
  it("holds a morning rejection until 18:00 Bangkok the same day", () => {
    expect(rejectionSendAt(new Date("2026-11-26T02:00:00Z"))?.toISOString()).toBe("2026-11-26T11:00:00.000Z");
  });
  it("sends at once at or after 18:00 Bangkok", () => {
    expect(rejectionSendAt(new Date("2026-11-26T11:00:00Z"))).toBeNull();
    expect(rejectionSendAt(new Date("2026-11-26T16:30:00Z"))).toBeNull();
  });
  it("uses the Bangkok day just after midnight", () => {
    expect(rejectionSendAt(new Date("2026-11-26T17:30:00Z"))?.toISOString()).toBe("2026-11-27T11:00:00.000Z");
  });
});
