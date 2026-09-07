import { describe, expect, it } from "vitest";
import { proposeRoomProfiles } from "../room-profile-planner";
import { DEFAULT_CLASSROOM_ROOMS } from "../rooms";
import type { AssignmentSession } from "../assignment-engine";

const rooms = DEFAULT_CLASSROOM_ROOMS.map((room, i) => ({ ...room, id: String(i) }));
const session = (name: string, count = 1): AssignmentSession => ({ canonicalKey: name, tutorDisplayName: name, groupId: name, wiseTeacherId: name, wiseSessionId: name,
  startTime: new Date("2026-09-12T02:00:00Z"), endTime: new Date("2026-09-12T03:00:00Z"), startMinute: 540, endMinute: 600,
  weekday: 6, wiseStatus: "CONFIRMED", sessionType: "OFFLINE", studentCount: count });

describe("usual room initialization", () => {
  it("retains preferred primary rooms, TV requirements and Gift's fixed room", () => {
    const profiles = proposeRoomProfiles({ sessions: [session("Mek"), session("Gift"), session("Da")], rooms, history: [], existing: [] });
    const names = (key: string) => profiles.find(p => p.canonicalKey === key)!.roomIds.map(id => rooms.find(r => r.id === id)!);
    expect(names("mek")[0].name).toBe("Iconic (TV)");
    expect(names("mek").every(r => r.hasTv)).toBe(true);
    expect(names("gift").map(r => r.name)).toEqual(["Joy (TV)"]);
    expect(names("da")[0].name).toBe("Do It");
  });
  it("does not replace persisted sets when history, demand or snapshot identities change", () => {
    expect(proposeRoomProfiles({ sessions: [{ ...session("Da"), groupId: "rotated" }], rooms: rooms.slice().reverse(), history: [{ canonicalKey: "Da", room: "Cool", minutes: 999 }],
      existing: [{ canonicalKey: "da", revision: 3, rooms: ["Do It", "Focus"] }] })).toEqual([]);
  });
  it("keeps an unavailable preferred primary visible instead of silently replacing it", () => {
    const unavailable = rooms.map(room => room.name === "Do It" ? { ...room, active: false } : room);
    const profiles = proposeRoomProfiles({ sessions: [session("Da")], rooms: unavailable, history: [], existing: [] });
    expect(rooms.find(room => room.id === profiles[0].roomIds[0])!.name).toBe("Do It");
    expect(profiles[0].roomIds).toHaveLength(3);
  });
  it("uses compatibility before history and accounts for competing demand", () => {
    const profiles = proposeRoomProfiles({ sessions: [session("New teacher", 8)], rooms, existing: [], history: [{ canonicalKey: "New teacher", room: "Focus", minutes: 500 }] });
    expect(profiles[0].roomIds.map(id => rooms.find(r => r.id === id)!.name)).toEqual(["Relax (TV)"]);
    const catalog = ["A", "B", "C", "D"].map((name, i) => ({ ...rooms[0], name, id: name, sortOrder: i }));
    const contested = proposeRoomProfiles({ sessions: [session("New"), session("Established")], rooms: catalog,
      existing: [{ canonicalKey: "established", revision: 1, rooms: ["A"] }], history: [{ canonicalKey: "New", room: "A", minutes: 500 }] });
    expect(contested[0].roomIds).toEqual(["B", "C", "D"]);
  });
  it("never persists unresolved identities or remote-only teachers", () => {
    expect(proposeRoomProfiles({ sessions: [{ ...session("Unknown"), canonicalKey: null }, { ...session("Remote"), sessionType: "SCHEDULED" }], rooms, history: [], existing: [] })).toEqual([]);
  });
});
