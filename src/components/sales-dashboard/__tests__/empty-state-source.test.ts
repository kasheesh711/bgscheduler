import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSalesDashboardShell() {
  return fs.readFileSync(
    path.join(process.cwd(), "src/components/sales-dashboard/sales-dashboard-shell.tsx"),
    "utf8",
  );
}

function readSourceManager() {
  return fs.readFileSync(
    path.join(process.cwd(), "src/components/sales-dashboard/source-manager.tsx"),
    "utf8",
  );
}

describe("sales dashboard empty setup UI", () => {
  it("surfaces zero-source setup guidance above the command center", () => {
    const source = readSalesDashboardShell();
    const setupIndex = source.indexOf("<SalesDashboardSetupState");
    const commandCenterIndex = source.indexOf("<SalesDashboardCommandCenter");

    expect(source).toContain("No monthly sources configured");
    expect(source).toContain("Google Sheets is connected, but the dashboard has no monthly sheet sources yet.");
    expect(source).toContain("Seed historical sources");
    expect(source).toContain("Backfill all");
    expect(setupIndex).toBeGreaterThan(-1);
    expect(commandCenterIndex).toBeGreaterThan(-1);
    expect(setupIndex).toBeLessThan(commandCenterIndex);
  });

  it("does not let the live-month refresh claim success before sources exist", () => {
    const source = readSalesDashboardShell();

    expect(source).toContain("No sources configured. Seed historical sources first.");
    expect(source).toContain("disabled={!hasSources || busyAction === \"refresh\"}");
    expect(source).not.toContain("setMessage(\"Refresh completed.\");");
  });

  it("tucks source management behind the data sources dialog", () => {
    const shell = readSalesDashboardShell();
    const sourceManager = readSourceManager();

    expect(shell).toContain("Data Sources & Imports");
    expect(shell).toContain("<Dialog");
    expect(shell).toContain("<SourceManager");
    expect(sourceManager).toContain("Last import failed");
    expect(sourceManager).toContain("Archive source");
    expect(sourceManager).toContain("Archived sources");
    expect(sourceManager).not.toContain("title=\"Delete\"");
  });

  it("includes projection workbook controls in the data sources dialog", () => {
    const shell = readSalesDashboardShell();
    const sourceManager = readSourceManager();

    expect(shell).toContain("projectionForm");
    expect(shell).toContain("/api/sales-dashboard/projection-source");
    expect(shell).toContain("/api/sales-dashboard/projection-import");
    expect(sourceManager).toContain("Projection Workbook");
    expect(sourceManager).toContain("Actual-vs-projection uses normal sales only");
    expect(sourceManager).toContain("Save projection");
    expect(sourceManager).toContain("Import projection");
  });
});
