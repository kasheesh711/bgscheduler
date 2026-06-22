import { describe, expect, it } from "vitest";
import { legacyUnitIdRedirect } from "../us-universities-shell";
import { dossierHref } from "@/lib/us-universities/nav";

describe("legacyUnitIdRedirect", () => {
  it("redirects a legacy ?unitId deep link to the dossier route, preserving compare", () => {
    const sp = new URLSearchParams("unitId=166027&compare=1,2&tab=overview");
    const href = legacyUnitIdRedirect(sp);
    expect(href).not.toBeNull();
    expect(href!.startsWith("/us-universities/166027?")).toBe(true);
    expect(href).toContain("compare=1%2C2");
    // legacy tab/unitId params are dropped from the dossier query
    expect(href).not.toContain("unitId=");
    expect(href).not.toContain("tab=");
  });

  it("returns null when no legacy unitId is present", () => {
    expect(legacyUnitIdRedirect(new URLSearchParams("tab=browse"))).toBeNull();
    expect(legacyUnitIdRedirect(new URLSearchParams("unitId=abc"))).toBeNull();
    expect(legacyUnitIdRedirect(new URLSearchParams("unitId=0"))).toBeNull();
  });
});

describe("dossierHref filter threading", () => {
  it("threads live filter params into the dossier URL so the Back link restores context", () => {
    // Verify the round-trip contract: dossierHref(unitId, filters, compareIds)
    // embeds filter params that buildSearchQuery would produce, so the Back link
    // restores browse state when the shell reads URL params on mount.
    const href: string = dossierHref(
      166027,
      { sort: "instName", dir: "desc", page: 2, pageSize: 25, states: ["CA", "TX"] },
      [111, 222],
    );
    expect(href).toContain("/us-universities/166027?");
    // Filter params must be present in the dossier URL
    expect(href).toContain("sort=instName");
    expect(href).toContain("dir=desc");
    expect(href).toContain("page=2");
    expect(href).toContain("states=CA%2CTX");
    expect(href).toContain("compare=111%2C222");
  });
});
