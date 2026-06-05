import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomeHub } from "@/components/home/home-hub";
import type { HomeSummaryPayload } from "@/lib/home/summary";

function payload(overrides: Partial<HomeSummaryPayload> = {}): HomeSummaryPayload {
  return {
    generatedAt: "2026-06-05T09:00:00.000Z",
    actions: [
      {
        id: "leaveRequests",
        toolId: "leave-requests",
        label: "Leave Requests",
        href: "/leave-requests",
        value: 7,
        detail: "6 new, 1 needs review",
        status: "ok",
        error: null,
      },
      {
        id: "dataHealth",
        toolId: "data-health",
        label: "Data Health",
        href: "/data-health",
        value: 0,
        detail: "Cron and freshness status",
        status: "ok",
        error: null,
      },
    ],
    freshness: {
      status: "ok",
      checkedAt: "2026-06-05T09:00:00.000Z",
      overallStatus: "healthy",
      overallHeadline: "Healthy",
      staleAgeMs: 600_000,
      staleMinutes: 10,
      wiseSnapshotLastSuccess: "2026-06-05T08:50:00.000Z",
      cronCounts: { healthy: 7, late: 0, failing: 0, running: 0, manualOnly: 1, unknown: 0 },
      googleSheets: { connected: true, writeConnected: true, email: "admin@example.com", lastError: null },
      error: null,
    },
    ...overrides,
  };
}

describe("HomeHub", () => {
  it("renders action queues, freshness, and curated shortcuts", () => {
    const html = renderToStaticMarkup(<HomeHub summary={payload()} allowedPages={null} />);

    expect(html).toContain("Action Queues");
    expect(html).toContain("Leave Requests");
    expect(html).toContain("6 new, 1 needs review");
    expect(html).toContain("Data Freshness");
    expect(html).toContain("Cron health");
    expect(html).toContain("Curated Shortcuts");
    expect(html).toContain("Search");
    expect(html).toContain("Class Assignments");
  });

  it("renders the zero-action state", () => {
    const html = renderToStaticMarkup(<HomeHub summary={payload({ actions: [] })} allowedPages={null} />);

    expect(html).toContain("No urgent admin queues right now.");
    expect(html).toContain("No accessible action queues for this account.");
  });

  it("filters shortcuts by allowed pages", () => {
    const html = renderToStaticMarkup(
      <HomeHub summary={payload({ actions: [] })} allowedPages={["/progress-tests", "/data-health"]} />,
    );

    expect(html).toContain("Data Health");
    expect(html).not.toContain("Search");
    expect(html).not.toContain("Class Assignments");
  });
});
