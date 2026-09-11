import { describe, expect, it } from "vitest";
import { roomSelection } from "../selection";
import type { RoomDayView } from "../service";

const view: RoomDayView = {
  date: "2026-09-11",
  todayDate: "2026-09-11",
  tomorrowDate: "2026-09-12",
  nowMinute: 950,
  tutorName: "Tutor",
  fresh: true,
  availabilityStatus: "ready",
  checkedAt: "2026-09-11T08:50:00Z",
  writesEnabled: true,
  uncertain: [],
  classes: [],
  reservations: [],
  rooms: [
    {
      id: "focus",
      name: "Focus",
      capacity: 2,
      hasTv: false,
      category: "standard",
      blocks: [],
      free: [{ startMinute: 420, endMinute: 1260 }],
    },
  ],
};
describe("room availability presentation", () => {
  it("separates stale data, invalid input, unresolved rooms, and genuine zero rooms", () => {
    expect(
      roomSelection(
        { ...view, fresh: false },
        view.date,
        "16:00",
        "17:00",
        false,
      ).status,
    ).toBe("unavailable");
    expect(roomSelection(view, view.date, "09:00", "10:00", false).status).toBe(
      "invalid",
    );
    expect(
      roomSelection(
        { ...view, uncertain: [{ startMinute: 960, endMinute: 1020 }] },
        view.date,
        "16:00",
        "17:00",
        false,
      ).status,
    ).toBe("unresolved");
    expect(
      roomSelection({ ...view, rooms: [] }, view.date, "16:00", "17:00", false),
    ).toMatchObject({ status: "ready", available: [] });
  });
  it("does not show today's rooms while tomorrow is loading", () => {
    expect(
      roomSelection(view, view.tomorrowDate, "07:00", "08:00", false),
    ).toMatchObject({ status: "loading", available: [] });
    expect(
      roomSelection(
        { ...view, date: view.tomorrowDate },
        view.tomorrowDate,
        "07:00",
        "08:00",
        false,
      ),
    ).toMatchObject({ status: "ready", valid: true });
    expect(
      roomSelection(
        { ...view, date: view.tomorrowDate },
        view.tomorrowDate,
        "07:00",
        "08:00",
        true,
      ).valid,
    ).toBe(false);
  });
  it("allows adjacent unresolved intervals without blocking the selected interval", () => {
    const result = roomSelection(
      { ...view, uncertain: [{ startMinute: 1020, endMinute: 1080 }] },
      view.date,
      "16:00",
      "17:00",
      false,
    );
    expect(result.status).toBe("ready");
    expect(result.available).toHaveLength(1);
  });
});
