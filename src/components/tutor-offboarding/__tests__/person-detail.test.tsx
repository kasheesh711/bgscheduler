import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonDetail, removalCheck } from "../person-detail";
import { dashboardFixture } from "./fixtures";

function row(key: string) {
  const data = dashboardFixture();
  const found = [...data.inbox, ...data.excluded, ...data.staff].find((candidate) => candidate.signals.canonicalKey === key);
  if (!found) throw new Error(`fixture has no ${key}`);
  return found;
}

describe("PersonDetail", () => {
  it("shows every reason, the sources, and each account's Wise details", () => {
    const html = renderToStaticMarkup(<PersonDetail row={row("Aria")} />);
    expect(html).toContain("No class on record since 1 Mar");
    expect(html).toContain("No working hours set in Wise");
    expect(html).toContain("Never activated their Wise login");
    expect(html).toContain("none since 1 Mar");
    expect(html).toContain("Joined 20 Jan 2026");
    expect(html).toContain("Never logged in");
    expect(html).toContain("0 courses");
    expect(html).toContain("aria@example.com");
  });

  it("states the removal check in words", () => {
    expect(removalCheck(row("Aria"))).toBe("Passes every removal check");
    expect(removalCheck(row("Dara"))).toBe("Not removable yet: Last class 35 days ago; removal opens at 45 days");
    expect(removalCheck(row("Fern"))).toBe("Not removable: Teaching: 6 upcoming classes");
  });
});
