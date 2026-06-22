import { describe, expect, it } from "vitest";
import { buildSuggestQuery } from "../institution-search-combobox";

describe("buildSuggestQuery", () => {
  it("builds the search path with a capped page size", () => {
    expect(buildSuggestQuery("mit")).toBe(
      "/api/us-universities/search?search=mit&pageSize=10",
    );
  });

  it("trims surrounding whitespace from the term", () => {
    expect(buildSuggestQuery("  stanford  ")).toBe(
      "/api/us-universities/search?search=stanford&pageSize=10",
    );
  });

  it("URL-encodes spaces and special characters in the term", () => {
    expect(buildSuggestQuery("university of california")).toBe(
      "/api/us-universities/search?search=university+of+california&pageSize=10",
    );
    expect(buildSuggestQuery("a&b")).toBe(
      "/api/us-universities/search?search=a%26b&pageSize=10",
    );
  });

  it("produces an empty search param for an empty term", () => {
    expect(buildSuggestQuery("")).toBe(
      "/api/us-universities/search?search=&pageSize=10",
    );
  });
});
