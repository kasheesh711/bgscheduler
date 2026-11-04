import { describe, expect, it } from "vitest";
import { roomSyncError } from "../data";

describe("roomSyncError", () => {
  it("is empty for a clean sync", () => {
    expect(roomSyncError({ errorSummary: null, metadata: {} })).toEqual({});
    expect(roomSyncError(null)).toEqual({});
  });
  it("ignores a contact-only problem recorded by the split", () => {
    expect(roomSyncError({ errorSummary: "1 Wise teacher contact accounts need review", metadata: { roomDataErrorSummary: null } })).toEqual({});
  });
  it("keeps the room-affecting part when both kinds occur", () => {
    expect(roomSyncError({ errorSummary: "1 Wise teacher contact accounts need review; 2 sessions reference teachers absent from the Wise roster",
      metadata: { roomDataErrorSummary: "2 sessions reference teachers absent from the Wise roster" } }))
      .toEqual({ roomSyncErrorSummary: "2 sessions reference teachers absent from the Wise roster" });
  });
  it("treats runs from before the split as room-affecting (fail closed)", () => {
    expect(roomSyncError({ errorSummary: "1 Wise teacher contact accounts need review", metadata: { contactSync: { blocked: 1 } } }))
      .toEqual({ roomSyncErrorSummary: "1 Wise teacher contact accounts need review" });
  });
});
