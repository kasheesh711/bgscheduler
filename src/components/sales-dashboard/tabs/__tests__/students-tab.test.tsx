import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EXPIRING_HORIZON_DAYS,
  StudentsTab,
  addDaysToIso,
  filterStudentDirectory,
  isExpiringSoon,
  matchesStudentFilter,
  seedToState,
  sortStudentDirectory,
} from "../students-tab";
import type {
  SalesDimensionsPayload,
  StudentDirectoryEntry,
} from "@/lib/sales-dashboard/types";

const TODAY = "2026-06-10";

function student(overrides: Partial<StudentDirectoryEntry> = {}): StudentDirectoryEntry {
  return {
    key: "nong a",
    displayName: "Nong A",
    displayNameVariants: ["Nong A"],
    firstSeen: "2026-01-05",
    lastPaymentDate: "2026-05-01",
    totalRevenue: 24_000,
    txnCount: 2,
    addTxnCount: 0,
    programs: ["Math"],
    reps: ["Aoeng"],
    latestValidUntil: "2026-06-15",
    status: "Active",
    decisionDate: "2026-06-29",
    ...overrides,
  };
}

function dimensions(students: StudentDirectoryEntry[]): SalesDimensionsPayload {
  return {
    months: ["2026-01-01"],
    reps: [],
    repFunnels: [],
    programs: [],
    packages: [],
    additionalMix: [],
    students,
    targetMonthlyRevenue: null,
    unparsedPackageCount: 0,
    generatedAt: "2026-06-10T00:00:00.000Z",
  };
}

describe("addDaysToIso", () => {
  it("adds days within a month", () => {
    expect(addDaysToIso("2026-06-10", 5)).toBe("2026-06-15");
  });

  it("rolls over month and year boundaries", () => {
    expect(addDaysToIso("2026-12-25", 14)).toBe("2027-01-08");
  });
});

describe("isExpiringSoon", () => {
  it("is true when the decision date falls inside the horizon, boundaries inclusive", () => {
    expect(isExpiringSoon({ decisionDate: TODAY }, TODAY)).toBe(true);
    expect(isExpiringSoon({ decisionDate: addDaysToIso(TODAY, EXPIRING_HORIZON_DAYS) }, TODAY)).toBe(true);
    expect(isExpiringSoon({ decisionDate: "2026-06-25" }, TODAY)).toBe(true);
  });

  it("is false past the horizon, before today, or without a decision date", () => {
    expect(isExpiringSoon({ decisionDate: addDaysToIso(TODAY, EXPIRING_HORIZON_DAYS + 1) }, TODAY)).toBe(false);
    expect(isExpiringSoon({ decisionDate: "2026-06-09" }, TODAY)).toBe(false);
    expect(isExpiringSoon({ decisionDate: null }, TODAY)).toBe(false);
  });
});

describe("matchesStudentFilter", () => {
  it("passes everything when no chip is active", () => {
    expect(matchesStudentFilter(student({ status: "Churned" }), null, TODAY)).toBe(true);
  });

  it("matches status chips, including Trial-only for trials not converted", () => {
    expect(matchesStudentFilter(student({ status: "Churned" }), "status:Churned", TODAY)).toBe(true);
    expect(matchesStudentFilter(student({ status: "Active" }), "status:Churned", TODAY)).toBe(false);
    expect(matchesStudentFilter(student({ status: "Trial-only" }), "status:Trial-only", TODAY)).toBe(true);
  });

  it("matches the expiring-soon quick filter on decisionDate", () => {
    expect(matchesStudentFilter(student({ decisionDate: "2026-06-20" }), "quick:expiring", TODAY)).toBe(true);
    expect(matchesStudentFilter(student({ decisionDate: "2026-08-01" }), "quick:expiring", TODAY)).toBe(false);
  });
});

describe("filterStudentDirectory", () => {
  const directory = [
    student({ key: "nong a", displayName: "Nong A", programs: ["Math"], reps: ["Aoeng"] }),
    student({
      key: "ploy",
      displayName: "Ploy",
      displayNameVariants: ["Ploy", "Ploy (IGCSE)"],
      programs: ["IGCSE Physics"],
      reps: ["Kittiya"],
      status: "Churned",
      decisionDate: "2026-03-01",
    }),
  ];

  it("matches display-name variants, programs, and reps case-insensitively", () => {
    expect(filterStudentDirectory(directory, "igcse", null, TODAY).map((entry) => entry.key)).toEqual(["ploy"]);
    expect(filterStudentDirectory(directory, "aoeng", null, TODAY).map((entry) => entry.key)).toEqual(["nong a"]);
    expect(filterStudentDirectory(directory, "MATH", null, TODAY).map((entry) => entry.key)).toEqual(["nong a"]);
  });

  it("combines the chip predicate with the query", () => {
    expect(filterStudentDirectory(directory, "ploy", "status:Churned", TODAY)).toHaveLength(1);
    expect(filterStudentDirectory(directory, "ploy", "status:Active", TODAY)).toHaveLength(0);
  });
});

describe("sortStudentDirectory", () => {
  const directory = [
    student({ key: "a", displayName: "A", lastPaymentDate: "2026-01-01", totalRevenue: 5_000, decisionDate: null }),
    student({ key: "b", displayName: "B", lastPaymentDate: "2026-05-01", totalRevenue: 1_000, decisionDate: "2026-07-01" }),
    student({ key: "c", displayName: "C", lastPaymentDate: "2026-03-01", totalRevenue: 9_000, decisionDate: "2026-06-15" }),
  ];

  it("sorts by most recent payment by default", () => {
    expect(sortStudentDirectory(directory, "recent").map((entry) => entry.key)).toEqual(["b", "c", "a"]);
  });

  it("sorts by lifetime value descending", () => {
    expect(sortStudentDirectory(directory, "ltv").map((entry) => entry.key)).toEqual(["c", "a", "b"]);
  });

  it("sorts by decision date ascending with undated entries last", () => {
    expect(sortStudentDirectory(directory, "expiring").map((entry) => entry.key)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate its input", () => {
    const before = directory.map((entry) => entry.key);
    sortStudentDirectory(directory, "ltv");
    expect(directory.map((entry) => entry.key)).toEqual(before);
  });
});

describe("seedToState", () => {
  it("ignores seeds aimed at other tabs and empty students seeds", () => {
    expect(seedToState(undefined)).toBeNull();
    expect(seedToState({ tab: "reps", rep: "Aoeng" })).toBeNull();
    expect(seedToState({ tab: "students" })).toBeNull();
  });

  it("maps studentKey and filter into panel state", () => {
    expect(seedToState({ tab: "students", studentKey: "ploy" })).toEqual({ query: "", selectedKey: "ploy" });
    expect(seedToState({ tab: "students", filter: "Nong" })).toEqual({ query: "Nong", selectedKey: null });
    expect(seedToState({ tab: "students", studentKey: "ploy", filter: "Ploy" })).toEqual({
      query: "Ploy",
      selectedKey: "ploy",
    });
  });
});

describe("StudentsTab rendering", () => {
  it("shows skeleton rows while dimensions load", () => {
    const html = renderToStaticMarkup(
      <StudentsTab dimensions={null} loading from="2026-01-01" to="2026-06-30" />,
    );
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Quick filters");
  });

  it("renders the directory with status chips, quick filters, and live-status labeling", () => {
    const html = renderToStaticMarkup(
      <StudentsTab
        dimensions={dimensions([
          student(),
          student({ key: "ploy", displayName: "Ploy", status: "Churned", decisionDate: "2026-03-01" }),
        ])}
        loading={false}
        from="2026-01-01"
        to="2026-06-30"
      />,
    );
    expect(html).toContain("Nong A");
    expect(html).toContain("Ploy");
    expect(html).toContain("status recomputed (live)");
    expect(html).toContain(`Expiring soon (≤${EXPIRING_HORIZON_DAYS}d)`);
    expect(html).toContain("Trials not converted");
    expect(html).toContain("Search students, nicknames, programs, reps…");
    expect(html).toContain("may disagree with the Overview churn list");
  });

  it("caps the visible list with an explicit +N more footer instead of silent truncation", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      student({
        key: `student-${String(index).padStart(2, "0")}`,
        displayName: `Student ${String(index).padStart(2, "0")}`,
      }),
    );
    const html = renderToStaticMarkup(
      <StudentsTab dimensions={dimensions(many)} loading={false} from="2026-01-01" to="2026-06-30" />,
    );
    expect(html).toContain("Student 49");
    expect(html).not.toContain("Student 55");
    expect(html).toContain("+10 more students");
    expect(html).toContain("Show all");
  });

  it("seeds the search query from a GM cross-link on first mount", () => {
    const html = renderToStaticMarkup(
      <StudentsTab
        dimensions={dimensions([student(), student({ key: "ploy", displayName: "Ploy" })])}
        loading={false}
        from="2026-01-01"
        to="2026-06-30"
        seed={{ tab: "students", filter: "Ploy" }}
      />,
    );
    expect(html).toContain('value="Ploy"');
    expect(html).not.toContain("Nong A");
  });
});
