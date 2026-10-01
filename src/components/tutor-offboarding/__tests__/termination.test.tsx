import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Inbox } from "../inbox";
import { PersonDetail } from "../person-detail";
import { ExcludedList, StaffAccounts } from "../rail";
import { TutorOffboardingWorkspace } from "../tutor-offboarding-workspace";
import { confirmedDashboardFixture } from "./fixtures";

const noop = () => undefined;

describe("confirmed termination evidence", () => {
  it("shows the source evidence and removal checks separately in the drawer", () => {
    const row = confirmedDashboardFixture().inbox.find((row) => row.signals.canonicalKey === "Aria")!;
    const html = renderToStaticMarkup(<PersonDetail row={row} />);
    expect(html).toContain("Confirmed terminated");
    expect(html).toContain("Struck through in the Tutors sheet");
    expect(html).toContain("Source row 12");
    expect(html).toContain("Checked 1 Oct 2026");
    expect(html).toContain("https://example.com/tutors");
    expect(html).toContain("Passes every removal check");
  });

  it("keeps a confirmed person visible even when their likelihood is Active", () => {
    const data = confirmedDashboardFixture();
    const html = renderToStaticMarkup(<Inbox rows={data.inbox} onOpen={noop} onKeep={noop} />);
    expect(html).toContain("Kai");
    expect(html).toContain("Confirmed terminated");
    expect(html).toContain('data-band="active"');
  });

  it("shows confirmed staff and teaching exclusions, including their safety reason", () => {
    const data = confirmedDashboardFixture();
    const staff = renderToStaticMarkup(<StaffAccounts rows={data.staff} onOpen={noop} />);
    const excluded = renderToStaticMarkup(<ExcludedList rows={data.excluded} onOpen={noop} onUndo={noop} />);
    expect(staff).toContain("Confirmed terminated");
    expect(excluded).toContain("Fern");
    expect(excluded).toContain("Confirmed terminated");
    expect(excluded).toContain("Teaching: 6 upcoming classes");
  });

  it("summarizes matches and displays unmatched rows with their reasons", () => {
    const data = confirmedDashboardFixture();
    const html = renderToStaticMarkup(<TutorOffboardingWorkspace initial={{ available: true, ...data }} />);
    expect(html).toContain("4 people matched from 5 confirmed sheet rows");
    expect(html).toContain("Nori Fictional");
    expect(html).toContain("No matching Wise account");
    expect(html).toContain("Source rows needing review");
  });

  it.each(["stale", "not_synced", "error"] as const)("displays %s source status without presenting absence as a clean result", (status) => {
    const data = confirmedDashboardFixture();
    data.terminationSource!.status = status;
    const html = renderToStaticMarkup(<TutorOffboardingWorkspace initial={{ available: true, ...data }} />);
    const expected = { stale: "Confirmation data is out of date", not_synced: "The Tutors sheet has not been checked yet", error: "The Tutors sheet could not be read" };
    expect(html).toContain(expected[status]);
  });
});
