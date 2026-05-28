import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSchedulerCompareFocusTarget,
  getSchedulerSuggestionTutorIds,
} from "@/components/scheduler/scheduler-compare-focus";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function suggestion(overrides: Parameters<typeof buildSchedulerCompareFocusTarget>[0]) {
  return overrides;
}

describe("scheduler compare focus helpers", () => {
  it("focuses a recurring Sunday suggestion on the current compare week", () => {
    const target = buildSchedulerCompareFocusTarget(
      suggestion({
        searchMode: "recurring",
        dayOfWeek: 0,
        tutors: [
          { tutorGroupId: "ras" },
          { tutorGroupId: "a" },
          { tutorGroupId: "mimi" },
        ],
      }),
      "2026-05-18",
    );

    expect(target).toEqual({
      tutorIds: ["ras", "a", "mimi"],
      weekStart: "2026-05-18",
      activeDay: 0,
    });
  });

  it("focuses a one-time dated suggestion on that date's week and weekday", () => {
    const target = buildSchedulerCompareFocusTarget(
      suggestion({
        searchMode: "one_time",
        date: "2026-05-24",
        tutors: [
          { tutorGroupId: "ras" },
          { tutorGroupId: "a" },
        ],
      }),
      "2026-05-11",
    );

    expect(target).toEqual({
      tutorIds: ["ras", "a"],
      weekStart: "2026-05-18",
      activeDay: 0,
    });
  });

  it("limits focused compare tutors to the first three suggestion tutors", () => {
    expect(getSchedulerSuggestionTutorIds(
      suggestion({
        searchMode: "recurring",
        dayOfWeek: 2,
        tutors: [
          { tutorGroupId: "one" },
          { tutorGroupId: "two" },
          { tutorGroupId: "three" },
          { tutorGroupId: "four" },
        ],
      }),
    )).toEqual(["one", "two", "three"]);
  });
});

describe("scheduler workspace compare integration source guardrails", () => {
  it("embeds the existing compare panel and hook", () => {
    const source = read("src/components/scheduler/scheduler-workspace.tsx");

    expect(source).toContain('import { ComparePanel } from "@/components/compare/compare-panel";');
    expect(source).toContain('import { useCompare } from "@/hooks/use-compare";');
    expect(source).toContain("<ComparePanel");
    expect(source).toContain("const compare = useCompare();");
  });

  it("keeps suggestion compare as in-page focus instead of /search navigation", () => {
    const source = read("src/components/scheduler/scheduler-workspace.tsx");

    expect(source).toContain("onCompareSuggestion");
    expect(source).toContain("focusCompareSuggestion");
    expect(source).not.toContain("compareHref");
    expect(source).not.toContain('href={compareHref(suggestion)}');
  });
});

describe("scheduler workspace LINE triage guardrails", () => {
  it("renders the dominant LINE review queue before the generic chat list", () => {
    const source = read("src/components/scheduler/scheduler-workspace.tsx");

    expect(source.indexOf("<LineQueueBand")).toBeLessThan(source.indexOf("Search conversations"));
    expect(source).toContain("LINE Review Queue");
    expect(source).toContain("lineQueueExpanded");
    expect(source).toContain("Line queue compact");
  });

  it("keeps active LINE reviews outside the message scroller and collapses reviewed audits", () => {
    const source = read("src/components/scheduler/scheduler-workspace.tsx");

    expect(source.indexOf("Active LINE review")).toBeLessThan(source.indexOf("messages.map"));
    expect(source.indexOf("Active LINE review")).toBeLessThan(source.indexOf("min-h-0 flex-1 overflow-y-auto rounded-md"));
    expect(source).not.toContain("sticky top-0 z-20");
    expect(source).not.toContain("sticky bottom-0");
    expect(source).toContain('setExpanded(review.status === "pending_review")');
    expect(source).toContain("Audit");
  });

  it("surfaces compact admin owner filters and deterministic admin accents", () => {
    const source = read("src/components/scheduler/scheduler-workspace.tsx");

    expect(source).toContain("adminFacets.map");
    expect(source).toContain("adminAccentFor");
    expect(source).toContain("Needs review first");
    expect(source).toContain('aria-label="Admin filter"');
    expect(source).not.toContain("Admin chats");
    expect(source).not.toContain("max-h-24 flex-wrap");
  });

  it("does not render a redundant sidebar LINE reviews card", () => {
    const source = read("src/components/scheduler/scheduler-workspace.tsx");

    expect(source).not.toContain("Avg model");
    expect(source).not.toContain("Classified</div>");
    expect(source).toContain("LINE Review Queue");
  });
});
