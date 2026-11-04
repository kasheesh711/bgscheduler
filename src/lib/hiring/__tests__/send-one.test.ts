import { describe, expect, it } from "vitest";
import { sendOneRefusal } from "../worker";

describe("sendOneRefusal", () => {
  it("allows only a pending form for a candidate at pre_screen", () => {
    expect(sendOneRefusal("pre_screen", "pending")).toBeNull();
    expect(sendOneRefusal(undefined, undefined)).toBe("No candidate has that ID.");
    expect(sendOneRefusal("new", undefined)).toMatch(/at new, not pre_screen/);
    expect(sendOneRefusal("pre_screen", undefined)).toMatch(/no pre-screen form/);
    expect(sendOneRefusal("pre_screen", "sent")).toMatch(/is sent, not pending/);
    expect(sendOneRefusal("pre_screen", "failed")).toMatch(/is failed, not pending/);
  });
});
