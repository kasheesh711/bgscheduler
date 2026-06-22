import { describe, expect, it } from "vitest";
import {
  CONTINENTAL_BOUNDS,
  DOT_MAP_VIEWBOX,
  outOfBoundsLabel,
  projectLatLng,
} from "../dot-map";

describe("projectLatLng", () => {
  it("maps the south-west corner to (0, height)", () => {
    const p = projectLatLng(CONTINENTAL_BOUNDS.latMin, CONTINENTAL_BOUNDS.lngMin);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(0, 6);
    expect(p!.y).toBeCloseTo(DOT_MAP_VIEWBOX.height, 6);
  });

  it("maps the north-east corner to (width, 0)", () => {
    const p = projectLatLng(CONTINENTAL_BOUNDS.latMax, CONTINENTAL_BOUNDS.lngMax);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(DOT_MAP_VIEWBOX.width, 6);
    expect(p!.y).toBeCloseTo(0, 6);
  });

  it("maps the centre of the bounds to the centre of the viewBox", () => {
    const midLat = (CONTINENTAL_BOUNDS.latMin + CONTINENTAL_BOUNDS.latMax) / 2;
    const midLng = (CONTINENTAL_BOUNDS.lngMin + CONTINENTAL_BOUNDS.lngMax) / 2;
    const p = projectLatLng(midLat, midLng);
    expect(p!.x).toBeCloseTo(DOT_MAP_VIEWBOX.width / 2, 6);
    expect(p!.y).toBeCloseTo(DOT_MAP_VIEWBOX.height / 2, 6);
  });

  it("respects a custom viewBox", () => {
    const p = projectLatLng(CONTINENTAL_BOUNDS.latMax, CONTINENTAL_BOUNDS.lngMax, {
      width: 100,
      height: 50,
    });
    expect(p!.x).toBeCloseTo(100, 6);
    expect(p!.y).toBeCloseTo(0, 6);
  });

  it("returns null for Alaska, Hawaii, and out-of-bounds coordinates", () => {
    expect(projectLatLng(64.2, -149.5)).toBeNull(); // Fairbanks, AK
    expect(projectLatLng(21.3, -157.8)).toBeNull(); // Honolulu, HI
    expect(projectLatLng(50.1, -100)).toBeNull(); // lat above max
    expect(projectLatLng(40, -130)).toBeNull(); // lng west of min
  });

  it("returns null for null/undefined/NaN inputs", () => {
    expect(projectLatLng(null, -100)).toBeNull();
    expect(projectLatLng(40, undefined)).toBeNull();
    expect(projectLatLng(Number.NaN, -100)).toBeNull();
    expect(projectLatLng(40, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("outOfBoundsLabel", () => {
  it("upper-cases a two-letter state abbreviation", () => {
    expect(outOfBoundsLabel("ak")).toBe("AK");
    expect(outOfBoundsLabel("HI")).toBe("HI");
    expect(outOfBoundsLabel(" pr ")).toBe("PR");
  });

  it("returns null for empty or missing input", () => {
    expect(outOfBoundsLabel(null)).toBeNull();
    expect(outOfBoundsLabel(undefined)).toBeNull();
    expect(outOfBoundsLabel("")).toBeNull();
    expect(outOfBoundsLabel("   ")).toBeNull();
  });
});
