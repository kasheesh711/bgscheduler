import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { topLineSentence } from "../format";
import { TutorOffboardingWorkspace } from "../tutor-offboarding-workspace";
import { ADMIN, confirmedDashboardFixture, dashboardFixture, emptyDashboardFixture, notSetUpFixture, staleDashboardFixture } from "./fixtures";

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

describe("confirmation-only review", () => {
  it("does not claim nothing needs review when a confirmed person has an Active score", () => {
    const data = confirmedDashboardFixture();
    data.inbox = data.inbox.filter((row) => row.score.band === "active");
    data.summary = { veryLikely: 0, veryLikelyAccounts: 0, likely: 0, unclear: 0 };
    const html = render({ available: true, ...data });
    expect(html).not.toContain("Nothing to review.");
    expect(html).toContain("1 tutor marked for termination needs review.");
  });
});

describe("confirmation-only exclusions", () => {
  it("keeps confirmed staff and teaching evidence in the header when the inbox is empty", () => {
    const data = confirmedDashboardFixture();
    data.inbox = [];
    data.summary = { veryLikely: 0, veryLikelyAccounts: 0, likely: 0, unclear: 0 };
    const html = render({ available: true, ...data });
    expect(html).not.toContain("No tutors look like they have left.");
    expect(html).toContain("2 tutors marked for termination are on the roster; review their exclusions or staff accounts.");
  });
});
