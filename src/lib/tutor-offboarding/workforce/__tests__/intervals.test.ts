import { describe, expect, it } from "vitest";
import { unionIntervals, intersectIntervals, subtractIntervals, clipIntervals, intervalMinutes, bangkokDayStart, bangkokMonthBounds } from "../intervals";
const hours=(a:number,b:number)=>({start:a*3_600_000,end:b*3_600_000});
describe("exact half-open workforce intervals",()=>{
  it("merges overlap and adjacency without double counting or mutating inputs",()=>{
    const values=[hours(2,4),hours(1,3),hours(4,5)];
    expect(unionIntervals(values)).toEqual([hours(1,5)]);
    expect(values[0]).toEqual(hours(2,4));
    expect(intervalMinutes(values)).toBe(240);
  });
  it("eight shared hours minus an occupied physics hour leave seven",()=>{
    const free=subtractIntervals([hours(9,17)],[hours(9,10)]);
    expect(free).toEqual([hours(10,17)]);
    expect(intervalMinutes(free)).toBe(420);
  });
  it("subtracts overlapping bookings only once and clips outside bookings",()=>{
    expect(subtractIntervals([hours(9,17)],[hours(8,10),hours(9,11),hours(16,20)])).toEqual([hours(11,16)]);
  });
  it("handles holes in both sets and fully covered intervals",()=>{
    expect(subtractIntervals([hours(1,3),hours(5,9)],[hours(0,6),hours(7,8)])).toEqual([hours(6,7),hours(8,9)]);
    expect(subtractIntervals([hours(1,2)],[hours(0,3)])).toEqual([]);
  });
  it("intersects distinct coverage periods and excludes endpoint-only contact",()=>{
    expect(intersectIntervals([hours(1,3),hours(5,9)],[hours(3,5),hours(6,8)])).toEqual([hours(6,8)]);
  });
  it("clips exact overlaps instead of rounding to a display bin",()=>{
    expect(intervalMinutes(clipIntervals([{start:0,end:45*60_000}],{start:30*60_000,end:60*60_000}))).toBe(15);
  });
  it("ignores zero length and rejects invalid bounds",()=>{
    expect(unionIntervals([{start:0,end:0}])).toEqual([]);
    expect(()=>unionIntervals([{start:2,end:1}])).toThrow();
    expect(()=>unionIntervals([{start:NaN,end:1}])).toThrow();
  });
  it("uses Bangkok midnight and rolls December into the next year",()=>{
    expect(bangkokDayStart("2026-03-01")).toBe(Date.parse("2026-02-28T17:00:00Z"));
    expect(bangkokMonthBounds("2026-12")).toEqual({start:Date.parse("2026-11-30T17:00:00Z"),end:Date.parse("2026-12-31T17:00:00Z")});
    expect(()=>bangkokDayStart("2026-02-30")).toThrow();
  });
});
