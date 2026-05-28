import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readWiseActivityWorkspace() {
  return fs.readFileSync(
    path.join(process.cwd(), "src/components/wise-activity/wise-activity-workspace.tsx"),
    "utf8",
  );
}

describe("Wise Audit reconciliation UI", () => {
  it("includes the package-sales reconciliation surface and coverage warning", () => {
    const source = readWiseActivityWorkspace();

    expect(source).toContain("Reconciliation");
    expect(source).toContain("Sales Dashboard source");
    expect(source).toContain("Backfill selected range");
    expect(source).toContain("Coverage:");
    expect(source).toContain("Revenue Variance");
    expect(source).toContain("Wise Fees Paid Trend");
    expect(source).toContain("Wise Receipt Total");
    expect(source).toContain("Sheet - Receipts");
    expect(source).toContain("Receipts - Trend");
    expect(source).toContain("Wise fees paid trend");
    expect(source).toContain("Wise receipt transactions");
    expect(source).not.toContain("Partial persisted total");
    expect(source).toContain("Rows With Receipt Candidates");
    expect(source).toContain("Student Package Sales");
  });

  it("keeps reconciliation candidate review read-only", () => {
    const source = readWiseActivityWorkspace();

    expect(source).toContain("No Wise receipt candidates.");
    expect(source).toContain("Wise receipt raw details");
    expect(source).not.toContain("Mark as matched");
    expect(source).not.toContain("Save match");
  });
});
