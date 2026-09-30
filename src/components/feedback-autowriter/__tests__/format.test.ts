import { describe, expect, it } from "vitest";
import { FIELD_LABELS, clock, count, dayMonth, dayOf, deadlineCountdown, longDate, minutes, percent, threshold, usd, when, whenAfter } from "../format";
import { ARM_LABEL, effortsLabel, modelLabel } from "../model-labels";

describe("times and dates", () => {
  it("writes an instant in Bangkok, with month names that do not depend on the runtime", () => {
    // 05:00 UTC is noon in Bangkok.
    expect(when("2026-09-30T05:00:00.000Z")).toBe("30 Sep, 12:00");
    expect(clock("2026-09-30T05:00:00.000Z")).toBe("12:00");
    // Late evening UTC is already the next day in Bangkok; midnight is 00, never 24.
    expect(when("2026-09-30T17:00:00.000Z")).toBe("1 Oct, 00:00");
    expect(when("2026-12-31T18:05:00.000Z")).toBe("1 Jan, 01:05");
    expect(clock("2026-09-30T01:07:00.000Z")).toBe("08:07");
    // The Bangkok date, not the UTC one.
    expect(dayOf("2026-09-30T17:00:00.000Z")).toBe("1 Oct");
    expect(dayOf(null)).toBe("—");
  });

  it("drops the date of a time shown next to another one of the same Bangkok day", () => {
    expect(whenAfter("2026-10-06T06:00:00.000Z", "2026-10-06T07:12:00.000Z")).toBe("14:12");
    // 23:30 and 00:30 Bangkok time are different days, whatever the UTC date.
    expect(whenAfter("2026-10-06T16:30:00.000Z", "2026-10-06T17:30:00.000Z")).toBe("7 Oct, 00:30");
    expect(whenAfter(null, "2026-10-06T07:12:00.000Z")).toBe("6 Oct, 14:12");
    expect(whenAfter("2026-10-06T06:00:00.000Z", null)).toBe("—");
  });

  it("shows a dash for a missing or unreadable time", () => {
    expect(when(null)).toBe("—");
    expect(when("not a time")).toBe("—");
    expect(clock(null)).toBe("—");
  });

  it("writes a Bangkok date key short and long", () => {
    expect(dayMonth("2026-09-29")).toBe("29 Sep");
    expect(dayMonth("2026-10-06")).toBe("6 Oct");
    expect(longDate("2026-09-30")).toBe("Wednesday, 30 September 2026");
    expect(longDate("2026-10-06")).toBe("Tuesday, 6 October 2026");
    expect(dayMonth("soon")).toBe("soon");
    expect(longDate("")).toBe("");
  });

  it("counts a deadline down without overstating the time left", () => {
    const now = new Date("2026-10-06T05:00:00.000Z");
    const inMs = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const hour = 3_600_000;
    expect(deadlineCountdown(inMs(9.9 * hour), now)).toBe("Deadline in 9 h");
    expect(deadlineCountdown(inMs(40 * 60_000 + 30_000), now)).toBe("Deadline in 40 min");
    expect(deadlineCountdown(inMs(47 * hour), now)).toBe("Deadline in 47 h");
    expect(deadlineCountdown(inMs(72 * hour), now)).toBe("Deadline in 3 days");
    expect(deadlineCountdown(inMs(-3.5 * hour), now)).toBe("Deadline passed 3 h ago");
    expect(deadlineCountdown(inMs(-5 * 60_000), now)).toBe("Deadline passed 5 min ago");
    expect(deadlineCountdown(inMs(30_000), now)).toBe("Deadline in under a minute");
    expect(deadlineCountdown(inMs(0), now)).toBe("Deadline just passed");
    expect(deadlineCountdown(null, now)).toBe("No deadline");
    expect(deadlineCountdown("not a time", now)).toBe("No deadline");
  });
});

describe("numbers", () => {
  it("writes money to the cent, and small amounts to a hundredth of a cent", () => {
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(0.0076)).toBe("$0.0076");
    expect(usd(0)).toBe("$0.00");
    expect(usd(null)).toBe("—");
    expect(usd(undefined)).toBe("—");
  });

  it("writes minutes, and hours from an hour up", () => {
    expect(minutes(2.5)).toBe("2.5 min");
    expect(minutes(55)).toBe("55.0 min");
    expect(minutes(72)).toBe("1.2 h");
    expect(minutes(null)).toBe("—");
  });

  it("rounds a measured ratio down and a threshold to the whole percent", () => {
    expect(percent(0.7225)).toBe("72.2%");
    expect(percent(0.79999)).toBe("79.9%");
    expect(percent(0.79999, 0)).toBe("79%");
    expect(percent(1)).toBe("100%");
    expect(percent(null)).toBe("—");
    expect(threshold(0.8)).toBe("80%");
  });

  it("names what it counts", () => {
    expect(count(1, "post")).toBe("1 post");
    expect(count(3, "post")).toBe("3 posts");
    expect(count(2, "class", "classes")).toBe("2 classes");
  });
});

describe("labels", () => {
  it("names the four feedback fields in form order", () => {
    expect(Object.entries(FIELD_LABELS)).toEqual([
      ["topics", "Topics covered"],
      ["performance", "How the student did in class"],
      ["improvement", "Need more work on"],
      ["homework", "Homework and due date"],
    ]);
  });

  it("names a writer by its arm and a model by its id", () => {
    expect(ARM_LABEL).toEqual({ sol: "GPT-6.1 Sol", luna: "GPT-6 Luna", glm: "GLM Flash" });
    expect(modelLabel("openai/gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelLabel("openai/gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelLabel("z-ai/glm-5.3-flash")).toBe("GLM Flash");
    expect(modelLabel("stt-async-v5")).toBe("Soniox transcription");
    expect(modelLabel("someone/else")).toBe("someone/else");
    expect(effortsLabel(["medium", "high"])).toBe("medium + high");
    expect(effortsLabel(["low"])).toBe("low");
  });
});
