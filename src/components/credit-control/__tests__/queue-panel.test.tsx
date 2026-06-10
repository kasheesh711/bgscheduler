import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QueuePanel } from "../queue-panel";
import { QUEUE_WINDOW_INITIAL } from "@/lib/credit-control/queue-window";
import type { SortState } from "@/lib/credit-control/ui-helpers";
import type { StudentQueueRow, SummaryPayload } from "@/types/credit-control";

// ---------------------------------------------------------------------------
// Fixtures — node-env static markup, per the repo component-test pattern
// ---------------------------------------------------------------------------

function makeSummary(): SummaryPayload {
  const statuses = { notify: 0, watch: 0, ok: 0, nodata: 0, total: 0 };
  return {
    students: { ...statuses },
    packages: { ...statuses },
    portfolio: {
      exhaustedNow: 0,
      risk7: 0,
      risk14: 0,
      risk30: 0,
      noSchedule: 0,
      pendingDeductionBacklog: 0,
      pendingDeductionPackages: 0,
      lowBalanceNoSchedule: 0,
      multiRiskStudents: 0,
    },
    queue: { students: 0, pinnedStudents: 0 },
    deltas: {
      packagesNotify: null,
      packagesWatch: null,
      risk7: null,
      risk30: null,
      pendingDeductionBacklog: null,
      noSchedule: null,
      queueStudents: null,
      pinnedStudents: null,
    },
  };
}

function makeRow(index: number, overrides: Partial<StudentQueueRow> = {}): StudentQueueRow {
  const id = String(index + 1).padStart(3, "0");
  return {
    key: `row-${id}`,
    studentKey: `student-${id}`,
    student: `Student ${id}`,
    parent: `Parent ${id}`,
    studentIndex: index,
    adminOwnerKey: "unassigned",
    adminOwnerName: "Unassigned",
    actionState: null,
    worstStatus: "notify",
    packageCount: 1,
    riskyPackageCount: 1,
    totalCurrentRemaining: 2,
    totalAdjustedRemaining: 1,
    totalPendingDeduction: 1,
    totalCredits: 20,
    packageNames: ["Math 20h"],
    nextSessionDate: "2026-06-12",
    nextSessionPackageName: "Math 20h",
    nextSessionCount: 1,
    nextAlertDate: null,
    nextExhaustDate: null,
    daysUntilAlert: null,
    daysUntilExhaust: null,
    noFutureSchedule: false,
    pinned: false,
    includeInQueue: true,
    priorityScore: 50,
    recommendedAction: "Notify parent",
    whyNow: "Low balance",
    searchText: `student ${id} parent ${id} math 20h`,
    ...overrides,
  };
}

function makeRows(count: number): StudentQueueRow[] {
  return Array.from({ length: count }, (_, index) => makeRow(index));
}

const noop = () => undefined;
const SORT: SortState = { field: "priorityScore", dir: "desc" };

function renderPanel(
  rows: StudentQueueRow[],
  overrides: Partial<React.ComponentProps<typeof QueuePanel>> = {},
): string {
  return renderToStaticMarkup(
    <QueuePanel
      sortedQueue={rows}
      selectedStudentKey=""
      onSelectStudent={noop}
      onToggleSelection={noop}
      selectedKeySet={new Set<string>()}
      currentSort={SORT}
      onToggleSort={noop}
      submitting={false}
      onSubmitAction={noop}
      adminScopedSummary={makeSummary()}
      onToggleAllVisible={noop}
      visibleSelectedCount={0}
      {...overrides}
    />,
  );
}

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

describe("QueuePanel windowing", () => {
  it("renders only the initial window plus a load-more sentinel for long lists", () => {
    const markup = renderPanel(makeRows(QUEUE_WINDOW_INITIAL + 40));

    const lastVisible = String(QUEUE_WINDOW_INITIAL).padStart(3, "0");
    const firstHidden = String(QUEUE_WINDOW_INITIAL + 1).padStart(3, "0");
    expect(markup).toContain(`Student ${lastVisible}`);
    expect(markup).not.toContain(`Student ${firstHidden}`);
    expect(markup).toContain("queue-sentinel");
  });

  it("renders the sentinel as a manual load-more button with progress counts", () => {
    const markup = renderPanel(makeRows(QUEUE_WINDOW_INITIAL + 40));

    // Keyboard and screen-reader users get a real button — scroll-driven
    // IntersectionObserver growth is not their only path to the hidden rows.
    expect(markup).toContain(
      `Show more (${QUEUE_WINDOW_INITIAL} of ${QUEUE_WINDOW_INITIAL + 40})`,
    );
  });

  it("still reports the full filtered count in the header while windowed", () => {
    const markup = renderPanel(makeRows(QUEUE_WINDOW_INITIAL + 40));
    expect(markup).toContain(`${QUEUE_WINDOW_INITIAL + 40} students`);
  });

  it("renders every row without a sentinel for short lists", () => {
    const markup = renderPanel(makeRows(10));
    expect(markup).toContain("Student 010");
    expect(markup).not.toContain("queue-sentinel");
  });
});

// ---------------------------------------------------------------------------
// Single-layout rendering
// ---------------------------------------------------------------------------

describe("QueuePanel single-layout rendering", () => {
  it("mounts only the desktop table outside compact viewports (no duplicate card list)", () => {
    const markup = renderPanel(makeRows(5));

    expect(markup).toContain("queue-table-wrap");
    expect(markup).not.toContain("queue-card-list");
    // Each row renders exactly once — previously both layouts were in the DOM,
    // doubling every row's action buttons.
    expect(markup.split("Mark Student 003 contacted").length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Selection + row state
// ---------------------------------------------------------------------------

describe("QueuePanel selection and row state", () => {
  it("checks exactly the rows present in the selection set", () => {
    const markup = renderPanel(makeRows(10), {
      selectedKeySet: new Set(["student-002"]),
      visibleSelectedCount: 1,
    });

    expect((markup.match(/checked=""/g) ?? []).length).toBe(1);
  });

  it("checks the select-all box when every visible row is selected", () => {
    const rows = makeRows(3);
    const markup = renderPanel(rows, {
      selectedKeySet: new Set(rows.map((row) => row.studentKey)),
      visibleSelectedCount: 3,
    });

    // 3 row checkboxes + the header select-all box.
    expect((markup.match(/checked=""/g) ?? []).length).toBe(4);
  });

  it("flags optimistic and active rows with their status classes", () => {
    const markup = renderPanel(makeRows(3), {
      selectedStudentKey: "student-001",
      optimisticKeys: new Set(["student-002"]),
    });

    expect(markup).toContain("is-active");
    expect(markup).toContain("row-optimistic");
  });
});

// ---------------------------------------------------------------------------
// Sortable headers
// ---------------------------------------------------------------------------

describe("QueuePanel sortable headers", () => {
  it("announces the active sort via aria-sort and renders inactive headers as none", () => {
    const markup = renderPanel(makeRows(3), {
      currentSort: { field: "student", dir: "asc" },
    });

    expect(markup).toContain('aria-sort="ascending"');
    // The two other sortable columns (Actual, Next) are not sorted.
    expect((markup.match(/aria-sort="none"/g) ?? []).length).toBe(2);
  });

  it("exposes each sortable header as a real button", () => {
    const markup = renderPanel(makeRows(3));
    expect((markup.match(/class="sort-button"/g) ?? []).length).toBe(3);
  });
});
