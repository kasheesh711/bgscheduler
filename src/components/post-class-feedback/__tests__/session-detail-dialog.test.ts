import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FeedbackSourceAnswer } from "@/types/post-class-feedback";
import { exactWiseAnswerText } from "../session-detail-dialog";

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("post-class feedback session detail", () => {
  it("preserves exact Wise text, including leading whitespace and newlines", () => {
    const answer: FeedbackSourceAnswer = {
      id: "answer-1",
      questionId: "question-1",
      questionText: "Topics covered",
      type: "text",
      text: "normalized fallback",
      rawAnswer: "  Fractions\nand ratios  ",
    };
    expect(exactWiseAnswerText(answer)).toBe("  Fractions\nand ratios  ");
  });

  it("renders lossless non-text Wise answers instead of inventing text", () => {
    const answer: FeedbackSourceAnswer = {
      id: null,
      questionId: "rating",
      questionText: "Rating",
      type: "rating",
      text: "",
      rawAnswer: { value: 4, scale: 5 },
    };
    expect(exactWiseAnswerText(answer)).toBe('{\n  "value": 4,\n  "scale": 5\n}');
  });

  it("loads authenticated detail on demand and keeps raw history out of the dashboard serializer", () => {
    const operations = source("src/components/post-class-feedback/operations-tab.tsx");
    const dialog = source("src/components/post-class-feedback/session-detail-dialog.tsx");
    const dashboard = source("src/lib/post-class-feedback/dashboard.ts");

    expect(operations).toContain("Select a row to load exact Wise evidence");
    expect(dialog).toContain("/api/post-class-feedback/sessions/${encodeURIComponent(session.id)}");
    expect(dialog).toContain('cache: "no-store"');
    expect(dialog).toContain("Exact Wise answers");
    expect(dialog).toContain("Assessment history");
    expect(dialog).toContain("Wise event associations");
    expect(dialog).toContain("Source issue history");
    expect(dashboard).not.toContain("versionsBySession");
    expect(dashboard).not.toContain("text: topics");
    expect(dialog).not.toMatch(/console\.(log|info|warn|error)/);
  });
});
