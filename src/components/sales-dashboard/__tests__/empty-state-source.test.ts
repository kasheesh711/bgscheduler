import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSalesDashboardShell() {
  return fs.readFileSync(
    path.join(process.cwd(), "src/components/sales-dashboard/sales-dashboard-shell.tsx"),
    "utf8",
  );
}

describe("sales dashboard empty setup UI", () => {
  it("surfaces zero-source setup guidance above the chart grid", () => {
    const source = readSalesDashboardShell();
    const setupIndex = source.indexOf("<SalesDashboardSetupState");
    const chartsIndex = source.indexOf("<ChartCard");

    expect(source).toContain("No monthly sources configured");
    expect(source).toContain("Google Sheets is connected, but the dashboard has no monthly sheet sources yet.");
    expect(source).toContain("Seed historical sources");
    expect(source).toContain("Backfill all");
    expect(setupIndex).toBeGreaterThan(-1);
    expect(chartsIndex).toBeGreaterThan(-1);
    expect(setupIndex).toBeLessThan(chartsIndex);
  });

  it("does not let the live-month refresh claim success before sources exist", () => {
    const source = readSalesDashboardShell();

    expect(source).toContain("No sources configured. Seed historical sources first.");
    expect(source).toContain("disabled={!hasSources || busyAction === \"refresh\"}");
    expect(source).not.toContain("setMessage(\"Refresh completed.\");");
  });

  it("uses cohort KPI copy and source archival/error wording", () => {
    const source = readSalesDashboardShell();

    expect(source).toContain("Trial Cohort Conversion");
    expect(source).toContain("Retention Rate");
    expect(source).toContain("Last import failed");
    expect(source).toContain("Archive source");
    expect(source).toContain("Archived sources");
    expect(source).not.toContain("title=\"Delete\"");
  });
});
