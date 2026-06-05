import { describe, expect, it } from "vitest";
import {
  RECOMMEND_MAX_SLOTS,
  buildRecommendedSlots,
  type FutureClassInterval,
  type FutureRoomBlock,
} from "../recommend";

const NOW = new Date("2026-06-10T00:00:00+07:00");

function cls(startIso: string, endIso: string): FutureClassInterval {
  return { start: new Date(startIso), end: new Date(endIso) };
}

function block(room: string, startIso: string, endIso: string): FutureRoomBlock {
  return { room, start: new Date(startIso), end: new Date(endIso) };
}

describe("buildRecommendedSlots", () => {
  it("proposes a room-checked slot right after the day's last class", () => {
    const slots = buildRecommendedSlots({
      classes: [cls("2026-06-10T16:00:00+07:00", "2026-06-10T17:00:00+07:00")],
      roomBlocks: [],
      rooms: ["Tesla"],
      now: NOW,
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].kind).toBe("after_class");
    expect(slots[0].room).toBe("Tesla");
    expect(new Date(slots[0].start).toISOString()).toBe(new Date("2026-06-10T17:00:00+07:00").toISOString());
    expect(new Date(slots[0].end).toISOString()).toBe(new Date("2026-06-10T18:00:00+07:00").toISOString());
    expect(slots[0].label).toContain("Tesla");
  });

  it("proposes a gap slot for a >=1h break between same-day classes, plus the after-class slot", () => {
    const slots = buildRecommendedSlots({
      classes: [
        cls("2026-06-10T10:00:00+07:00", "2026-06-10T11:00:00+07:00"),
        cls("2026-06-10T13:00:00+07:00", "2026-06-10T14:00:00+07:00"),
      ],
      roomBlocks: [],
      rooms: ["Tesla"],
      now: NOW,
    });
    expect(slots.map((slot) => slot.kind)).toEqual(["gap", "after_class"]);
    expect(new Date(slots[0].start).toISOString()).toBe(new Date("2026-06-10T11:00:00+07:00").toISOString());
    expect(new Date(slots[1].start).toISOString()).toBe(new Date("2026-06-10T14:00:00+07:00").toISOString());
  });

  it("does not propose a gap slot when the break is under an hour", () => {
    const slots = buildRecommendedSlots({
      classes: [
        cls("2026-06-10T10:00:00+07:00", "2026-06-10T11:00:00+07:00"),
        cls("2026-06-10T11:30:00+07:00", "2026-06-10T12:30:00+07:00"),
      ],
      roomBlocks: [],
      rooms: ["Tesla"],
      now: NOW,
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].kind).toBe("after_class");
  });

  it("skips a busy room and picks a free one for the slot", () => {
    const slots = buildRecommendedSlots({
      classes: [cls("2026-06-10T16:00:00+07:00", "2026-06-10T17:00:00+07:00")],
      roomBlocks: [block("Tesla", "2026-06-10T17:00:00+07:00", "2026-06-10T18:00:00+07:00")],
      rooms: ["Tesla", "Nerd"],
      now: NOW,
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].room).toBe("Nerd");
  });

  it("drops a slot entirely when every room is busy (weekend room pressure)", () => {
    const slots = buildRecommendedSlots({
      // Saturday 2026-06-13.
      classes: [cls("2026-06-13T16:00:00+07:00", "2026-06-13T17:00:00+07:00")],
      roomBlocks: [block("Tesla", "2026-06-13T17:00:00+07:00", "2026-06-13T18:00:00+07:00")],
      rooms: ["Tesla"],
      now: NOW,
    });
    expect(slots).toHaveLength(0);
  });

  it("matches room occupancy ignoring a trailing (TV) suffix and case", () => {
    const slots = buildRecommendedSlots({
      classes: [cls("2026-06-10T16:00:00+07:00", "2026-06-10T17:00:00+07:00")],
      roomBlocks: [block("tesla (TV)", "2026-06-10T17:00:00+07:00", "2026-06-10T18:00:00+07:00")],
      rooms: ["Tesla"],
      now: NOW,
    });
    expect(slots).toHaveLength(0);
  });

  it("excludes classes that have already started and returns nothing without upcoming classes", () => {
    const slots = buildRecommendedSlots({
      classes: [cls("2026-06-09T16:00:00+07:00", "2026-06-09T17:00:00+07:00")],
      roomBlocks: [],
      rooms: ["Tesla"],
      now: NOW,
    });
    expect(slots).toHaveLength(0);
  });

  it("draws from at most the next 3 class-days and caps the slot count", () => {
    const classes: FutureClassInterval[] = [];
    // Five distinct future days, each with one class -> after-class slots, capped.
    for (let day = 11; day <= 15; day += 1) {
      const d = String(day).padStart(2, "0");
      classes.push(cls(`2026-06-${d}T16:00:00+07:00`, `2026-06-${d}T17:00:00+07:00`));
    }
    const slots = buildRecommendedSlots({ classes, roomBlocks: [], rooms: ["Tesla"], now: NOW });
    const distinctDays = new Set(
      slots.map((slot) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(
          new Date(slot.start),
        ),
      ),
    );
    expect(distinctDays.size).toBeLessThanOrEqual(3);
    expect(slots.length).toBeLessThanOrEqual(RECOMMEND_MAX_SLOTS);
  });
});
