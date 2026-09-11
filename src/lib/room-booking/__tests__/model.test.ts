import { describe, it, expect } from "vitest";
import {
  freeIntervals,
  overlaps,
  validateRoomInterval,
  roomDate,
  roomMinute,
  parseRoomTime,
} from "../model";
import { buildRoomEvidence, confirmsRoomSessionDeletion } from "../refresh";
import { splitRoomEvents, isRoomText } from "../ingress";
import type { WiseSession } from "@/lib/wise/types";
const now = new Date("2026-09-11T02:00:00Z");
const wise = (overrides: Partial<WiseSession> = {}): WiseSession =>
  ({
    _id: "a",
    scheduledStartTime: "2026-09-11T03:00:00Z",
    scheduledEndTime: "2026-09-11T04:00:00Z",
    type: "OFFLINE",
    meetingStatus: "UPCOMING",
    location: "Focus",
    userId: "teacher",
    ...overrides,
  }) as WiseSession;
describe("room intervals", () => {
  it("merges overlaps and permits adjacent bookings", () => {
    expect(
      freeIntervals(
        [
          { startMinute: 600, endMinute: 660 },
          { startMinute: 630, endMinute: 690 },
          { startMinute: 690, endMinute: 720 },
        ],
        540,
        780,
      ),
    ).toEqual([
      { startMinute: 540, endMinute: 600 },
      { startMinute: 720, endMinute: 780 },
    ]);
    expect(
      overlaps(
        { startMinute: 600, endMinute: 660 },
        { startMinute: 660, endMinute: 720 },
      ),
    ).toBe(false);
  });
  it("uses Bangkok date boundaries", () => {
    expect(roomDate(new Date("2026-09-10T18:00:00Z"))).toBe("2026-09-11");
    expect(roomMinute(now)).toBe(540);
  });
  it.each(["9:00", "24:00", "12:60", "-1:00"])(
    "rejects invalid time %s",
    (value) => expect(() => parseRoomTime(value)).toThrow(),
  );
  it.each([
    ["2026-09-13", 600, 660],
    ["2026-09-11", 525, 600],
    ["2026-09-11", 600, 605],
    ["2026-09-11", 600, 1275],
    ["2026-09-11", 601, 660],
  ])("rejects invalid interval %s %s %s", (date, start, end) =>
    expect(() =>
      validateRoomInterval(
        date as string,
        { startMinute: start as number, endMinute: end as number },
        now,
      ),
    ).toThrow(),
  );
  it("accepts immediate starts between grid boundaries", () =>
    expect(() =>
      validateRoomInterval(
        "2026-09-11",
        { startMinute: 547, endMinute: 570 },
        new Date("2026-09-11T02:07:00Z"),
        true,
      ),
    ).not.toThrow());
  it("permits tomorrow morning and overnight booking, but never tomorrow now", () => {
    const late = new Date("2026-09-11T16:30:00Z");
    expect(() =>
      validateRoomInterval(
        "2026-09-12",
        { startMinute: 420, endMinute: 480 },
        late,
      ),
    ).not.toThrow();
    expect(() =>
      validateRoomInterval(
        "2026-09-12",
        { startMinute: 420, endMinute: 480 },
        late,
        true,
      ),
    ).toThrow("today only");
    expect(() =>
      validateRoomInterval(
        "2026-09-11",
        { startMinute: 420, endMinute: 480 },
        late,
      ),
    ).toThrow("passed");
  });
  it("rolls the date window at Bangkok midnight and rejects invalid calendar dates", () => {
    const midnight = new Date("2026-09-11T17:00:00Z");
    expect(() =>
      validateRoomInterval(
        "2026-09-11",
        { startMinute: 600, endMinute: 660 },
        midnight,
      ),
    ).toThrow("today or tomorrow");
    expect(() =>
      validateRoomInterval(
        "2026-09-13",
        { startMinute: 600, endMinute: 660 },
        midnight,
      ),
    ).not.toThrow();
    expect(() =>
      validateRoomInterval(
        "2026-02-30",
        { startMinute: 600, endMinute: 660 },
        midnight,
      ),
    ).toThrow();
  });
});
describe("Wise room evidence", () => {
  const plan = {
    wiseSessionId: "a",
    startMinute: 600,
    endMinute: 660,
    status: "assigned",
    assignedRoom: "Focus",
    canonicalKey: "alice",
  };
  const online = wise({ type: "SCHEDULED", location: "" });
  const members = new Map([["teacher", "alice"]]);
  it("scopes blank online locations to the matching current classroom plan", () => {
    const evidence = buildRoomEvidence(
      [online],
      "2026-09-11",
      ["Focus", "Cool"],
      members,
      [plan],
    );
    expect(evidence.uncertain).toEqual([]);
    expect(evidence.blocks[0]).toMatchObject({
      room: "Focus",
      roomSource: "classroom_plan",
      remote: false,
    });
  });
  it.each([
    { canonicalKey: "bob" },
    { startMinute: 615 },
    { assignedRoom: "Inactive" },
    { status: "needs_review" },
    { endMinute: 675 },
  ])("never trusts a mismatched or unassignable plan: %j", (change) => {
    const evidence = buildRoomEvidence(
      [online],
      "2026-09-11",
      ["Focus"],
      members,
      [{ ...plan, ...change }],
    );
    expect(evidence.blocks[0].room).toBeNull();
    expect(evidence.uncertain).toHaveLength(1);
  });
  it("keeps Wise locations authoritative and never uses a plan to mask an unknown location", () => {
    expect(
      buildRoomEvidence(
        [{ ...online, location: "Cool" }],
        "2026-09-11",
        ["Focus", "Cool"],
        members,
        [plan],
      ).blocks[0],
    ).toMatchObject({ room: "Cool", roomSource: "wise" });
    expect(
      buildRoomEvidence(
        [{ ...online, location: "Unknown" }],
        "2026-09-11",
        ["Focus"],
        members,
        [plan],
      ).uncertain,
    ).toHaveLength(1);
    expect(
      buildRoomEvidence(
        [{ ...online, type: "OFFLINE" }],
        "2026-09-11",
        ["Focus"],
        members,
        [plan],
      ).uncertain,
    ).toHaveLength(1);
    expect(
      buildRoomEvidence(
        [{ ...online, meetingStatus: "CANCELLED" }],
        "2026-09-11",
        ["Focus"],
        members,
        [plan],
      ).blocks,
    ).toEqual([]);
  });
  it("requires a deletion event and an exact current Wise not-found response", () => {
    const missing = new Error(
      'Wise API 400: {"status":400,"message":"Session not found!"} (https://api.wiseapp.live/user/classes/a/sessions/b)',
    );
    expect(confirmsRoomSessionDeletion(missing, true)).toBe(true);
    expect(confirmsRoomSessionDeletion(missing, false)).toBe(false);
    expect(
      confirmsRoomSessionDeletion(
        new Error(
          'Wise API 404: {"message":"Route not found"} (https://api.wiseapp.live/path)',
        ),
        true,
      ),
    ).toBe(false);
    expect(
      confirmsRoomSessionDeletion(
        new Error(
          'Wise API 401: {"message":"Session not found!"} (https://api.wiseapp.live/path)',
        ),
        true,
      ),
    ).toBe(false);
    expect(confirmsRoomSessionDeletion(new Error("fetch failed"), true)).toBe(
      false,
    );
  });
  it("rejects malformed detail evidence instead of treating it as an empty room", () => {
    expect(() =>
      buildRoomEvidence(
        [wise({ scheduledEndTime: "2026-09-11T02:00:00Z" })],
        "2026-09-11",
        ["Focus"],
        new Map(),
      ),
    ).toThrow("Invalid Wise room evidence");
  });
  it("normalizes physical names and keeps unknown teachers blocking", () => {
    const evidence = buildRoomEvidence(
      [wise({ location: "Iconic" })],
      "2026-09-11",
      ["Iconic (TV)"],
      new Map(),
    );
    expect(evidence.blocks[0]).toMatchObject({
      room: "Iconic (TV)",
      canonicalKey: null,
      blocking: true,
    });
  });
  it("drops cancelled classes and retains completed history without blocking", () => {
    const evidence = buildRoomEvidence(
      [
        wise({ meetingStatus: "CANCELLED" }),
        wise({ _id: "b", meetingStatus: "COMPLETED" }),
      ],
      "2026-09-11",
      ["Focus"],
      new Map(),
    );
    expect(evidence.blocks).toHaveLength(1);
    expect(evidence.blocks[0].blocking).toBe(false);
  });
  it("treats unknown locations and modes as uncertain occupancy", () => {
    expect(
      buildRoomEvidence(
        [wise({ type: "UNKNOWN", location: "Mystery" })],
        "2026-09-11",
        ["Focus"],
        new Map(),
      ).uncertain,
    ).toEqual([{ startMinute: 600, endMinute: 660 }]);
  });
  it("proves isolated online classes remote, but not online classes chained to onsite", () => {
    const online = wise({ type: "ONLINE", location: undefined });
    const members = new Map([["teacher", "alice"]]);
    expect(
      buildRoomEvidence([online], "2026-09-11", ["Focus"], members).blocks[0]
        .remote,
    ).toBe(true);
    const onsite = wise({
      _id: "b",
      scheduledStartTime: "2026-09-11T04:30:00Z",
      scheduledEndTime: "2026-09-11T05:30:00Z",
    });
    expect(
      buildRoomEvidence([online, onsite], "2026-09-11", ["Focus"], members)
        .blocks[0].remote,
    ).toBe(false);
  });
  it("clips cross-midnight occupancy to today's interval", () => {
    expect(
      buildRoomEvidence(
        [
          wise({
            scheduledStartTime: "2026-09-10T16:30:00Z",
            scheduledEndTime: "2026-09-10T18:30:00Z",
          }),
        ],
        "2026-09-11",
        ["Focus"],
        new Map(),
      ).blocks[0],
    ).toMatchObject({ startMinute: 0, endMinute: 90 });
  });
});
describe("LINE room routing", () => {
  it("requires an exact command prefix", () => {
    expect(isRoomText("/roommates")).toBe(false);
    expect(isRoomText("/ROOM free")).toBe(true);
  });
  it("separates room messages and postbacks from the parent classifier", () => {
    const source = { type: "group", groupId: "group", userId: "tutor" };
    const { room, otherPayload } = splitRoomEvents({
      events: [
        {
          type: "message",
          source,
          webhookEventId: "1",
          message: { type: "text", text: "/room" },
        },
        {
          type: "postback",
          source,
          webhookEventId: "2",
          postback: { data: "room:action", params: { time: "14:00" } },
        },
        { type: "message", source, message: { type: "text", text: "Hello" } },
      ],
    });
    expect(room).toHaveLength(2);
    expect(room[1]).toMatchObject({
      scope: "group",
      params: { time: "14:00" },
    });
    expect(otherPayload.events).toHaveLength(1);
  });
});
