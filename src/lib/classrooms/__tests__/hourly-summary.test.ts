import { describe, expect, it } from "vitest";
import { formatClassroomDaySummary, formatHourLabel, summarizeClassroomDay, summarizeClassroomHours, type ClassroomHourItem } from "../hourly-summary";

const bounds = { startMinute: 9 * 60, endMinute: 12 * 60, roomCount: 2 };

describe("formatHourLabel", () => {
  it("pads to H:MM", () => {
    expect(formatHourLabel(660)).toBe("11:00");
    expect(formatHourLabel(540)).toBe("09:00");
    expect(formatHourLabel(0)).toBe("00:00");
  });
});

describe("summarizeClassroomHours", () => {
  it("counts a class spanning two hours in both hour buckets", () => {
    const items: ClassroomHourItem[] = [{ startMinute: 570, endMinute: 630, needsCentreRoom: true, placed: true }]; // 09:30-10:30
    const hours = summarizeClassroomHours(items, bounds);
    expect(hours.find(h => h.hourStart === 540)?.classes).toBe(1);
    expect(hours.find(h => h.hourStart === 600)?.classes).toBe(1);
    expect(hours.find(h => h.hourStart === 660)?.classes).toBe(0);
  });

  it("never lets a remote item contribute to roomsNeeded", () => {
    const items: ClassroomHourItem[] = [
      { startMinute: 540, endMinute: 600, needsCentreRoom: false, placed: false }, // remote
    ];
    const hours = summarizeClassroomHours(items, bounds);
    expect(hours.find(h => h.hourStart === 540)?.roomsNeeded).toBe(0);
  });

  it("increments noRoom only for a running item that needs a centre room and isn't placed", () => {
    const items: ClassroomHourItem[] = [
      { startMinute: 540, endMinute: 600, needsCentreRoom: true, placed: false }, // unplaced, needs room
      { startMinute: 540, endMinute: 600, needsCentreRoom: true, placed: true }, // placed
      { startMinute: 540, endMinute: 600, needsCentreRoom: false, placed: false }, // remote, doesn't count
    ];
    const hours = summarizeClassroomHours(items, bounds);
    expect(hours.find(h => h.hourStart === 540)?.noRoom).toBe(1);
  });

  it("marks over true iff roomsNeeded exceeds roomCount, independent of noRoom", () => {
    const overNoNoRoom: ClassroomHourItem[] = [
      { startMinute: 540, endMinute: 600, needsCentreRoom: true, placed: true },
      { startMinute: 540, endMinute: 600, needsCentreRoom: true, placed: true },
      { startMinute: 540, endMinute: 600, needsCentreRoom: true, placed: true }, // 3 > roomCount(2), but all placed
    ];
    const hours1 = summarizeClassroomHours(overNoNoRoom, bounds);
    const hour1 = hours1.find(h => h.hourStart === 540)!;
    expect(hour1.over).toBe(true);
    expect(hour1.noRoom).toBe(0);

    const notOverWithNoRoom: ClassroomHourItem[] = [
      { startMinute: 540, endMinute: 600, needsCentreRoom: true, placed: false },
    ];
    const hours2 = summarizeClassroomHours(notOverWithNoRoom, bounds);
    const hour2 = hours2.find(h => h.hourStart === 540)!;
    expect(hour2.over).toBe(false);
    expect(hour2.noRoom).toBe(1);
  });
});

describe("summarizeClassroomDay", () => {
  it("counts classes/noRoom as whole-day totals, not a sum of hourly buckets", () => {
    // A class spanning 09:30-10:30 must count once for the day, even though it touches two hour buckets.
    const items: ClassroomHourItem[] = [
      { startMinute: 570, endMinute: 630, needsCentreRoom: true, placed: false },
    ];
    const day = summarizeClassroomDay(items, bounds);
    expect(day.classes).toBe(1);
    expect(day.noRoom).toBe(1);
  });

  it("finds the earliest 15-minute slice reaching peak demand, extended forward while later slices tie", () => {
    // Two items overlap 10:00-10:30 (peak=2); a third joins 10:15-10:45 keeping the tie through 10:15-10:30.
    const items: ClassroomHourItem[] = [
      { startMinute: 600, endMinute: 630, needsCentreRoom: true, placed: true }, // 10:00-10:30
      { startMinute: 600, endMinute: 630, needsCentreRoom: true, placed: true }, // 10:00-10:30
    ];
    const day = summarizeClassroomDay(items, bounds);
    expect(day.busiest).toEqual({ startMinute: 600, endMinute: 630, needed: 2, roomCount: 2 });
  });

  it("extends the busiest window forward while the peak concurrency ties", () => {
    const items: ClassroomHourItem[] = [
      { startMinute: 600, endMinute: 660, needsCentreRoom: true, placed: true }, // 10:00-11:00
      { startMinute: 615, endMinute: 660, needsCentreRoom: true, placed: true }, // 10:15-11:00 — joins at 10:15, both end together at 11:00
    ];
    const day = summarizeClassroomDay(items, bounds);
    // Peak of 2 holds from 10:15 through to 11:00 (bounds end at 12:00, but items end at 11:00 so peak drops after).
    expect(day.busiest.needed).toBe(2);
    expect(day.busiest.startMinute).toBe(615);
    expect(day.busiest.endMinute).toBe(660);
  });
});

describe("formatClassroomDaySummary", () => {
  it("matches the exact string shape", () => {
    const day = { classes: 5, noRoom: 2, busiest: { startMinute: 660, endMinute: 690, needed: 3, roomCount: 4 } };
    expect(formatClassroomDaySummary(day)).toBe("5 classes · 2 without a room · busiest 11:00–11:30: 3 classes need a room, only 4 rooms");
  });
});
