import { describe, expect, it } from "vitest";
import { normalizeSessions } from "@/lib/normalization/sessions";
import { interpretSnapshotSessionInterval } from "../snapshot-timezone";

function snapshotFromRaw(tz: string, start = "2026-10-05T11:00:00Z", end = "2026-10-05T12:00:00Z") {
  const previous = process.env.TZ;
  try {
    process.env.TZ = tz;
    return normalizeSessions([{ _id: "synthetic-session", teacherId: "synthetic-tutor", scheduledStartTime: start, scheduledEndTime: end }], () => "synthetic-tutor")[0];
  } finally { process.env.TZ = previous; }
}

describe("snapshot workforce timezone interpretation", () => {
  it("recovers the original Wise UTC instant from a UTC-server wall-clock snapshot", () => {
    const block = snapshotFromRaw("UTC");
    expect(block.startTime.toISOString()).toBe("2026-10-05T18:00:00.000Z");
    expect(block.startMinute).toBe(1080);
    expect(interpretSnapshotSessionInterval(block)).toEqual({ startAt: "2026-10-05T11:00:00.000Z", endAt: "2026-10-05T12:00:00.000Z", scheduledMinutes: 60, reasonCodes: ["SNAPSHOT_WALL_CLOCK_TIMESTAMP_RECOVERED"] });
  });
  it("preserves an already-correct Bangkok-runtime snapshot", () => {
    const block = snapshotFromRaw("Asia/Bangkok");
    expect(block.startTime.toISOString()).toBe("2026-10-05T11:00:00.000Z");
    expect(interpretSnapshotSessionInterval(block)).toEqual({ startAt: "2026-10-05T11:00:00.000Z", endAt: "2026-10-05T12:00:00.000Z", scheduledMinutes: 60, reasonCodes: [] });
  });
  it.each(["UTC", "Asia/Bangkok"])("preserves Bangkok midnight rollover and seconds under %s", tz => {
    const block = snapshotFromRaw(tz, "2026-10-05T16:30:15Z", "2026-10-05T18:00:15Z");
    const result = interpretSnapshotSessionInterval(block)!;
    expect(result.startAt).toBe("2026-10-05T16:30:15.000Z");
    expect(result.endAt).toBe("2026-10-05T18:00:15.000Z");
    expect(result.scheduledMinutes).toBe(90);
    expect(block.weekday).toBe(1); expect(block.startMinute).toBe(1410); expect(block.endMinute).toBe(60);
  });
  it("fails closed when independent weekday/minute evidence disagrees or timestamps are invalid", () => {
    const block = snapshotFromRaw("UTC");
    expect(interpretSnapshotSessionInterval({ ...block, weekday: 4 })).toBeNull();
    expect(interpretSnapshotSessionInterval({ ...block, startMinute: 1111 })).toBeNull();
    expect(interpretSnapshotSessionInterval({ ...block, endMinute: 1151 })).toBeNull();
    expect(interpretSnapshotSessionInterval({ ...block, endTime: block.startTime })).toBeNull();
    expect(interpretSnapshotSessionInterval({ ...block, startTime: new Date(NaN) })).toBeNull();
  });
});


it.each(["UTC", "Asia/Bangkok"])("interpretation stays correct with a %s reader runtime", readerTz => {
  const block = snapshotFromRaw("UTC");
  const original = process.env.TZ;
  try {
    process.env.TZ = readerTz;
    expect(interpretSnapshotSessionInterval(block)?.startAt).toBe("2026-10-05T11:00:00.000Z");
  } finally { process.env.TZ = original; }
});
