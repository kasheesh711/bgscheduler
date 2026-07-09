import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdmissionsCaseSummary } from "@/lib/admissions/types";
import {
  ALL_CASELOAD_FILTER,
  CaseloadTable,
  DEFAULT_CASELOAD_FILTERS,
  filterCaseloadRows,
  formatDaysSinceTouch,
  sortCaseloadRows,
  toggleCaseloadSort,
} from "../caseload-table";

function summary(overrides: Partial<AdmissionsCaseSummary> = {}): AdmissionsCaseSummary {
  return {
    caseId: overrides.caseId ?? "case-1",
    studentId: overrides.studentId ?? "student-1",
    studentName: overrides.studentName ?? "Ada Lovelace",
    preferredName: overrides.preferredName === undefined ? "Ada" : overrides.preferredName,
    cohortId: overrides.cohortId ?? "cohort-1",
    cohortName: overrides.cohortName ?? "Class of 2027",
    graduationYear: overrides.graduationYear ?? 2027,
    status: overrides.status ?? "active",
    counselorEmails: overrides.counselorEmails ?? ["mint@bg.com"],
    counselorNames: overrides.counselorNames ?? ["Mint"],
    progressPercent: overrides.progressPercent ?? 0,
    nextDeadline: overrides.nextDeadline ?? null,
    daysSinceLastTouch: overrides.daysSinceLastTouch === undefined ? 3 : overrides.daysSinceLastTouch,
    committedCollegeName: overrides.committedCollegeName ?? null,
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

describe("filterCaseloadRows", () => {
  const rows = [
    summary({ caseId: "c1", studentName: "Ada Lovelace", status: "active", cohortId: "cohort-1" }),
    summary({
      caseId: "c2",
      studentName: "Grace Hopper",
      preferredName: null,
      status: "committed",
      cohortId: "cohort-2",
      cohortName: "Class of 2026",
      counselorNames: ["Nok"],
      counselorEmails: ["nok@bg.com"],
    }),
  ];

  it("returns everything with the default filters", () => {
    expect(filterCaseloadRows(rows, DEFAULT_CASELOAD_FILTERS)).toHaveLength(2);
  });

  it("filters by status", () => {
    const result = filterCaseloadRows(rows, { ...DEFAULT_CASELOAD_FILTERS, status: "committed" });
    expect(result.map((row) => row.caseId)).toEqual(["c2"]);
  });

  it("filters by cohort id", () => {
    const result = filterCaseloadRows(rows, { ...DEFAULT_CASELOAD_FILTERS, cohortId: "cohort-1" });
    expect(result.map((row) => row.caseId)).toEqual(["c1"]);
  });

  it("matches search against student, preferred name, cohort, and counselor fields (case-insensitive)", () => {
    expect(
      filterCaseloadRows(rows, { ...DEFAULT_CASELOAD_FILTERS, search: "grace" }).map((r) => r.caseId),
    ).toEqual(["c2"]);
    expect(
      filterCaseloadRows(rows, { ...DEFAULT_CASELOAD_FILTERS, search: "ada" }).map((r) => r.caseId),
    ).toEqual(["c1"]);
    expect(
      filterCaseloadRows(rows, { ...DEFAULT_CASELOAD_FILTERS, search: "nok@bg" }).map((r) => r.caseId),
    ).toEqual(["c2"]);
    expect(
      filterCaseloadRows(rows, { ...DEFAULT_CASELOAD_FILTERS, search: "2026" }).map((r) => r.caseId),
    ).toEqual(["c2"]);
  });

  it("combines status + cohort + search (all must match)", () => {
    const result = filterCaseloadRows(rows, {
      search: "grace",
      status: "active",
      cohortId: ALL_CASELOAD_FILTER,
    });
    expect(result).toEqual([]);
  });
});

describe("sortCaseloadRows", () => {
  it("sorts by student name in both directions without mutating the input", () => {
    const rows = [summary({ caseId: "c2", studentName: "Zoe" }), summary({ caseId: "c1", studentName: "Ada" })];
    const asc = sortCaseloadRows(rows, { key: "studentName", direction: "asc" });
    const desc = sortCaseloadRows(rows, { key: "studentName", direction: "desc" });
    expect(asc.map((row) => row.caseId)).toEqual(["c1", "c2"]);
    expect(desc.map((row) => row.caseId)).toEqual(["c2", "c1"]);
    expect(rows[0].caseId).toBe("c2");
  });

  it("sorts by status in canonical lifecycle order", () => {
    const rows = [
      summary({ caseId: "c-archived", status: "archived" }),
      summary({ caseId: "c-active", status: "active" }),
      summary({ caseId: "c-committed", status: "committed" }),
    ];
    const sorted = sortCaseloadRows(rows, { key: "status", direction: "asc" });
    expect(sorted.map((row) => row.caseId)).toEqual(["c-active", "c-committed", "c-archived"]);
  });

  it("keeps never-touched rows (null daysSinceLastTouch) last in both directions", () => {
    const rows = [
      summary({ caseId: "c-null", studentName: "Null", daysSinceLastTouch: null }),
      summary({ caseId: "c-10", studentName: "Ten", daysSinceLastTouch: 10 }),
      summary({ caseId: "c-2", studentName: "Two", daysSinceLastTouch: 2 }),
    ];
    const asc = sortCaseloadRows(rows, { key: "daysSinceLastTouch", direction: "asc" });
    const desc = sortCaseloadRows(rows, { key: "daysSinceLastTouch", direction: "desc" });
    expect(asc.map((row) => row.caseId)).toEqual(["c-2", "c-10", "c-null"]);
    expect(desc.map((row) => row.caseId)).toEqual(["c-10", "c-2", "c-null"]);
  });

  it("breaks ties by student name ascending", () => {
    const rows = [
      summary({ caseId: "c-b", studentName: "Bee", status: "active" }),
      summary({ caseId: "c-a", studentName: "Ant", status: "active" }),
    ];
    const sorted = sortCaseloadRows(rows, { key: "status", direction: "desc" });
    expect(sorted.map((row) => row.caseId)).toEqual(["c-a", "c-b"]);
  });
});

describe("toggleCaseloadSort", () => {
  it("switches to a new column ascending", () => {
    expect(toggleCaseloadSort({ key: "studentName", direction: "desc" }, "cohort")).toEqual({
      key: "cohort",
      direction: "asc",
    });
  });

  it("flips direction on the active column", () => {
    expect(toggleCaseloadSort({ key: "cohort", direction: "asc" }, "cohort")).toEqual({
      key: "cohort",
      direction: "desc",
    });
    expect(toggleCaseloadSort({ key: "cohort", direction: "desc" }, "cohort")).toEqual({
      key: "cohort",
      direction: "asc",
    });
  });
});

describe("formatDaysSinceTouch", () => {
  it("renders a placeholder for null, Today for 0, and Nd ago otherwise", () => {
    expect(formatDaysSinceTouch(null)).toBe("—");
    expect(formatDaysSinceTouch(0)).toBe("Today");
    expect(formatDaysSinceTouch(12)).toBe("12d ago");
  });
});

describe("CaseloadTable", () => {
  it("renders one row per case with student, cohort, status, and counselors", () => {
    const html = renderToStaticMarkup(
      <CaseloadTable
        rows={[
          summary({ caseId: "c1", studentName: "Ada Lovelace" }),
          summary({
            caseId: "c2",
            studentName: "Grace Hopper",
            preferredName: null,
            status: "committed",
            counselorNames: ["Nok", "Mint"],
          }),
        ]}
      />,
    );
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("(Ada)");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain("Class of 2027");
    expect(html).toContain("Committed");
    expect(html).toContain("Nok, Mint");
  });

  it("renders placeholders for the phase-1 progress and next-deadline columns", () => {
    const html = renderToStaticMarkup(
      <CaseloadTable rows={[summary({ progressPercent: 0, nextDeadline: null })]} />,
    );
    expect(html).toContain("—");
  });

  it("renders the empty state when there are no cases", () => {
    const html = renderToStaticMarkup(<CaseloadTable rows={[]} />);
    expect(html).toContain("No cases yet");
  });
});
