import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { selectedRemovalRows, SelectionBar } from "../selection-bar";
import { PersonRow } from "../person-row";
import { dashboardFixture, confirmedDashboardFixture } from "./fixtures";

const noop = () => undefined;

describe("removal selection", () => {
  it("counts whole people and every account, retaining only freshly eligible rows", () => {
    const data = confirmedDashboardFixture();
    const rows = selectedRemovalRows(data.inbox, new Set(["Aria", "Bodhi", "Dara", "Kai", "Fern"]), true);
    expect(rows.map((row) => row.signals.canonicalKey)).toEqual(["Aria", "Bodhi"]);
    expect(rows.flatMap((row) => row.signals.accounts)).toHaveLength(3);
    expect(selectedRemovalRows(data.inbox, new Set(["Aria"]), false)).toEqual([]);
  });

  it("offers selection only on eligible people, and explains a blocked person", () => {
    const data = dashboardFixture();
    const aria = data.inbox.find((row) => row.signals.canonicalKey === "Aria")!;
    const dara = data.inbox.find((row) => row.signals.canonicalKey === "Dara")!;
    const eligible = renderToStaticMarkup(<PersonRow row={aria} onOpen={noop} onKeep={noop} selected={false} onSelect={noop} canRemove />);
    const blocked = renderToStaticMarkup(<PersonRow row={dara} onOpen={noop} onKeep={noop} selected={false} onSelect={noop} canRemove />);
    expect(eligible).toContain('type="checkbox"');
    expect(eligible).toContain('aria-label="Select Aria for removal"');
    expect(blocked).not.toContain('type="checkbox"');
    expect(blocked).toContain("Last class 35 days ago; removal opens at 45 days");
  });

  it("requires a capability before preview and clearly says preview does not remove", () => {
    const rows = dashboardFixture().inbox.filter((row) => ["Aria", "Bodhi"].includes(row.signals.canonicalKey));
    const html = renderToStaticMarkup(<SelectionBar rows={rows} canRemove={false} busy={false} onPreview={noop} onClear={noop} />);
    expect(html).toContain("2 tutors (3 Wise accounts)");
    expect(html).toContain("Preview removal");
    expect(html).toContain("The owner must allow you to remove tutors");
    expect(html).toContain("Preview only checks the plan");
    expect(html).toContain("disabled");
  });
});
