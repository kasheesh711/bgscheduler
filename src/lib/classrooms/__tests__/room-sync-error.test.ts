import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/db";
import { loadClassroomSnapshotMeta, roomSyncError } from "../data";

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
  it("blocks on a recorded room problem even without an error summary", () => {
    expect(roomSyncError({ errorSummary: null, metadata: { roomDataErrorSummary: "1 Wise teacher identities conflict" } }))
      .toEqual({ roomSyncErrorSummary: "1 Wise teacher identities conflict" });
  });
  it("fails closed on a malformed value", () => {
    expect(roomSyncError({ errorSummary: "x", metadata: { roomDataErrorSummary: true } })).toEqual({ roomSyncErrorSummary: "x" });
  });
  it("treats runs from before the split as room-affecting (fail closed)", () => {
    expect(roomSyncError({ errorSummary: "1 Wise teacher contact accounts need review", metadata: { contactSync: { blocked: 1 } } }))
      .toEqual({ roomSyncErrorSummary: "1 Wise teacher contact accounts need review" });
  });
});

/** Minimal Drizzle stand-in: each select chain resolves to the next queued result at limit(). */
function stubDb(...results: unknown[][]): Database {
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => results.shift() ?? [] };
  return { select: () => chain } as unknown as Database;
}

describe("loadClassroomSnapshotMeta", () => {
  const snapshot = { id: "snap", createdAt: new Date() };
  const finishedAt = new Date();
  it("passes the room-affecting summary to the weekend checkpoint", async () => {
    const meta = await loadClassroomSnapshotMeta(stubDb([snapshot], [{ finishedAt, errorSummary: "a; b", metadata: { roomDataErrorSummary: "b" } }]));
    expect(meta).toMatchObject({ syncErrorSummary: "a; b", roomSyncErrorSummary: "b" });
  });
  it("blocks on an old run that has no split", async () => {
    const meta = await loadClassroomSnapshotMeta(stubDb([snapshot], [{ finishedAt, errorSummary: "old", metadata: {} }]));
    expect(meta.roomSyncErrorSummary).toBe("old");
  });
  it("does not block on a contact-only run", async () => {
    const meta = await loadClassroomSnapshotMeta(stubDb([snapshot], [{ finishedAt, errorSummary: "contact", metadata: { roomDataErrorSummary: null } }]));
    expect(meta.syncErrorSummary).toBe("contact");
    expect(meta.roomSyncErrorSummary).toBeUndefined();
  });
});
