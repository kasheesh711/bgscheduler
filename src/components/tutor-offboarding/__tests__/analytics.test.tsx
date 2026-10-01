import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsContent,
  AnalyticsTab,
  fetchAnalytics,
  coverageCsv,
  safeCsvCell,
} from "../analytics-tab";
import { analyticsFixture } from "../analytics-fixtures";

describe("offboarding analytics", () => {
  it("keeps turnover a visible-math proxy and pending departures distinct", () => {
    const html = renderToStaticMarkup(
      <AnalyticsContent report={analyticsFixture()} />,
    );
    expect(html).toContain("Teaching cohort marked for departure");
    expect(html).toContain("1 ÷ 4 × 100 = 25.0%");
    expect(html).toContain("Monthly turnover is shown in Workforce Overview");
    expect(html).not.toContain("HR turnover rate is unavailable");
    expect(html).toContain("Aria");
    expect(html).toContain("117");
    expect(html).toContain("Pending departures with classes");
    expect(html).toContain("Partial month");
    expect(html).not.toContain("Confirmed terminated");
  });
  it("distinguishes academic combinations, teaching evidence and Wise categories", () => {
    const html = renderToStaticMarkup(
      <AnalyticsContent report={analyticsFixture()} />,
    );
    expect(html).toContain("Subject and level combinations");
    expect(html).toContain("Qualified after scenario");
    expect(html).toContain("Any-subject teaching · last 30 days");
    expect(html).toContain("Wise course category");
    expect(html).toContain("Y2-8/G1-7");
    expect(html).toContain("Classes through");
    expect(html).toContain("All stored future");
  });
  it("calculates zero coverage under the expanded scenario without claiming availability", () => {
    const html = renderToStaticMarkup(
      <AnalyticsContent
        report={analyticsFixture()}
        initialScenario="marked_and_inferred"
      />,
    );
    expect(html).toContain("2 ÷ 4 × 100 = 50.0%");
    expect(html).toContain("No recorded qualification matches remain");
    expect(html).toContain("Bodhi");
    expect(html).toContain("Qualifications do not establish availability");
  });
  it("shows failed/unavailable reads rather than empty clean analytics", async () => {
    const failed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Analytics could not load" }), {
          status: 503,
        }),
      );
    await expect(fetchAnalytics(failed)).rejects.toThrow(
      "Analytics could not load",
    );
    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ available: false, reason: "no_snapshot" }),
        ),
      );
    await expect(fetchAnalytics(unavailable)).resolves.toEqual({
      available: false,
      reason: "no_snapshot",
    });
    const html = renderToStaticMarkup(
      <AnalyticsTab initial={{ available: false, reason: "no_snapshot" }} />,
    );
    expect(html).toContain("No current Wise snapshot");
    expect(html).toContain("Refresh analytics");
    expect(html).not.toContain("0 tutors");
  });
  it("rejects malformed successful responses and performs only GET", async () => {
    const bad = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ available: true })));
    await expect(fetchAnalytics(bad)).rejects.toThrow(
      "Analytics response was incomplete",
    );
    expect(bad).toHaveBeenCalledWith(
      "/api/tutor-offboarding/analytics",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });
  it("exports raw counts and names while escaping spreadsheet formulas", () => {
    expect(safeCsvCell("=SUM(A1)")).toBe('"\'=SUM(A1)"');
    expect(safeCsvCell('Name, "Tutor"')).toBe('"Name, ""Tutor"""');
    const csv = coverageCsv(analyticsFixture(), "marked_and_inferred");
    expect(csv).toContain("Computer Science");
    expect(csv).toContain("Bodhi");
    expect(csv).toContain("Qualified after scenario");
  });
});
