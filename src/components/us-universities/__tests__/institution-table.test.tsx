import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstitutionTable, acceptanceDelta, buildSearchQuery, toggleSort } from "../institution-table";
import type { FilterParams, StateFacet, Cip2Option } from "@/lib/us-universities/types";

const STATES: StateFacet[] = [
  { state: "CA", count: 50 },
  { state: "TX", count: 40 },
];

const CIP2_OPTIONS: Cip2Option[] = [{ cip2: "11", label: "Computer & Information Sciences" }];

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

describe("acceptanceDelta", () => {
  it("returns 'down' (more selective) when current acceptance is below prior year", () => {
    expect(acceptanceDelta({ acceptanceRate: 40, acceptancePrevYear: 50 })).toEqual({
      points: -10,
      direction: "down",
    });
  });

  it("returns 'up' when current acceptance is above prior year", () => {
    expect(acceptanceDelta({ acceptanceRate: 55, acceptancePrevYear: 50 })).toEqual({
      points: 5,
      direction: "up",
    });
  });

  it("returns null when either value is missing (fail-closed)", () => {
    expect(acceptanceDelta({ acceptanceRate: null, acceptancePrevYear: 50 })).toBeNull();
    expect(acceptanceDelta({ acceptanceRate: 40, acceptancePrevYear: null })).toBeNull();
    expect(acceptanceDelta({ acceptanceRate: null, acceptancePrevYear: null })).toBeNull();
  });

  it("returns 'flat' for an unchanged (or sub-0.1pp) year-over-year delta", () => {
    expect(acceptanceDelta({ acceptanceRate: 50, acceptancePrevYear: 50 })).toEqual({
      points: 0,
      direction: "flat",
    });
    expect(acceptanceDelta({ acceptanceRate: 50.03, acceptancePrevYear: 50 })?.direction).toBe("flat");
  });
});

describe("InstitutionTable rendering", () => {
  it("renders the filter bar, headers, and loading state from props (fetch-free presenter)", () => {
    const html = renderToStaticMarkup(
      <InstitutionTable
        rows={[]}
        total={0}
        loading
        error={null}
        filters={{ sort: "instName", dir: "asc", page: 1, pageSize: 50 }}
        states={STATES}
        cip2Options={CIP2_OPTIONS}
        onSort={() => {}}
        onSelect={() => {}}
        onAddCompare={() => {}}
        onFilterChange={() => {}}
        onPage={() => {}}
        compareIds={[]}
      />,
    );
    expect(html).toContain("Search institutions");
    expect(html).toContain("Institution");
    expect(html).toContain("Acceptance %");
    expect(html).toContain("Acceptance trend");
    expect(html).toContain("Net price");
    expect(html).toContain("Loading institutions…");
    expect(html).toContain("/api/us-universities/export?");
    expect(html).toContain("sort=instName");
    expect(html).toContain("Download CSV");
  });
});
