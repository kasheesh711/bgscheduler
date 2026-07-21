import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), "src/components/post-class-feedback", file), "utf8");
}

describe("post-class feedback workspace contract", () => {
  it("offers every required workspace view and sequence-guarded refresh", () => {
    const workspace = source("post-class-feedback-workspace.tsx");
    expect(workspace).toContain("Operations");
    expect(workspace).toContain("Analytics");
    expect(workspace).toContain("Deductions");
    expect(workspace).toContain("Audit");
    expect(workspace).toContain("Settings");
    expect(workspace).toContain("AbortController");
    expect(workspace).toContain("requestSequence");
    expect(workspace).toContain("payload?.capabilities.reviewer || payload?.capabilities.finance");
    expect(workspace).toContain("payload?.capabilities.accessManager");
  });

  it("keeps financial and reviewer mutations on separate endpoints", () => {
    const operations = source("operations-tab.tsx");
    const sessionDetail = source("session-detail-dialog.tsx");
    const deductions = source("deductions-tab.tsx");
    expect(sessionDetail).toContain("/api/post-class-feedback/review");
    expect(sessionDetail).toContain("concernId: reviewDialog.concernId");
    expect(sessionDetail).toContain("expectedVersion: reviewDialog.expectedVersion");
    expect(operations).toContain("<SessionDetailDialog");
    expect(deductions).toContain("/api/post-class-feedback/finance");
    expect(deductions).toContain("Individual decisions only");
  });

  it("contains setup controls but no synthetic comment generator", () => {
    const settings = source("settings-tab.tsx");
    const operations = `${source("operations-tab.tsx")}\n${source("session-detail-dialog.tsx")}`;
    expect(settings).toContain("Access roles");
    expect(settings).toContain("Tutor reminder emails");
    expect(settings).toContain("Wise form mapping");
    expect(settings).toContain("Finance periods");
    expect(settings).toContain("Confirm shadow review");
    expect(settings).toContain("Backfill range");
    expect(settings).toContain("/api/post-class-feedback/shadow-review");
    expect(settings).toContain('action: "open"');
    expect(settings).toContain("Open period");
    expect(`${settings}\n${operations}`).not.toMatch(/generate (feedback|comment)/i);
  });
});
