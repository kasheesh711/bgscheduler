import { describe, expect, it } from "vitest";
import type { FilterParams } from "@/lib/us-universities/types";
import { consoleHref, dossierHref } from "../nav";

const base: FilterParams = { sort: "instName", dir: "asc", page: 1, pageSize: 50 };

describe("dossierHref", () => {
  it("targets the dossier route and embeds the search query", () => {
    const href = dossierHref(166027, base, []);
    expect(href.startsWith("/us-universities/166027?")).toBe(true);
    expect(href).toContain("sort=instName");
    expect(href).toContain("dir=asc");
    expect(href).toContain("page=1");
  });

  it("appends compare ids as a comma-joined param when present", () => {
    const href = dossierHref(166027, base, [100, 200]);
    expect(href).toContain("compare=100%2C200");
  });

  it("omits the compare param when the shortlist is empty", () => {
    expect(dossierHref(166027, base, [])).not.toContain("compare=");
  });

  it("carries non-default filters into the query", () => {
    const href = dossierHref(1, { ...base, states: ["CA", "NY"], maxNetPrice: 30000 }, []);
    expect(href).toContain("states=CA%2CNY");
    expect(href).toContain("maxNetPrice=30000");
  });
});

describe("consoleHref", () => {
  it("targets the console root with the search query", () => {
    const href = consoleHref(base, []);
    expect(href.startsWith("/us-universities?")).toBe(true);
    expect(href).toContain("sort=instName");
  });

  it("appends compare ids when present and omits when empty", () => {
    expect(consoleHref(base, [5, 6])).toContain("compare=5%2C6");
    expect(consoleHref(base, [])).not.toContain("compare=");
  });
});
