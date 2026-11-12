import { describe, expect, it } from "vitest";
import { callSlots } from "../availability";
import { businessDates, callBookingSchema, phoneSchema } from "../model";

// Wednesday 12:00 in Bangkok.
const now = new Date("2026-11-04T05:00:00Z");
const range = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

describe("callSlots", () => {
  it("offers every quarter hour from 09:00 to 17:45 on a free day", () => {
    const slots = callSlots(["2026-11-05"], [], now);
    expect(slots).toHaveLength(36);
    expect(slots[0]).toEqual({ date: "2026-11-05", start: "2026-11-05T02:00:00.000Z", end: "2026-11-05T02:15:00.000Z" });
    expect(slots.at(-1)).toEqual({ date: "2026-11-05", start: "2026-11-05T10:45:00.000Z", end: "2026-11-05T11:00:00.000Z" });
  });

  it("drops every time that a busy block touches, and keeps a time that only meets its edge", () => {
    // 10:00–10:20 in Bangkok takes 10:00 and 10:15. 09:45 ends at 10:00 and 10:30 starts after it, so both stay.
    const starts = callSlots(["2026-11-05"], [range("2026-11-05T03:00:00Z", "2026-11-05T03:20:00Z")], now).map((slot) => slot.start);
    expect(starts).toHaveLength(34);
    expect(starts).not.toContain("2026-11-05T03:00:00.000Z");
    expect(starts).not.toContain("2026-11-05T03:15:00.000Z");
    expect(starts).toContain("2026-11-05T02:45:00.000Z");
    expect(starts).toContain("2026-11-05T03:30:00.000Z");
    // A whole-day block leaves nothing.
    expect(callSlots(["2026-11-05"], [range("2026-11-04T17:00:00Z", "2026-11-05T17:00:00Z")], now)).toEqual([]);
  });

  it("never offers a time that has started", () => {
    // Thursday 09:15 exactly: 09:00 and 09:15 are gone, 09:30 is the first.
    expect(callSlots(["2026-11-05"], [], new Date("2026-11-05T02:15:00Z"))[0].start).toBe("2026-11-05T02:30:00.000Z");
    expect(callSlots(["2026-11-05"], [], new Date("2026-11-05T12:00:00Z"))).toEqual([]);
  });

  it("gets its dates from the business calendar: no weekend, no closed date, not today", () => {
    const dates = businessDates(now, ["2026-11-06"]);
    expect(dates).toEqual(["2026-11-05", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(new Set(callSlots(dates, [], now).map((slot) => slot.date))).toEqual(new Set(dates));
  });
});

describe("phoneSchema", () => {
  it("keeps the digits and an optional leading plus", () => {
    expect(phoneSchema.parse(" +66 (81) 234-5678 ")).toBe("+66812345678");
    expect(phoneSchema.parse("081.234.5678")).toBe("0812345678");
  });
  it.each(["", "call me", "12345", "+", "0812345678x", "++66812345678", "1".repeat(16), "+66 81 234 5678 ext 9"])("refuses %j", (value) => {
    expect(phoneSchema.safeParse(value).success).toBe(false);
  });
  it("is required for a call booking, and the booking takes no other field", () => {
    const start = "2026-11-05T02:00:00.000Z";
    expect(callBookingSchema.parse({ start, phone: "0812345678", move: true })).toEqual({ start, phone: "0812345678", move: true });
    expect(callBookingSchema.safeParse({ start }).success).toBe(false);
    expect(callBookingSchema.safeParse({ start, phone: "0812345678", subject: "Mathematics" }).success).toBe(false);
    expect(callBookingSchema.safeParse({ start: "tomorrow", phone: "0812345678" }).success).toBe(false);
  });
});
