import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SalesActionsPayload } from "@/lib/sales-dashboard/actions";

vi.mock("@/components/sales-dashboard/chart-canvas", () => ({
  chartColors: () => ({
    chart: ["#c1", "#c2", "#c3", "#c4", "#c5"],
    border: "#border",
    mutedForeground: "#muted",
  }),
  ChartCanvas: ({ config, active }: { config: { type?: string }; active?: boolean }) => (
    <div data-testid="chart-canvas" data-chart-type={config.type} data-active={String(active)} />
  ),
}));

import { ActionsCockpit, buildSalesActionExportRows } from "../actions-tab";

function payload(overrides: Partial<SalesActionsPayload> = {}): SalesActionsPayload {
  return {
    generatedAt: "2026-06-15T00:00:00.000Z",
    mode: "current",
    modeLabel: "Current-month action mode",
    period: {
      from: "2026-06-01",
      to: "2026-06-30",
      currentMonthStart: "2026-06-01",
      currentMonthEnd: "2026-06-30",
      isCurrentMonth: true,
    },
    kpis: {
      projectedNormalSales: 3_200_000,
      targetGap: 800_000,
      matchedAtRiskValue: 600_000,
      actionsReady: 2,
      target: 4_000_000,
      normalSales: 1_600_000,
      dailyPaceNeeded: 50_000,
    },
    chart: {
      points: [
        { month: "2026-06-01", label: "Jun '26", actualNormalRevenue: 1_600_000, baseProjectedRevenue: 4_000_000, target: 4_000_000 },
      ],
      annotations: [
        { id: "renewal-bell", family: "renewal_rescue", severity: "critical", label: "Renewal rescue: Bell", value: 600_000 },
      ],
    },
    items: [{
      id: "renewal-bell",
      family: "renewal_rescue",
      severity: "critical",
      title: "Renewal rescue: Bell",
      detail: "Bell has one Credit Control risk signal and high Sales value.",
      value: { amount: 600_000, label: "฿600k", unit: "thb" },
      rankScore: 900,
      primaryAction: {
        kind: "credit-control",
        label: "Open Credit Control",
        href: "/credit-control?studentKey=bell-parent-a",
        enabled: true,
      },
      match: {
        status: "unique",
        salesStudentKey: "bell",
        salesStudentName: "Bell",
        creditStudentKey: "bell-parent-a",
        creditStudentName: "Bell",
        candidateCount: 1,
        canOpenCreditControl: true,
      },
      evidence: [
        { label: "Sales status", value: "Active" },
        { label: "Credit risk", value: "1 risky package", tone: "critical" },
      ],
      sourceRange: { from: "2026-06-01", to: "2026-06-30", mode: "current" },
    }],
    dependencyWarnings: [],
    matchStats: {
      unique: 1,
      ambiguous: 0,
      unmatched: 0,
      creditControlAvailable: true,
      creditControlAccessible: true,
    },
    ...overrides,
  };
}

describe("ActionsCockpit rendering", () => {
  it("renders KPI cards, the pace chart, feed evidence, and Credit Control links", () => {
    const html = renderToStaticMarkup(<ActionsCockpit payload={payload()} active />);

    expect(html).toContain("Projected normal sales");
    expect(html).toContain("Target gap");
    expect(html).toContain("Matched at-risk value");
    expect(html).toContain("Actions ready");
    expect(html).toContain("data-testid=\"chart-canvas\"");
    expect(html).toContain("Renewal rescue: Bell");
    expect(html).toContain("Credit risk");
    expect(html).toContain("/credit-control?studentKey=bell-parent-a");
  });

  it("labels historical mode clearly", () => {
    const html = renderToStaticMarkup(
      <ActionsCockpit
        payload={payload({
          mode: "historical",
          modeLabel: "Historical analysis mode",
          period: {
            from: "2026-05-01",
            to: "2026-05-31",
            currentMonthStart: "2026-06-01",
            currentMonthEnd: "2026-06-30",
            isCurrentMonth: false,
          },
        })}
      />,
    );

    expect(html).toContain("Historical analysis mode");
    expect(html).toContain("Credit handoffs show current-state context.");
  });

  it("renders dependency warnings and the source-manager primary action", () => {
    const sourceItem = payload().items[0];
    const html = renderToStaticMarkup(
      <ActionsCockpit
        payload={payload({
          dependencyWarnings: [{
            id: "credit-control-unavailable",
            severity: "warning",
            title: "Credit Control unavailable",
            detail: "Sales-only actions are still shown.",
          }],
          items: [{
            ...sourceItem,
            id: "data-source-failure",
            family: "data_trust",
            title: "Source import failed",
            primaryAction: {
              kind: "source-manager",
              label: "Open data sources",
              href: null,
              enabled: true,
            },
          }],
        })}
        onOpenSources={() => undefined}
      />,
    );

    expect(html).toContain("Credit Control unavailable");
    expect(html).toContain("Source import failed");
    expect(html).toContain("Open data sources");
  });

  it("shows an empty state when no actions are ranked", () => {
    const html = renderToStaticMarkup(<ActionsCockpit payload={payload({ items: [], chart: { points: [], annotations: [] } })} />);

    expect(html).toContain("No action signals for this period.");
    expect(html).toContain("No projection series available");
  });
});

describe("buildSalesActionExportRows", () => {
  it("serializes the ranked action feed with values, match context, and evidence", () => {
    const rows = buildSalesActionExportRows(payload());

    expect(rows).toEqual([
      expect.objectContaining({
        id: "renewal-bell",
        family: "renewal_rescue",
        severity: "critical",
        valueAmount: 600_000,
        primaryActionHref: "/credit-control?studentKey=bell-parent-a",
        matchStatus: "unique",
        salesStudent: "Bell",
        creditStudent: "Bell",
        evidence: ["Sales status: Active", "Credit risk: 1 risky package"],
      }),
    ]);
  });
});
