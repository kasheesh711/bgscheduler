import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdmissionsCaseSummary } from "@/lib/admissions/types";
import { CaseloadBoard, groupCaseloadByStatus } from "../caseload-board";

function summary(overrides: Partial<AdmissionsCaseSummary> = {}): AdmissionsCaseSummary {
  return {
    caseId: overrides.caseId ?? "case-1",
    studentId: overrides.studentId ?? "student-1",
    studentName: overrides.studentName ?? "Ada Lovelace",
    preferredName: overrides.preferredName === undefined ? null : overrides.preferredName,
    cohortId: overrides.cohortId ?? "cohort-1",
    cohortName: overrides.cohortName ?? "Class of 2027",
    graduationYear: overrides.graduationYear ?? 2027,
    status: overrides.status ?? "active",
    counselorEmails: overrides.counselorEmails ?? ["mint@bg.com"],
    counselorNames: overrides.counselorNames ?? ["Mint"],
    progressPercent: overrides.progressPercent ?? 0,
    nextDeadline: overrides.nextDeadline ?? null,
    daysSinceLastTouch: overrides.daysSinceLastTouch === undefined ? null : overrides.daysSinceLastTouch,
    committedCollegeName: overrides.committedCollegeName ?? null,
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

describe("groupCaseloadByStatus", () => {
  it("buckets rows by status and always includes all five status keys", () => {
    const groups = groupCaseloadByStatus([
      summary({ caseId: "c1", status: "active" }),
      summary({ caseId: "c2", status: "committed" }),
      summary({ caseId: "c3", status: "active" }),
    ]);
    expect(Object.keys(groups).sort()).toEqual([
      "active",
      "archived",
      "committed",
      "completed",
      "withdrawn",
    ]);
    expect(groups.active.map((row) => row.caseId)).toEqual(["c1", "c3"]);
    expect(groups.committed.map((row) => row.caseId)).toEqual(["c2"]);
    expect(groups.completed).toEqual([]);
    expect(groups.withdrawn).toEqual([]);
    expect(groups.archived).toEqual([]);
  });

  it("returns all-empty buckets for an empty caseload", () => {
    const groups = groupCaseloadByStatus([]);
    expect(Object.values(groups).every((bucket) => bucket.length === 0)).toBe(true);
  });

  it("preserves input order inside each bucket", () => {
    const groups = groupCaseloadByStatus([
      summary({ caseId: "z", studentName: "Zoe", status: "withdrawn" }),
      summary({ caseId: "a", studentName: "Ada", status: "withdrawn" }),
    ]);
    expect(groups.withdrawn.map((row) => row.caseId)).toEqual(["z", "a"]);
  });
});

describe("CaseloadBoard", () => {
  it("renders one labeled column per status with per-column counts", () => {
    const html = renderToStaticMarkup(
      <CaseloadBoard
        rows={[
          summary({ caseId: "c1", status: "active" }),
          summary({ caseId: "c2", studentName: "Grace Hopper", status: "committed" }),
        ]}
      />,
    );
    expect(html).toContain("Active cases");
    expect(html).toContain("Committed cases");
    expect(html).toContain("Completed cases");
    expect(html).toContain("Withdrawn cases");
    expect(html).toContain("Archived cases");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Grace Hopper");
  });

  it("puts each card in its status column and shows cohort + committed college", () => {
    const html = renderToStaticMarkup(
      <CaseloadBoard
        rows={[
          summary({
            caseId: "c2",
            studentName: "Grace Hopper",
            status: "committed",
            committedCollegeName: "MIT",
            daysSinceLastTouch: 4,
          }),
        ]}
      />,
    );
    expect(html).toContain("MIT");
    expect(html).toContain("Class of 2027");
    expect(html).toContain("4d ago");
    // The empty active column keeps its empty state.
    expect(html).toContain("No cases");
  });

  it("renders empty states for every column when there are no cases", () => {
    const html = renderToStaticMarkup(<CaseloadBoard rows={[]} />);
    const matches = html.match(/No cases/g) ?? [];
    expect(matches).toHaveLength(5);
  });
});
