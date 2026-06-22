import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
  usePathname: vi.fn(() => "/us-universities"),
  useSearchParams: vi.fn(() => null),
}));

import { UsUniversitiesShell } from "../us-universities-shell";
import type { UsUniversitiesOverview } from "@/lib/us-universities/types";

const overview: UsUniversitiesOverview = {
  dataYear: "2024-25",
  totalInstitutions: 1432,
  withAcceptanceRate: 1100,
  avgAcceptanceRate: 62,
  states: [
    { state: "CA", count: 120 },
    { state: "NY", count: 90 },
  ],
  controls: [
    { control: 1, label: "Public", count: 50 },
    { control: 2, label: "Private nonprofit", count: 30 },
    { control: 3, label: "Private for-profit", count: 5 },
  ],
  acceptanceBuckets: [{ label: "Under 20%", min: 0, max: 20, count: 12 }],
  scatter: [],
  cip2Options: [],
  acceptanceTrend: [],
  lastImportedAt: null,
};

describe("UsUniversitiesShell Console layout", () => {
  it("renders the KPI hero, the overview charts, and a results anchor", () => {
    const html = renderToStaticMarkup(<UsUniversitiesShell overview={overview} />);
    // KPI hero
    expect(html).toContain("Total universities");
    expect(html).toContain("1,432");
    expect(html).toContain("Public / private");
    // charts present + click-to-filter affordance wired (onFilter passed)
    expect(html).toContain("Admissions selectivity");
    expect(html).toContain("Click to filter");
    // results scroll target
    expect(html).toContain('id="us-universities-results"');
  });
});
