import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "@/lib/db/schema";
import { ensureIndex, type IndexedTutorGroup } from "@/lib/search/index";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { fetchTeacherAvailability } from "@/lib/wise/fetchers";
import { availableSlots, verifyLiveSlot } from "../availability";
import { configSchema, instant, type Slot } from "../model";

vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn(() => ({})) }));
vi.mock("@/lib/wise/day-sessions", () => ({
  fetchWiseSessionsForBangkokDates: vi.fn(),
}));
vi.mock("@/lib/wise/fetchers", () => ({ fetchTeacherAvailability: vi.fn() }));

const DATE = "2026-11-02";
const slot: Slot = {
  date: DATE,
  start: instant(DATE, 720).toISOString(),
  end: instant(DATE, 780).toISOString(),
  interviewerKey: "Peat",
  subjects: ["Mathematics"],
};
const group = (extra: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup => ({
  id: "g",
  canonicalKey: "Peat",
  displayName: "Peat",
  supportedModes: ["onsite"],
  qualifications: [],
  wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Peat", isOnline: false }],
  availabilityWindows: [], // No Wise working hours.
  leaves: [],
  leavesCompleteThrough: new Date("2026-12-31"),
  sessionBlocks: [],
  dataIssues: [],
  ...extra,
});
const account = {
  wiseTeacherId: "t1",
  wiseUserId: "u1",
  canonicalKey: "Peat",
  isOnlineVariant: false,
  status: "active",
  lastSnapshotId: "snap",
};
const index = (g = group(), syncedAt = new Date()) =>
  ({ snapshotId: "snap", syncedAt, tutorGroups: [g] }) as never;
const fakeDb = (tables: Map<unknown, unknown[]>) =>
  ({
    select: () => ({
      from: (table: unknown) => {
        const rows = Promise.resolve(tables.get(table) ?? []);
        return Object.assign(rows, { where: () => rows });
      },
    }),
  }) as never;
const session = (extra: Record<string, unknown> = {}) => ({
  _id: "s1",
  userId: "u1",
  meetingStatus: "SCHEDULED",
  scheduledStartTime: instant(DATE, 700).toISOString(),
  scheduledEndTime: instant(DATE, 760).toISOString(),
  ...extra,
});
const live = (extra: Record<string, unknown> = {}) =>
  ({ leaves: [], workingHours: { slots: [] }, ...extra }) as never;
const verify = () =>
  verifyLiveSlot(fakeDb(new Map([[s.tutorWiseAccounts, [account]]])), slot);

beforeEach(() => {
  vi.mocked(ensureIndex).mockReset().mockResolvedValue(index());
  vi.mocked(fetchWiseSessionsForBangkokDates).mockReset().mockResolvedValue([]);
  vi.mocked(fetchTeacherAvailability).mockReset().mockResolvedValue(live());
});

describe("verifyLiveSlot", () => {
  it("passes with no Wise working hours", async () => {
    expect(await verify()).toMatchObject({ source: "wise-live", snapshotId: "snap" });
    // Even with no working-hours field at all.
    vi.mocked(fetchTeacherAvailability).mockResolvedValue({ leaves: [] } as never);
    expect(await verify()).toMatchObject({ source: "wise-live" });
  });
  it("fails on an unresolved teacher", async () => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([
      session({ userId: undefined }),
    ] as never);
    await expect(verify()).rejects.toMatchObject({ status: 409 });
  });
  it("fails on a blocking session of the head, not on a cancelled or other teacher's one", async () => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([session()] as never);
    await expect(verify()).rejects.toThrow(/has a class/);
    for (const other of [{ meetingStatus: "CANCELLED" }, { userId: "u2" }]) {
      vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([
        session(other),
      ] as never);
      expect(await verify()).toMatchObject({ source: "wise-live" });
    }
  });
  it("fails on a leave overlap and on bad or missing leave data", async () => {
    const leave = (startTime: string, endTime: string) =>
      vi.mocked(fetchTeacherAvailability).mockResolvedValue(
        live({ leaves: [{ startTime, endTime }] }),
      );
    leave(instant(DATE, 700).toISOString(), instant(DATE, 740).toISOString());
    await expect(verify()).rejects.toThrow(/on leave/);
    leave("not a date", instant(DATE, 740).toISOString());
    await expect(verify()).rejects.toThrow(/leave data/);
    leave(instant(DATE, 740).toISOString(), instant(DATE, 700).toISOString());
    await expect(verify()).rejects.toThrow(/leave data/);
    vi.mocked(fetchTeacherAvailability).mockResolvedValue({} as never);
    await expect(verify()).rejects.toThrow(/complete availability/);
    // A leave that ends before the slot is fine.
    leave(instant(DATE, 600).toISOString(), instant(DATE, 720).toISOString());
    expect(await verify()).toMatchObject({ source: "wise-live" });
  });
});

describe("availableSlots (legacy mock)", () => {
  const NOW = new Date("2026-10-30T05:00:00Z");
  const week = Array.from({ length: 7 }, (_, d) =>
    d >= 1 && d <= 5 ? { start: "10:00", end: "16:00" } : null,
  );
  const run = (interviewer: Record<string, unknown>) =>
    availableSlots(
      fakeDb(new Map()),
      configSchema.parse({
        interviewers: [
          { canonicalKey: "Peat", subjects: ["Mathematics"], email: "peat@example.com", ...interviewer },
        ],
      }),
      "mock",
      ["Mathematics"],
      NOW,
    );
  beforeEach(() =>
    vi.mocked(ensureIndex).mockResolvedValue(index(group(), new Date(NOW.getTime() - 60_000))),
  );
  it("offers hourly mock slots to a head with saved hours and no Wise working hours", async () => {
    const slots = await run({ fallbackWeek: week });
    expect(slots).toHaveLength(5 * 6); // 5 dates, 10:00 to 15:00 starts
    expect(slots.every((x) => x.interviewerKey === "Peat")).toBe(true);
  });
  it("offers none to a head with no saved hours", async () => {
    expect(await run({})).toEqual([]);
  });
});
