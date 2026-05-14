import { describe, expect, it } from "vitest";
import { isClassroomPublishEligible } from "../data";

const baseRow = {
  status: "assigned" as const,
  assignedRoom: "Joy",
  sessionType: "OFFLINE",
  wiseClassId: "class-1",
  wiseSessionId: "session-1",
  warnings: [] as string[],
};

describe("isClassroomPublishEligible", () => {
  it("allows assigned offline rows with Wise ids", () => {
    expect(isClassroomPublishEligible(baseRow)).toEqual({ eligible: true });
  });

  it("skips online rows in v1", () => {
    expect(isClassroomPublishEligible({ ...baseRow, sessionType: "ONLINE" })).toEqual({
      eligible: false,
      reason: "V1 publishes Wise locations for OFFLINE sessions only",
    });
  });

  it("skips rows that need capacity review", () => {
    expect(isClassroomPublishEligible({
      ...baseRow,
      warnings: ["needs_review_missing_capacity"],
    })).toEqual({
      eligible: false,
      reason: "Missing reliable group capacity",
    });
  });

  it("skips rows missing Wise class ids", () => {
    expect(isClassroomPublishEligible({ ...baseRow, wiseClassId: null })).toEqual({
      eligible: false,
      reason: "Missing Wise class id",
    });
  });
});
