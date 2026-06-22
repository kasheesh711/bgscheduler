import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
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
  it("renders the header, tabs, and the browse table filter bar without running the fetch effect", () => {
    const html = renderToStaticMarkup(<UsUniversitiesShell overview={OVERVIEW} />);
    expect(html).toContain("US Universities");
    expect(html).toContain("Overview");
    expect(html).toContain("Browse");
    expect(html).toContain("Compare");
    // Table is rendered inside the shell (keepMounted) with its filter bar.
    expect(html).toContain("Search institutions");
    // Loading copy renders because the AbortController fetch effect does not run under SSR.
    expect(html).toContain("Loading institutions…");
  });
});
