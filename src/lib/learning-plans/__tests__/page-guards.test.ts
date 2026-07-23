import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("learning plans page guards", () => {
  it("guards the builder before rendering feature content", () => {
    const source = readSource("src/app/(app)/learning-plans/page.tsx");
    const guard = source.indexOf("await requireLearningPlansAccess()");
    const content = source.indexOf("<LearningPlanForm");

    expect(guard).toBeGreaterThan(-1);
    expect(content).toBeGreaterThan(guard);
  });

  it("guards report metadata and body before reading report parameters", () => {
    const source = readSource(
      "src/app/(print)/learning-plans/report/page.tsx",
    );
    const metadataStart = source.indexOf("export async function generateMetadata");
    const bodyStart = source.indexOf("async function LearningPlanReportBody");
    const metadata = source.slice(metadataStart, bodyStart);
    const body = source.slice(bodyStart);

    const metadataGuard = metadata.indexOf(
      "await requireLearningPlansAccess()",
    );
    expect(metadataGuard).toBeGreaterThan(-1);
    expect(metadataGuard).toBeLessThan(metadata.indexOf("await searchParams"));
    expect(body.indexOf("await requireLearningPlansAccess()")).toBeGreaterThan(-1);
    expect(body.indexOf("await requireLearningPlansAccess()")).toBeLessThan(
      body.indexOf("await searchParams"),
    );
  });
});
