import { describe, it, expect } from "vitest";
import { parseSlotInput } from "../parser";

describe("parseSlotInput", () => {
  it("parses single slot", () => {
    const result = parseSlotInput("Monday 11:00-12:00");
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].dayOfWeek).toBe(1);
    expect(result.slots[0].start).toBe("11:00");
    expect(result.slots[0].end).toBe("12:00");
    expect(result.warnings).toHaveLength(0);
  });

  it("parses multiple comma-separated slots", () => {
    const result = parseSlotInput("Monday 11:00-12:00, Tuesday 15:00-17:00");
    expect(result.slots).toHaveLength(2);
    expect(result.slots[0].dayOfWeek).toBe(1);
    expect(result.slots[1].dayOfWeek).toBe(2);
  });

  it("handles abbreviated day names", () => {
    const result = parseSlotInput("Mon 9:00-10:00");
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].dayOfWeek).toBe(1);
  });

  it("warns on unparseable input", () => {
    const result = parseSlotInput("gibberish");
    expect(result.slots).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it("applies default mode", () => {
    const result = parseSlotInput("Monday 11:00-12:00", "online");
    expect(result.slots[0].mode).toBe("online");
  });

  it("handles en-dash separator", () => {
    const result = parseSlotInput("Friday 14:00\u201316:00");
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].start).toBe("14:00");
    expect(result.slots[0].end).toBe("16:00");
  });
});
