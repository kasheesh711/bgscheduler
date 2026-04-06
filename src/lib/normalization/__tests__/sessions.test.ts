import { describe, it, expect } from "vitest";
import { isBlockingStatus, normalizeSessions } from "../sessions";
import type { WiseSession } from "@/lib/wise/types";

describe("isBlockingStatus", () => {
  it("treats CONFIRMED as blocking", () => {
    expect(isBlockingStatus("CONFIRMED")).toBe(true);
  });

  it("treats SCHEDULED as blocking", () => {
    expect(isBlockingStatus("SCHEDULED")).toBe(true);
  });

  it("treats CANCELLED as non-blocking", () => {
    expect(isBlockingStatus("CANCELLED")).toBe(false);
  });

  it("treats CANCELED (US spelling) as non-blocking", () => {
    expect(isBlockingStatus("CANCELED")).toBe(false);
  });

  it("treats unknown status as blocking (fail-closed)", () => {
    expect(isBlockingStatus("SOMETHING_NEW")).toBe(true);
  });

  it("treats undefined as blocking (fail-closed)", () => {
    expect(isBlockingStatus(undefined)).toBe(true);
  });
});

describe("normalizeSessions", () => {
  it("normalizes session with blocking status", () => {
    const sessions: WiseSession[] = [
      {
        _id: "s1",
        teacherId: "t1",
        scheduledStartTime: "2024-01-15T02:00:00Z", // 09:00 Bangkok
        scheduledEndTime: "2024-01-15T03:00:00Z", // 10:00 Bangkok
        meetingStatus: "CONFIRMED",
        type: "online",
      },
    ];

    const result = normalizeSessions(sessions, (s) => s.teacherId ?? null);
    expect(result).toHaveLength(1);
    expect(result[0].isBlocking).toBe(true);
    expect(result[0].startMinute).toBe(540); // 09:00
    expect(result[0].endMinute).toBe(600); // 10:00
  });

  it("marks cancelled sessions as non-blocking", () => {
    const sessions: WiseSession[] = [
      {
        _id: "s1",
        teacherId: "t1",
        scheduledStartTime: "2024-01-15T02:00:00Z",
        scheduledEndTime: "2024-01-15T03:00:00Z",
        meetingStatus: "CANCELLED",
      },
    ];

    const result = normalizeSessions(sessions, (s) => s.teacherId ?? null);
    expect(result[0].isBlocking).toBe(false);
  });

  it("skips sessions without resolvable teacher", () => {
    const sessions: WiseSession[] = [
      {
        _id: "s1",
        scheduledStartTime: "2024-01-15T02:00:00Z",
        scheduledEndTime: "2024-01-15T03:00:00Z",
      },
    ];

    const result = normalizeSessions(sessions, () => null);
    expect(result).toHaveLength(0);
  });

  it("supports resolving the teacher from a nested Wise user object", () => {
    const sessions: WiseSession[] = [
      {
        _id: "s1",
        userId: {
          _id: "u1",
          name: "Teacher Name",
        },
        scheduledStartTime: "2024-01-15T02:00:00Z",
        scheduledEndTime: "2024-01-15T03:00:00Z",
        meetingStatus: "CANCELLED",
      },
    ];

    const result = normalizeSessions(sessions, (s) =>
      typeof s.userId === "object" ? s.userId._id : null
    );
    expect(result).toHaveLength(1);
    expect(result[0].wiseTeacherId).toBe("u1");
    expect(result[0].isBlocking).toBe(false);
  });
});
