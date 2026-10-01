import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { topLineSentence } from "../format";
import { TutorOffboardingWorkspace } from "../tutor-offboarding-workspace";
import { ADMIN, dashboardFixture, emptyDashboardFixture, notSetUpFixture, staleDashboardFixture } from "./fixtures";

function render(initial: Parameters<typeof TutorOffboardingWorkspace>[0]["initial"]) {
  return renderToStaticMarkup(<TutorOffboardingWorkspace initial={initial} />);
}

describe("TutorOffboardingWorkspace", () => {
  it("opens on the top line, the bands in order, and each person's reasons", () => {
    const data = dashboardFixture();
    const html = render({ available: true, ...data });
    expect(html).toContain(`${topLineSentence(data.summary)} · data 12 min old`);
    expect(html.indexOf(">Very likely gone<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Very likely gone<")).toBeLessThan(html.indexOf(">Likely gone<"));
    for (const row of data.inbox) expect(html).toContain(row.signals.displayName);
    expect(html).toContain("No working hours set in Wise");
    expect(html).toContain("Still with us");
    expect(html).toContain("Who can remove");
    expect(html).not.toContain("Scores are provisional");
  });

  it("shows other admins everything except the owner's grant panel", () => {
    const html = render({ available: true, ...dashboardFixture(ADMIN) });
    expect(html).toContain("Staff accounts");
    expect(html).not.toContain("Who can remove");
  });

  it("warns when scores are provisional and says when nobody needs review", () => {
    expect(render({ available: true, ...staleDashboardFixture() })).toContain("Scores are provisional");
    expect(render({ available: true, ...emptyDashboardFixture() })).toContain("Nobody to review.");
  });

  it("explains a page that is not set up yet", () => {
    expect(render(notSetUpFixture())).toContain("Tutor Offboarding is not set up yet: its database migration has not been applied.");
  });
});
