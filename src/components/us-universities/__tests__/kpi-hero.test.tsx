import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KpiHero, publicPrivateSplit } from "../kpi-hero";
import type { ControlFacet, UsUniversitiesOverview } from "@/lib/us-universities/types";

const CONTROLS: ControlFacet[] = [
  { control: 1, label: "Public", count: 50 },
  { control: 2, label: "Private nonprofit", count: 30 },
  { control: 3, label: "Private for-profit", count: 5 },
];

describe("publicPrivateSplit", () => {
  it("treats control 1 as public and controls 2 + 3 as private", () => {
    expect(publicPrivateSplit(CONTROLS)).toEqual({ public: 50, private: 35 });
  });

  it("returns zeroes for an empty control set", () => {
    expect(publicPrivateSplit([])).toEqual({ public: 0, private: 0 });
  });

  it("ignores unexpected control codes (neither public nor private)", () => {
    const odd: ControlFacet[] = [{ control: 9, label: "Unknown", count: 7 }];
    expect(publicPrivateSplit(odd)).toEqual({ public: 0, private: 0 });
  });
});

describe("KpiHero rendering", () => {
  const overview: UsUniversitiesOverview = {
    dataYear: "2024-25",
    totalInstitutions: 1432,
    withAcceptanceRate: 1100,
    avgAcceptanceRate: 62.4,
    states: [],
    controls: CONTROLS,
    acceptanceBuckets: [],
    scatter: [],
    cip2Options: [],
    lastImportedAt: null,
  };

  it("renders the four KPI tile labels", () => {
    const html = renderToStaticMarkup(<KpiHero overview={overview} />);
    expect(html).toContain("Total universities");
    expect(html).toContain("With acceptance rate");
    expect(html).toContain("Avg. acceptance rate");
    expect(html).toContain("Public / private");
  });

  it("formats numeric KPI values", () => {
    const html = renderToStaticMarkup(<KpiHero overview={overview} />);
    expect(html).toContain("1,432");
    expect(html).toContain("1,100");
    expect(html).toContain("62%");
    expect(html).toContain("50 / 35");
  });

  it("renders an em-dash for a null average acceptance rate", () => {
    const html = renderToStaticMarkup(
      <KpiHero overview={{ ...overview, avgAcceptanceRate: null }} />,
    );
    expect(html).toContain("—");
  });
});
