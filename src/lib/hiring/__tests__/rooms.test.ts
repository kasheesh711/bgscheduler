import { describe, expect, it } from "vitest";
import { overlapsLunch } from "../availability";
import { assignHiringRooms, isWeekendDate, weekendTestFits } from "../rooms";

const at = (hm: string) => new Date(`2026-11-28T${hm}:00+07:00`);
const test = (id: string, from: string, to: string) => ({ id, start: at(from), end: at(to) });

describe("weekend test rooms", () => {
  it("knows Saturday and Sunday", () => {
    expect([isWeekendDate("2026-11-28"), isWeekendDate("2026-11-29"), isWeekendDate("2026-11-30")]).toEqual([true, true, false]);
  });

  it("gives rooms in order and skips a room a class holds", () => {
    const classes = [{ room: "I learned (online)", start: at("09:00"), end: at("11:00") }];
    const rooms = assignHiringRooms([test("a", "10:00", "12:00"), test("b", "10:00", "12:00"), test("c", "10:00", "12:00")], classes);
    expect([...rooms.values()]).toEqual(["Hope (online)", "HR room", null]);
  });

  it("offers a time only while a room is free and no booked test loses its room", () => {
    const booked = [test("a", "10:00", "12:00"), test("b", "10:00", "12:00"), test("c", "11:00", "13:00")];
    expect(weekendTestFits({ start: at("10:00"), end: at("12:00") }, booked, [])).toBe(false);
    expect(weekendTestFits({ start: at("12:00"), end: at("14:00") }, booked, [])).toBe(true);
    // The new test would get a room but push booked "c" out of its room.
    expect(weekendTestFits({ start: at("09:00"), end: at("11:45") }, booked.slice(0, 2).concat(test("c", "11:30", "13:30")), [])).toBe(false);
  });
});

describe("mock lunch", () => {
  it("blocks any mock that touches 12:00–13:00", () => {
    expect([overlapsLunch(660, 720), overlapsLunch(720, 780), overlapsLunch(735, 795), overlapsLunch(780, 840)]).toEqual([false, true, true, false]);
  });
});
