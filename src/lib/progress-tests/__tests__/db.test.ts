import { describe, expect, it, vi } from "vitest";
import { appendLedgerRows, type ProgressTestLedgerInsert } from "../db";

function makeRows(n: number): ProgressTestLedgerInsert[] {
  return Array.from({ length: n }, (_, i) => ({
    enrollmentKey: `class-1|student-${i}`,
    wiseSessionId: `session-${i}`,
    wiseClassId: "class-1",
    wiseStudentId: `student-${i}`,
    studentKey: `student-${i}::parent`,
    studentName: `Student ${i}`,
    subject: "Math",
    scheduledStartTime: new Date("2026-03-15T03:00:00.000Z"),
    creditApplied: 1,
    meetingStatus: "ENDED",
    isProgressTest: false,
    countsTowardCycle: true,
  }));
}

/** Builds a db mock whose insert().values().onConflictDoUpdate() chain records
 *  the size of each inserted chunk. */
function makeDbMock() {
  const chunkSizes: number[] = [];
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn((rows: unknown[]) => {
    chunkSizes.push((rows as unknown[]).length);
    return { onConflictDoUpdate };
  });
  const insert = vi.fn(() => ({ values }));
  return {
    db: { insert } as unknown as Parameters<typeof appendLedgerRows>[1],
    chunkSizes,
    insert,
    onConflictDoUpdate,
  };
}

describe("appendLedgerRows", () => {
  it("chunks inserts so no statement exceeds Postgres's bind-parameter limit", async () => {
    const { db, chunkSizes, onConflictDoUpdate } = makeDbMock();

    // 1200 rows x 16 params/row would be ~19,200 params in one statement; chunked
    // at 500 it becomes three statements (8,000 params max each).
    await appendLedgerRows(makeRows(1200), db);

    expect(chunkSizes).toEqual([500, 500, 200]);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(500);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(3);
  });

  it("handles a large real-world snapshot (5537 rows) without a giant statement", async () => {
    const { db, chunkSizes } = makeDbMock();

    await appendLedgerRows(makeRows(5537), db);

    expect(chunkSizes.reduce((a, b) => a + b, 0)).toBe(5537);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(500);
    // 5537 / 500 -> 12 chunks; 16 params * 500 = 8000 << 65535.
    expect(chunkSizes.length).toBe(12);
  });

  it("no-ops on empty input", async () => {
    const { db, insert } = makeDbMock();
    await appendLedgerRows([], db);
    expect(insert).not.toHaveBeenCalled();
  });
});
