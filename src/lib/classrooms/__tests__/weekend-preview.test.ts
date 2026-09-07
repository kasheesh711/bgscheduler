import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/classrooms/data", () => ({ CLASSROOM_ASSIGNMENT_FRESHNESS_MS: 15 * 60_000, getFreshClassroomSnapshotForAssignment: vi.fn() }));
import { getFreshClassroomSnapshotForAssignment } from "../data";
import { waitForWeekendSnapshot } from "../weekend-preview";
import type { Database } from "@/lib/db";
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe("waiting for the scheduled Wise refresh", () => {
  it("uses a fresh snapshot immediately", async () => {
    vi.mocked(getFreshClassroomSnapshotForAssignment).mockResolvedValue({ snapshotId: "fresh" } as never);
    expect(await waitForWeekendSnapshot({} as Database)).toMatchObject({ snapshotId: "fresh" });
  });
  it("waits for promotion instead of starting a competing sync", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreshClassroomSnapshotForAssignment).mockRejectedValueOnce(new Error("Stale"))
      .mockResolvedValue({ snapshotId: "promoted" } as never);
    const pending = waitForWeekendSnapshot({} as Database);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ snapshotId: "promoted" });
    expect(getFreshClassroomSnapshotForAssignment).toHaveBeenCalledTimes(2);
  });
  it("fails visibly when the freshness deadline expires", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreshClassroomSnapshotForAssignment).mockRejectedValue(new Error("Snapshot still stale"));
    const pending = expect(waitForWeekendSnapshot({} as Database, 10_000)).rejects.toThrow("still stale");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });
});
