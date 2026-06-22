import { describe, expect, it } from "vitest";
import { hasAnyValue } from "../dossier-sections";

describe("hasAnyValue", () => {
  it("is true when at least one field is a finite number", () => {
    expect(hasAnyValue([null, undefined, 0])).toBe(true);
    expect(hasAnyValue([null, 42])).toBe(true);
  });

  it("is true when at least one field is a non-empty string", () => {
    expect(hasAnyValue([null, "Berkeley"])).toBe(true);
  });

  it("is false when every field is null/undefined", () => {
    expect(hasAnyValue([null, undefined, null])).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(hasAnyValue([])).toBe(false);
  });

  it("treats NaN and blank/whitespace strings as absent (fail-closed)", () => {
    expect(hasAnyValue([Number.NaN])).toBe(false);
    expect(hasAnyValue([""])).toBe(false);
    expect(hasAnyValue(["   "])).toBe(false);
  });
});
