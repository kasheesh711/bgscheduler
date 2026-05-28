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
    expect(source).toContain("Wise Revenue");
    expect(source).toContain("Sheet - Wise");
    expect(source).toContain("Wise fees paid trend");
    expect(source).not.toContain("Partial persisted total");
    expect(source).toContain("Rows With Candidates");
    expect(source).toContain("Student Package Sales");
  });

  it("keeps reconciliation candidate review read-only", () => {
    const source = readWiseActivityWorkspace();

    expect(source).toContain("No Wise invoice/payment candidates.");
    expect(source).toContain("Wise raw details");
    expect(source).not.toContain("Mark as matched");
    expect(source).not.toContain("Save match");
  });
});
