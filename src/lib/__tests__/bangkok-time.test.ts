import { describe, expect, it } from "vitest";
import {
  formatBangkokDateTime,
  formatBangkokIsoDate,
  formatBangkokShortDateTime,
  getBangkokWeekdayForIsoDate,
} from "../bangkok-time";

describe("Bangkok website time formatting", () => {
  it("formats instants in Asia/Bangkok instead of the runtime timezone", () => {
    expect(formatBangkokDateTime("2026-05-15T00:30:00.000Z")).toBe("15 May 2026, 07:30");
    expect(formatBangkokShortDateTime("2026-05-15T00:30:00.000Z")).toBe("15 May, 07:30");
  });

  it("formats ISO calendar dates as Bangkok dates", () => {
    expect(formatBangkokIsoDate("2026-05-15")).toBe("15 May");
    expect(getBangkokWeekdayForIsoDate("2026-05-15")).toBe(5);
  });
});
