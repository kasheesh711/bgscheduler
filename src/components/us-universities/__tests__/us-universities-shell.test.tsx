import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
  usePathname: vi.fn(() => "/us-universities"),
  useSearchParams: vi.fn(() => null),
}));

import { UsUniversitiesShell } from "../us-universities-shell";
import type { UsUniversitiesOverview } from "@/lib/us-universities/types";

const OVERVIEW: UsUniversitiesOverview = {
  dataYear: "2024-25",
  totalInstitutions: 200,
  withAcceptanceRate: 180,
  avgAcceptanceRate: 62.5,
  states: [{ state: "CA", count: 50 }],
  controls: [],
  acceptanceBuckets: [],
  scatter: [],
  cip2Options: [{ cip2: "11", label: "Computer & Information Sciences" }],
  acceptanceTrend: [],
  lastImportedAt: "2026-06-01T00:00:00.000Z",
};

describe("UsUniversitiesShell SSR", () => {
  it("renders the header, KPI hero, charts, and results anchor without running the fetch effect", () => {
    const html = renderToStaticMarkup(<UsUniversitiesShell overview={OVERVIEW} />);
    expect(html).toContain("US Universities");
    // KPI hero
    expect(html).toContain("Total universities");
    // Charts present (no tabs)
    expect(html).toContain("Admissions selectivity");
    // Results anchor
    expect(html).toContain('id="us-universities-results"');
    // Sub-header renders (default cards view): count banner + toggle + CSV link present.
    expect(html).toContain("of 200");
    expect(html).toContain("Card view");
    expect(html).toContain("Download CSV");
  });
});

describe("UsUniversitiesShell results sub-header", () => {
  it("renders the count banner, view toggle, sort control, and CSV anchor", () => {
    const html = renderToStaticMarkup(<UsUniversitiesShell overview={OVERVIEW} />);
    expect(html).toContain("of 200");
    expect(html).toContain("Card view");
    expect(html).toContain("Table view");
    expect(html).toContain("/api/us-universities/export?");
    expect(html).toContain("Download CSV");
  });
});
