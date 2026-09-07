import { describe, expect, it, vi } from "vitest";
import { prepareClassroomRecoveryDay, type ClassroomRecoveryContext } from "../recovery-data";
import type { WiseClient } from "@/lib/wise/client";
import type { WiseSession } from "@/lib/wise/types";

const now = new Date("2026-09-09T02:00:00Z");
const date = "2026-09-12";
const session = (id: string, extra: Partial<WiseSession> = {}): WiseSession => ({ _id: id, userId: "user-1", type: "OFFLINE",
  scheduledStartTime: `${date}T03:00:00Z`, scheduledEndTime: `${date}T04:00:00Z`, meetingStatus: "CONFIRMED", location: "A", ...extra });
function context(extra: Partial<ClassroomRecoveryContext> = {}): ClassroomRecoveryContext {
  return { snapshot: { id: "snapshot", active: true, createdAt: now },
    members: [{ groupId: "group", wiseTeacherId: "teacher", wiseUserId: "user-1", name: "Teacher", canonicalKey: "teacher" }],
    latestRuns: [], previousRows: [], rooms: [{ id: "room", name: "A", capacity: 2, active: true, hasTv: false, category: "standard", sortOrder: 0,
      createdAt: now, updatedAt: now }], profiles: { rooms: [], profiles: [] }, history: [], notified: [], expectedSessions: [], identityIssues: [], ...extra };
}
describe("read-only recovery preparation", () => {
  it("excludes cancelled sessions without consuming a room", async () => {
    const result = await prepareClassroomRecoveryDay(context(), [session("cancelled", { meetingStatus: "CANCELLED" })], date, {} as WiseClient, now);
    expect(result.day).toEqual([]);
    expect(result.liveRoomBlocks).toEqual([]);
  });
  it("reports unknown teachers and reserves their known physical rooms", async () => {
    const result = await prepareClassroomRecoveryDay(context(), [session("unknown", { userId: "not-in-snapshot" })], date, {} as WiseClient, now);
    expect(result.sessions).toEqual([]);
    expect(result.findings[0].kind).toBe("unverified");
    expect(result.externalRoomBlocks[0].location).toBe("A");
  });
  it("reports ambiguous identities instead of applying guessed tutor policies", async () => {
    const result = await prepareClassroomRecoveryDay(context({ identityIssues: [{ entityId: "teacher", message: "identity_collision" }] }), [session("one")], date, {} as WiseClient, now);
    expect(result.sessions).toEqual([]);
    expect(result.findings[0].kind).toBe("unverified");
  });
  it("checks sessions missing from both the live list and saved assignment runs", async () => {
    const get = vi.fn().mockRejectedValue(new Error("not found"));
    const result = await prepareClassroomRecoveryDay(context({ expectedSessions: [{ wiseSessionId: "missing", wiseClassId: "class", date }] }), [], date, { get } as unknown as WiseClient, now);
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.confirmedInactiveSessionIds.size).toBe(0);
    expect(result.findings[0].message).toContain("reservation is retained");
  });
  it("releases a missing reservation only on confirmed cancellation or movement", async () => {
    const result = await prepareClassroomRecoveryDay(context({ expectedSessions: [{ wiseSessionId: "moved", wiseClassId: "class", date }] }),
      [session("moved", { scheduledStartTime: "2026-09-13T03:00:00Z", scheduledEndTime: "2026-09-13T04:00:00Z" })], date, {} as WiseClient, now);
    expect(result.confirmedInactiveSessionIds.has("moved")).toBe(true);
    expect(result.findings).toEqual([]);
  });
  it("reserves physical rooms for unresolved online sessions too", async () => {
    const result = await prepareClassroomRecoveryDay(context(), [session("online", { type: "SCHEDULED", userId: "unknown" })], date, {} as WiseClient, now);
    expect(result.externalRoomBlocks[0].location).toBe("A");
  });
});
