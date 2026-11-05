import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../model";
import { assessPrestige, prestigeFraction } from "../prestige";
import { validateAssessment } from "../scoring";

describe("university prestige evidence", () => {
  it("gives top UK/US schools more than the named Thai schools without a second degree bonus", async () => {
    const config = configSchema.parse({});
    const result = await assessPrestige(
      [
        { name: "Chula", evidence: "Degree from Chula", completedDegree: true },
        {
          name: "University of Oxford",
          evidence: "Degree from Oxford",
          completedDegree: true,
        },
      ],
      config,
      "catalog",
    );
    expect(result.name).toBe("University of Oxford");
    expect(result.rank).toBe(4);
    expect(result.fraction * 20).toBe(20);
    for (const name of [
      "Chulalongkorn University",
      "Thammasat University",
      "Mahidol University",
    ])
      expect(prestigeFraction({ name, country: "TH", rank: null }) * 20).toBe(
        12,
      );
  });
  it("uses ranking bands and distinguishes an unverified rank from a low rank", () => {
    expect(
      prestigeFraction({ name: "Example", country: "US", rank: 50 }) * 20,
    ).toBe(18);
    expect(
      prestigeFraction({ name: "Example", country: "GB", rank: 100 }),
    ).toBe(0.8);
    expect(
      prestigeFraction({ name: "Example", country: "US", rank: null }) * 20,
    ).toBe(8);
    expect(
      prestigeFraction({ name: "Example", country: "CA", rank: 5 }) * 20,
    ).toBe(12);
  });
  it("does not award points for a short course or an institution with an ambiguous country", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "https://ror.org/one",
            names: [{ value: "Example University" }],
            locations: [{ geonames_details: { country_code: "US" } }],
          },
          {
            id: "https://ror.org/two",
            names: [{ value: "Example University" }],
            locations: [{ geonames_details: { country_code: "GB" } }],
          },
        ],
      }),
    });
    const result = await assessPrestige(
      [
        { name: "Harvard", evidence: "Short course", completedDegree: false },
        {
          name: "Example University",
          evidence: "Completed degree",
          completedDegree: true,
        },
      ],
      configSchema.parse({}),
      "catalog",
      fetcher,
    );
    expect(result.fraction).toBe(0);
    expect(result.rank).toBeNull();
  });
  it("gets country from an exact ROR record and keeps the rank unknown", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "https://ror.org/test",
            names: [{ value: "Exact University" }],
            locations: [{ geonames_details: { country_code: "GB" } }],
          },
        ],
      }),
    });
    const result = await assessPrestige(
      [
        {
          name: "Exact University",
          evidence: "Completed degree",
          completedDegree: true,
        },
      ],
      configSchema.parse({}),
      "catalog",
      fetcher,
    );
    expect(result.country).toBe("GB");
    expect(result.rank).toBeNull();
    expect(result.fraction).toBe(0.4);
    expect(result.sources).toEqual(["https://ror.org/test"]);
  });
  it("resolves an official ROR name to the ranked campus without conflating campuses", async () => {
    const config = configSchema.parse({ universities: [
      { name: "University of Michigan--Ann Arbor", aliases: [], country: "US", rank: 21, edition: "2026-2027", sourceUrl: "https://www.usnews.com/michigan-ann-arbor" },
      { name: "University of Michigan--Dearborn", aliases: [], country: "US", rank: 1200, edition: "2026-2027", sourceUrl: "https://www.usnews.com/michigan-dearborn" },
    ] });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{
      id: "https://ror.org/00jmfr291",
      names: [{ value: "University of Michigan", types: ["ror_display"] }, { value: "University of Michigan–Ann Arbor", types: ["label"] }],
      locations: [{ geonames_details: { country_code: "US" } }],
    }] }) });
    const result = await assessPrestige([{ name: "University of Michigan", evidence: "Degree from Michigan", completedDegree: true }], config, "catalog", fetcher);
    expect(result).toMatchObject({ name: "University of Michigan--Ann Arbor", rank: 21, fraction: 0.9 });
    expect(result.sources).toContain("https://ror.org/00jmfr291");
    const campus = await assessPrestige([{ name: "University of Michigan--Dearborn", evidence: "Degree from Dearborn", completedDegree: true }], config, "catalog", fetcher);
    expect(campus).toMatchObject({ name: "University of Michigan--Dearborn", rank: 1200, fraction: 0.4 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not choose between multiple catalog matches for one ROR record", async () => {
    const config = configSchema.parse({ universities: [
      { name: "Ambiguous College A", aliases: [], country: "US", rank: 21, edition: "2026-2027", sourceUrl: "https://example.org/a" },
      { name: "Ambiguous College B", aliases: [], country: "US", rank: 200, edition: "2026-2027", sourceUrl: "https://example.org/b" },
    ] });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{
      id: "https://ror.org/ambiguous", names: [{ value: "Ambiguous College" }, { value: "Ambiguous College A" }, { value: "Ambiguous College B" }],
      locations: [{ geonames_details: { country_code: "US" } }],
    }] }) });
    const result = await assessPrestige([{ name: "Ambiguous College", evidence: "Degree", completedDegree: true }], config, "catalog", fetcher);
    expect(result.fraction).toBe(0);
    expect(result.rank).toBeNull();
  });
  it("rejects invented university evidence even when the institution is in the reference list", () => {
    const value = {
      criteria: ["degree", "subject", "curriculum", "teaching", "english"].map(
        (id) => ({ id, result: "unknown", evidence: "", reason: "Missing" }),
      ),
      subjects: [],
      summary: "No evidence",
      universities: [
        {
          name: "Harvard",
          evidence: "Degree from Harvard",
          completedDegree: true,
        },
      ],
    };
    expect(() =>
      validateAssessment(value, "A different education record"),
    ).toThrow(/source/);
  });
});
