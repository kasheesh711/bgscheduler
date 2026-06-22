import { describe, expect, it } from "vitest";
import { dossierLocationAriaLabel } from "../institution-profile";

describe("dossierLocationAriaLabel", () => {
  it("includes city and state when both present", () => {
    expect(dossierLocationAriaLabel("Mid U", "Lawrence", "KS")).toBe(
      "Location of Mid U: Lawrence, KS",
    );
  });

  it("uses only the state when city is missing", () => {
    expect(dossierLocationAriaLabel("Mid U", null, "KS")).toBe(
      "Location of Mid U: KS",
    );
  });

  it("uses only the city when state is missing", () => {
    expect(dossierLocationAriaLabel("Mid U", "Lawrence", null)).toBe(
      "Location of Mid U: Lawrence",
    );
  });

  it("falls back to just the name when both are missing", () => {
    expect(dossierLocationAriaLabel("Mid U", null, null)).toBe("Location of Mid U");
  });
});
