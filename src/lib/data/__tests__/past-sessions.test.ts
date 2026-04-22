import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fetchPastSessionBlocksUncached } from "../past-sessions";

// Mock db — the fetcher calls `db.select().from(X).where(Y)` and awaits.
// We only need the chain to resolve to the fixture rows we want to test with.
type MockRow = Record<string, unknown>;
const mockRows: MockRow[] = [];
const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(mockRows.slice())),
    })),
  })),
};

vi.mock("@/lib/db", () => ({
  getDb: () => mockDb,
}));

// Small helper to construct a past_session_blocks row with defaults.
function makeRow(overrides: Partial<MockRow>): MockRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    groupCanonicalKey: "kevin",
    capturedInSnapshotId: "00000000-0000-0000-0000-0000000000aa",
    wiseTeacherId: "wt1",
    wiseSessionId: "ws1",
    startTime: new Date("2026-04-10T10:00:00+07:00"),
    endTime: new Date("2026-04-10T11:30:00+07:00"),
    weekday: 5,
    startMinute: 600,
    endMinute: 690,
    wiseStatus: "SCHEDULED",
    isBlocking: true,
    title: null,
    sessionType: null,
    location: null,
    studentName: "Alex",
    subject: null,
    classType: null,
    recurrenceId: null,
    capturedAt: new Date("2026-04-11T00:00:00+07:00"),
    ...overrides,
  };
}

describe("fetchPastSessionBlocksUncached", () => {
  beforeEach(() => {
    mockRows.length = 0;
    mockDb.select.mockClear();
  });

  it("returns empty Map and does not call db when canonicalKeys is empty", async () => {
    const result = await fetchPastSessionBlocksUncached(
      [],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    expect(result.size).toBe(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("buckets rows by groupCanonicalKey", async () => {
    mockRows.push(
      makeRow({ groupCanonicalKey: "kevin", wiseSessionId: "s1" }),
      makeRow({ groupCanonicalKey: "kevin", wiseSessionId: "s2" }),
      makeRow({ groupCanonicalKey: "sam", wiseSessionId: "s3" }),
    );
    const result = await fetchPastSessionBlocksUncached(
      ["kevin", "sam"],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    expect(result.size).toBe(2);
    expect(result.get("kevin")).toHaveLength(2);
    expect(result.get("sam")).toHaveLength(1);
  });

  it("omits keys with no rows (bucket not pre-populated)", async () => {
    mockRows.push(makeRow({ groupCanonicalKey: "kevin", wiseSessionId: "s1" }));
    const result = await fetchPastSessionBlocksUncached(
      ["kevin", "sam", "paojuu"],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    expect(result.size).toBe(1);
    expect(result.has("sam")).toBe(false);
    expect(result.has("paojuu")).toBe(false);
  });

  it("maps null nullable columns to undefined on IndexedSessionBlock", async () => {
    mockRows.push(makeRow({
      groupCanonicalKey: "kevin", wiseSessionId: "s1",
      title: null, sessionType: null, location: null, subject: null,
      classType: null, recurrenceId: null,
    }));
    const result = await fetchPastSessionBlocksUncached(
      ["kevin"],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    const block = result.get("kevin")![0];
    expect(block.title).toBeUndefined();
    expect(block.sessionType).toBeUndefined();
    expect(block.location).toBeUndefined();
    expect(block.subject).toBeUndefined();
    expect(block.classType).toBeUndefined();
    expect(block.recurrenceId).toBeUndefined();
  });

  it("preserves non-null nullable columns as typed values", async () => {
    mockRows.push(makeRow({
      groupCanonicalKey: "kevin", wiseSessionId: "s1",
      title: "Math session", studentName: "Alex",
    }));
    const result = await fetchPastSessionBlocksUncached(
      ["kevin"],
      new Date("2026-04-06T00:00:00+07:00"),
      new Date("2026-04-13T00:00:00+07:00"),
    );
    const block = result.get("kevin")![0];
    expect(block.title).toBe("Math session");
    expect(block.studentName).toBe("Alex");
  });
});

describe("past-sessions.ts cache discipline (grep assertion per D-08 / Pitfall 7)", () => {
  const sourcePath = path.resolve(__dirname, "../past-sessions.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  it("tags with 'past-sessions' exactly once", () => {
    const matches = source.match(/cacheTag\("past-sessions"\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("uses cacheLife('days') exactly once", () => {
    const matches = source.match(/cacheLife\("days"\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("does NOT reference cacheTag('snapshot') — regression guard for Pitfall 7", () => {
    const matches = source.match(/cacheTag\("snapshot"\)/g) ?? [];
    expect(matches).toHaveLength(0);
  });

  it("does NOT call revalidateTag (that's the caller's responsibility)", () => {
    const matches = source.match(/revalidateTag\(/g) ?? [];
    expect(matches).toHaveLength(0);
  });
});
