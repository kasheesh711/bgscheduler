import { expect, it } from "vitest";
import { contactLine, lineSlot, lineWho, recruitmentParts, recruitmentWeek } from "../recruitment";

it("starts on 16 November at 09:00 Bangkok and uses local Monday boundaries", () => {
  expect(recruitmentWeek(new Date("2026-11-09T09:00:00+07:00"))).toBeNull();
  expect(recruitmentWeek(new Date("2026-11-16T08:59:59+07:00"))).toBeNull();
  expect(recruitmentWeek(new Date("2026-11-17T09:00:00+07:00"))).toBeNull();
  expect(recruitmentWeek(new Date("2026-11-16T09:00:00+07:00"))).toEqual({
    date: "2026-11-16", start: new Date("2026-11-16T00:00:00+07:00"),
    previous: new Date("2026-11-09T00:00:00+07:00"), end: new Date("2026-11-23T00:00:00+07:00"),
  });
});
it("numbers long reports without losing text or splitting surrogate pairs", () => {
  const text = "ชื่อ candidate 🦉\n".repeat(1000);
  const parts = recruitmentParts(text);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every(part => part.length <= 5000 && part.isWellFormed())).toBe(true);
  expect(parts.map(part => part.replace(/^\(\d+\/\d+\)\n/, "")).join("")).toBe(text);
});
it("writes short LINE lines in Bangkok time", () => {
  expect(lineSlot(new Date("2026-11-05T02:00:00Z"), new Date("2026-11-05T02:30:00Z"))).toBe("Thu 5 Nov, 09:00–09:30");
  expect(lineWho("Jane", "")).toBe("Jane · Subject not recorded");
  expect(contactLine({ email: "a@b.co", phone: null })).toBe("a@b.co");
  expect(contactLine({ email: null, phone: null })).toBe("No email or phone recorded");
});
