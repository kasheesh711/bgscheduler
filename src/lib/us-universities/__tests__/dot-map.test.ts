import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTINENTAL_BOUNDS,
  DOT_MAP_VIEWBOX,
  outOfBoundsLabel,
  projectLatLng,
  buildDotMapPoints,
  resolveSinglePlacement,
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

describe("buildDotMapPoints", () => {
  const rows = [
    { unitId: 1, instName: "Mid U", latitude: 37, longitude: -95.5 },
    { unitId: 2, instName: "Alaska U", latitude: 64.2, longitude: -149.5 }, // out of bounds
    { unitId: 3, instName: "No coords U", latitude: null, longitude: null },
    { unitId: 4, instName: "NE corner U", latitude: 50, longitude: -66 },
  ];

  it("keeps only rows that project inside the continental frame", () => {
    const points = buildDotMapPoints(rows);
    expect(points.map((p) => p.unitId)).toEqual([1, 4]);
  });

  it("carries unitId, name, and projected coordinates onto each point", () => {
    const [first] = buildDotMapPoints(rows);
    expect(first.unitId).toBe(1);
    expect(first.name).toBe("Mid U");
    expect(first.x).toBeGreaterThan(0);
    expect(first.y).toBeGreaterThan(0);
  });

  it("returns an empty array when nothing is plottable", () => {
    expect(
      buildDotMapPoints([{ unitId: 9, instName: "AK", latitude: 64, longitude: -150 }]),
    ).toEqual([]);
  });
});

describe("resolveSinglePlacement", () => {
  it("returns a pin for an in-bounds institution", () => {
    const placement = resolveSinglePlacement({
      unitId: 1,
      instName: "Mid U",
      stateAbbr: "KS",
      latitude: 37,
      longitude: -95.5,
    });
    expect(placement.kind).toBe("pin");
    if (placement.kind === "pin") {
      expect(placement.point.unitId).toBe(1);
      expect(placement.point.x).toBeGreaterThan(0);
    }
  });

  it("returns a chip for an out-of-bounds but located institution (AK/HI)", () => {
    const placement = resolveSinglePlacement({
      unitId: 2,
      instName: "Alaska U",
      stateAbbr: "AK",
      latitude: 64.2,
      longitude: -149.5,
    });
    expect(placement).toEqual({ kind: "chip", label: "AK" });
  });

  it("returns none when the institution has no coordinates", () => {
    const placement = resolveSinglePlacement({
      unitId: 3,
      instName: "No coords U",
      stateAbbr: "TX",
      latitude: null,
      longitude: null,
    });
    expect(placement).toEqual({ kind: "none" });
  });

  it("returns none for out-of-bounds coords when no state abbr is available", () => {
    const placement = resolveSinglePlacement({
      unitId: 4,
      instName: "Mystery U",
      stateAbbr: null,
      latitude: 64.2,
      longitude: -149.5,
    });
    expect(placement).toEqual({ kind: "none" });
  });
});

describe("dot-map isolation", () => {
  it("imports nothing beyond the us-universities domain types", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../dot-map.ts", import.meta.url)),
      "utf8",
    );
    const importLines = src.split("\n").filter((l: string) => l.trimStart().startsWith("import"));
    // Only allowed import is the type-only pull from "./types".
    for (const line of importLines) {
      expect(line).toContain('from "./types"');
    }
  });
});
