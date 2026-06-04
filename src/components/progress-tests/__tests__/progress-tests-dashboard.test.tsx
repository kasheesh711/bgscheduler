import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProgressBar,
  StatusBadge,
  SummaryCards,
  aiSummaryPreview,
  filterRows,
  statusTone,
} from "../progress-tests-dashboard";
import type { ProgressTestRow, ProgressTestsSummary } from "@/lib/progress-tests/types";

function row(overrides: Partial<ProgressTestRow> = {}): ProgressTestRow {
  return {
    enrollmentKey: overrides.enrollmentKey ?? "class-1|student-1",
    wiseStudentId: overrides.wiseStudentId ?? "student-1",
    wiseClassId: overrides.wiseClassId ?? "class-1",
    studentKey: overrides.studentKey ?? "Ada::Babbage",
    studentName: overrides.studentName ?? "Ada Lovelace",
    parentName: overrides.parentName ?? "Babbage",
    subject: overrides.subject ?? "Math",
    currentCount: overrides.currentCount ?? 6,
    threshold: overrides.threshold ?? 8,
    cycleIndex: overrides.cycleIndex ?? 0,
    status: overrides.status ?? "approaching",
    mostFrequentTutorCanonicalKey: overrides.mostFrequentTutorCanonicalKey ?? "alice",
    mostFrequentTutorDisplayName: overrides.mostFrequentTutorDisplayName ?? "Alice",
    teacherNotifiedAt: overrides.teacherNotifiedAt ?? null,
    teacherNotifiedForCycle: overrides.teacherNotifiedForCycle ?? null,
    bookedTestWiseSessionId: overrides.bookedTestWiseSessionId ?? null,
    bookedTestDate: overrides.bookedTestDate ?? null,
    bookedTestBookingMode: overrides.bookedTestBookingMode ?? null,
    lastClassDate: overrides.lastClassDate ?? null,
    lastAiSummary: overrides.lastAiSummary ?? null,
    lastAiSummaryAt: overrides.lastAiSummaryAt ?? null,
    updatedByEmail: overrides.updatedByEmail ?? null,
    updatedAt: overrides.updatedAt ?? null,
  };
}

describe("filterRows", () => {
  const rows = [
    row({ enrollmentKey: "a", studentName: "Ada Lovelace", subject: "Math", status: "due" }),
    row({ enrollmentKey: "b", studentName: "Grace Hopper", parentName: "Walter", subject: "Science", status: "scheduled" }),
    row({ enrollmentKey: "c", studentName: "Alan Turing", mostFrequentTutorDisplayName: "Bob", subject: "Math", status: "approaching" }),
  ];

  it("returns all rows when no filters are active", () => {
    expect(filterRows(rows, "all", "__all__", "")).toHaveLength(3);
  });

  it("filters by status", () => {
    const result = filterRows(rows, "due", "__all__", "");
    expect(result.map((r) => r.enrollmentKey)).toEqual(["a"]);
  });

  it("filters by subject", () => {
    const result = filterRows(rows, "all", "Math", "");
    expect(result.map((r) => r.enrollmentKey)).toEqual(["a", "c"]);
  });

  it("matches the search against student, parent, and teacher (case-insensitive)", () => {
    expect(filterRows(rows, "all", "__all__", "grace").map((r) => r.enrollmentKey)).toEqual(["b"]);
    expect(filterRows(rows, "all", "__all__", "walter").map((r) => r.enrollmentKey)).toEqual(["b"]);
    expect(filterRows(rows, "all", "__all__", "BOB").map((r) => r.enrollmentKey)).toEqual(["c"]);
  });

  it("combines status, subject, and search predicates", () => {
    expect(filterRows(rows, "approaching", "Math", "alan").map((r) => r.enrollmentKey)).toEqual(["c"]);
    expect(filterRows(rows, "due", "Science", "")).toHaveLength(0);
  });
});

describe("statusTone", () => {
  it("uses the available token for completed and destructive for due", () => {
    expect(statusTone("completed")).toContain("text-available");
    expect(statusTone("due")).toContain("text-destructive");
    expect(statusTone("scheduled")).toContain("text-sky-800");
    expect(statusTone("approaching")).toContain("text-amber-900");
  });
});

describe("aiSummaryPreview", () => {
  it("returns null when there is no summary", () => {
    expect(aiSummaryPreview(row({ lastAiSummary: null }))).toBeNull();
  });

  it("joins the structured summary fields into a single preview line", () => {
    const preview = aiSummaryPreview(
      row({
        lastAiSummary: {
          headline: "Strong term",
          strengths: ["Algebra"],
          focusAreas: ["Word problems"],
          recommendation: "Review fractions",
        },
      }),
    );
    expect(preview).toContain("Strong term");
    expect(preview).toContain("Algebra");
    expect(preview).toContain("Word problems");
    expect(preview).toContain("Review fractions");
  });
});

describe("ProgressBar", () => {
  it("renders the count fraction and clamps the fill width to 100%", () => {
    const html = renderToStaticMarkup(<ProgressBar count={10} threshold={8} />);
    expect(html).toContain("10/8");
    expect(html).toContain("width:100%");
  });

  it("computes a partial fill", () => {
    const html = renderToStaticMarkup(<ProgressBar count={6} threshold={8} />);
    expect(html).toContain("6/8");
    expect(html).toContain("width:75%");
  });
});

describe("StatusBadge", () => {
  it("renders the lifecycle label", () => {
    const html = renderToStaticMarkup(<StatusBadge status="scheduled" />);
    expect(html).toContain("scheduled");
    expect(html).toContain("text-sky-800");
  });
});

describe("SummaryCards", () => {
  it("renders the four lifecycle counts", () => {
    const summary: ProgressTestsSummary = {
      accumulating: 5,
      approaching: 2,
      due: 3,
      scheduled: 4,
      completed: 1,
      total: 15,
    };
    const html = renderToStaticMarkup(<SummaryCards summary={summary} />);
    expect(html).toContain("Approaching");
    expect(html).toContain("Due");
    expect(html).toContain("Scheduled");
    expect(html).toContain("Completed");
    // Counts present
    expect(html).toContain(">2<");
    expect(html).toContain(">3<");
    expect(html).toContain(">4<");
    expect(html).toContain(">1<");
  });
});
