import { describe, expect, it } from "vitest";
import { addCompareId, removeCompareId } from "../compare-set";

describe("addCompareId", () => {
  it("appends a new id", () => {
    expect(addCompareId([1, 2], 3)).toEqual([1, 2, 3]);
  });

  it("is a no-op when the id is already present (dedupe)", () => {
    expect(addCompareId([1, 2], 2)).toEqual([1, 2]);
  });

  it("is a no-op when at MAX_COMPARE (4)", () => {
    expect(addCompareId([1, 2, 3, 4], 5)).toEqual([1, 2, 3, 4]);
  });

  it("never mutates the input array", () => {
    const original = [1, 2];
    addCompareId(original, 3);
    expect(original).toEqual([1, 2]);
  });

  it("works from an empty list", () => {
    expect(addCompareId([], 7)).toEqual([7]);
  });
});

describe("removeCompareId", () => {
  it("removes a present id", () => {
    expect(removeCompareId([1, 2, 3], 2)).toEqual([1, 3]);
  });

  it("is a no-op when the id is not present", () => {
    expect(removeCompareId([1, 2], 9)).toEqual([1, 2]);
  });

  it("never mutates the input array", () => {
    const original = [1, 2, 3];
    removeCompareId(original, 2);
    expect(original).toEqual([1, 2, 3]);
  });

  it("returns an empty array when removing the last id", () => {
    expect(removeCompareId([5], 5)).toEqual([]);
  });
});
