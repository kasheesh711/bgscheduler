import { describe, expect, it } from "vitest";
import {
  acceptanceBucketToFilter,
  controlToFilter,
  stateToFilter,
  topStates,
} from "../chart-filters";
import type { AcceptanceBucket, StateFacet } from "../types";

describe("acceptanceBucketToFilter", () => {
  it("maps a bucket to min/max acceptance filter bounds", () => {
    const bucket: AcceptanceBucket = { label: "Under 20%", min: 0, max: 20, count: 12 };
    expect(acceptanceBucketToFilter(bucket)).toEqual({ minAcceptance: 0, maxAcceptance: 20 });
  });

  it("carries non-zero bounds", () => {
    const bucket: AcceptanceBucket = { label: "50–100%", min: 50, max: 100, count: 3 };
    expect(acceptanceBucketToFilter(bucket)).toEqual({ minAcceptance: 50, maxAcceptance: 100 });
  });
});

describe("stateToFilter", () => {
  it("wraps the state abbreviation in a single-element states array", () => {
    expect(stateToFilter("CA")).toEqual({ states: ["CA"] });
  });
});

describe("controlToFilter", () => {
  it("wraps the control code in a single-element control array", () => {
    expect(controlToFilter(1)).toEqual({ control: [1] });
  });
});

describe("topStates", () => {
  const states: StateFacet[] = Array.from({ length: 18 }, (_, index) => ({
    state: `S${String(index).padStart(2, "0")}`,
    count: 100 - index,
  }));

  it("returns the top N states sorted by count descending", () => {
    const top = topStates(states, 15);
    expect(top).toHaveLength(15);
    expect(top[0]).toEqual({ state: "S00", count: 100 });
    expect(top.map((s) => s.state)).not.toContain("S17");
  });

  it("defaults to topN = 15 and does not mutate the input", () => {
    const before = states.map((s) => s.state);
    const top = topStates(states);
    expect(top).toHaveLength(15);
    expect(states.map((s) => s.state)).toEqual(before);
  });

  it("returns all states when fewer than topN", () => {
    const few: StateFacet[] = [
      { state: "TX", count: 5 },
      { state: "NY", count: 9 },
    ];
    expect(topStates(few, 15).map((s) => s.state)).toEqual(["NY", "TX"]);
  });
});
