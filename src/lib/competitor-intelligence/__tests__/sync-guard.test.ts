import { describe, expect, it, vi } from "vitest";
import { failStaleRunningCompetitorSyncs } from "@/lib/competitor-intelligence/sync";

function makeDbMock(staleRows: Array<{ id: string }> = []) {
  const topReturning = vi.fn().mockResolvedValue(staleRows);
  const childWhere = vi.fn().mockResolvedValue([]);
  const topWhere = vi.fn(() => ({ returning: topReturning }));
  const set = vi
    .fn()
    .mockImplementationOnce(() => ({ where: topWhere }))
    .mockImplementation(() => ({ where: childWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    childWhere,
    set,
    topReturning,
    update,
    db: { update },
  };
}

describe("competitor sync guard", () => {
  it("marks stale running syncs and child runs failed", async () => {
    const { db, childWhere, set, update } = makeDbMock([{ id: "stale-run-1" }]);

    await expect(
      failStaleRunningCompetitorSyncs(db as never, new Date("2026-06-15T14:00:00.000Z")),
    ).resolves.toBe(1);

    expect(update).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringContaining("still running after 20 minutes"),
    }));
    expect(set).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringContaining("still running after 20 minutes"),
    }));
    expect(set).toHaveBeenNthCalledWith(3, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringContaining("still running after 20 minutes"),
    }));
    expect(childWhere).toHaveBeenCalledTimes(2);
  });

  it("does not touch child runs when no stale syncs exist", async () => {
    const { db, childWhere, update } = makeDbMock();

    await expect(
      failStaleRunningCompetitorSyncs(db as never, new Date("2026-06-15T14:00:00.000Z")),
    ).resolves.toBe(0);

    expect(update).toHaveBeenCalledTimes(1);
    expect(childWhere).not.toHaveBeenCalled();
  });
});
