import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstitutionTable, buildSearchQuery, toggleSort } from "../institution-table";
import type { FilterParams, UsUniversitiesOverview } from "@/lib/us-universities/types";

const OVERVIEW: UsUniversitiesOverview = {
  dataYear: "2024-25",
  totalInstitutions: 200,
  withAcceptanceRate: 180,
  avgAcceptanceRate: 62.5,
  states: [
    { state: "CA", count: 50 },
    { state: "TX", count: 40 },
  ],
  controls: [],
  acceptanceBuckets: [],
  scatter: [],
  cip2Options: [{ cip2: "11", label: "Computer & Information Sciences" }],
  lastImportedAt: "2026-06-01T00:00:00.000Z",
};

describe("buildSearchQuery", () => {
  it("csv-joins states and control, omits undefined values, and always sets page/sort/dir/pageSize", () => {
    const filters: FilterParams = {
      search: "  tech  ",
      states: ["CA", "TX"],
      control: [1, 2],
      maxAcceptance: 30,
      cip2: "11",
      sort: "acceptanceRate",
      dir: "desc",
      page: 2,
      pageSize: 25,
    };
    const params = new URLSearchParams(buildSearchQuery(filters));
    expect(params.get("search")).toBe("tech");
    expect(params.get("states")).toBe("CA,TX");
    expect(params.get("control")).toBe("1,2");
    expect(params.get("maxAcceptance")).toBe("30");
    expect(params.get("cip2")).toBe("11");
    expect(params.get("sort")).toBe("acceptanceRate");
    expect(params.get("dir")).toBe("desc");
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("25");
    // Omitted entirely when unset.
    expect(params.has("minAcceptance")).toBe(false);
    expect(params.has("maxNetPrice")).toBe(false);
    expect(params.has("minGradRate")).toBe(false);
  });

  it("falls back to default sort/dir/page when not provided", () => {
    const params = new URLSearchParams(buildSearchQuery({}));
    expect(params.get("sort")).toBe("instName");
    expect(params.get("dir")).toBe("asc");
    expect(params.get("page")).toBe("1");
    expect(params.has("states")).toBe(false);
    expect(params.has("search")).toBe(false);
  });

  it("drops an empty state array and blank search", () => {
    const params = new URLSearchParams(buildSearchQuery({ states: [], search: "   " }));
    expect(params.has("states")).toBe(false);
    expect(params.has("search")).toBe(false);
  });
});

describe("toggleSort", () => {
  it("selects a new column ascending and resets to page 1", () => {
    const next = toggleSort({ sort: "instName", dir: "asc", page: 5 }, "acceptanceRate");
    expect(next).toMatchObject({ sort: "acceptanceRate", dir: "asc", page: 1 });
  });

  it("flips direction when clicking the active column", () => {
    expect(toggleSort({ sort: "avgNetPrice", dir: "asc" }, "avgNetPrice")).toMatchObject({
      sort: "avgNetPrice",
      dir: "desc",
      page: 1,
    });
    expect(toggleSort({ sort: "avgNetPrice", dir: "desc" }, "avgNetPrice")).toMatchObject({
      sort: "avgNetPrice",
      dir: "asc",
      page: 1,
    });
  });
});

describe("InstitutionTable rendering", () => {
  it("renders the filter bar and sortable headers in the loading state (no fetch under SSR)", () => {
    const html = renderToStaticMarkup(
      <InstitutionTable
        overview={OVERVIEW}
        onSelect={() => {}}
        onAddCompare={() => {}}
        compareIds={[]}
      />,
    );
    // Filter bar is present (the search input's aria-label always renders).
    expect(html).toContain("Search institutions");
    // Table headers render.
    expect(html).toContain("Institution");
    expect(html).toContain("Acceptance %");
    expect(html).toContain("Net price");
    // Loading state (effects don't run in SSR) + CSV export anchor mirrors query.
    expect(html).toContain("Loading institutions…");
    expect(html).toContain("/api/us-universities/export?");
    expect(html).toContain("sort=instName");
    expect(html).toContain("Download CSV");
  });
});
