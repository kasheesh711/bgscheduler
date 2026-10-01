import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExcludedList, FreshnessBanner, HowScoreWorks, StaffAccounts } from "../rail";
import { curveSentence } from "../format";
import { dashboardFixture, staleDashboardFixture } from "./fixtures";

const noop = () => undefined;

describe("rail", () => {
  it("explains the score with the curve and its table", () => {
    const { curve } = dashboardFixture();
    const html = renderToStaticMarkup(<HowScoreWorks curve={curve} />);
    expect(html).toContain(curveSentence(curve));
    expect(html).toContain("90+ days");
    expect(html).toContain("Unknown data never counts.");
  });

  it("lists staff accounts read-only with their last admin action", () => {
    const html = renderToStaticMarkup(<StaffAccounts rows={dashboardFixture().staff} onOpen={noop} />);
    expect(html).toContain("Remove departed staff by hand in Wise.");
    expect(html).toContain("Gus");
    expect(html).toContain("Last admin action 30 Sep");
    expect(html).toContain("Hana");
    expect(html).toContain("No admin activity on record");
    expect(html).not.toContain("Still with us");
  });

  it("counts teaching people and lists the other exclusions with Undo for snoozes", () => {
    const html = renderToStaticMarkup(<ExcludedList rows={dashboardFixture().excluded} onOpen={noop} onUndo={noop} />);
    expect(html).toContain("1 teaching (have upcoming classes).");
    expect(html).toContain("Juno");
    expect(html).toContain("New account, not started yet");
    expect(html).toContain("Back after his exams in January");
    expect(html).toContain("Undo");
  });

  it("names each stale feed in the banner", () => {
    const html = renderToStaticMarkup(<FreshnessBanner report={staleDashboardFixture().freshness} />);
    expect(html).toContain("Scores are provisional: some data is out of date.");
    expect(html).toContain("Wise roster and upcoming classes (last updated 1 Oct 2026)");
    expect(html).toContain("Leave requests (never updated)");
  });
});
