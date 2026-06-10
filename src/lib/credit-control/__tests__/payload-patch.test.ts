import { describe, expect, it } from "vitest";

import {
  buildOptimisticInactiveEntry,
  captureWorklistRows,
  patchActionStateInPayload,
  removeStudentFromWorklist,
  restoreStudentToWorklist,
} from "@/lib/credit-control/payload-patch";
import type {
  ActionState,
  DashboardPayload,
  InactiveStudentSummary,
  StudentQueueRow,
  StudentRecord,
  SummaryPayload,
} from "@/types/credit-control";

// ---------------------------------------------------------------------------
// Fixtures
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

function makeQueueRow(overrides: Partial<StudentQueueRow> = {}): StudentQueueRow {
  return {
    key: "row-a",
    studentKey: "a",
    student: "Student A",
    parent: "Parent A",
    studentIndex: 0,
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
    searchText: "student a parent a math 20h",
    ...overrides,
  };
}

function makeStudent(overrides: Partial<StudentRecord> = {}): StudentRecord {
  return {
    student: "Student A",
    parent: "Parent A",
    packages: [],
    dataQualityFlags: [],
    adminOwnerKey: "unassigned",
    adminOwnerName: "Unassigned",
    adminOwnershipSource: "default",
    studentKey: "a",
    actionState: null,
    ...overrides,
  };
}

function makePayload(overrides: Partial<DashboardPayload> = {}): DashboardPayload {
  return {
    adminViews: [],
    lastUpdatedAt: "2026-06-10T08:00:00.000Z",
    previousUpdatedAt: null,
    summary: makeSummary(),
    studentQueue: [],
    studentQueueAll: [],
    calendar: { availableStart: null, availableEnd: null, days: [] },
    students: [],
    inactiveStudents: [],
    ...overrides,
  };
}

const ACTION: ActionState = {
  status: "contacted",
  updatedAt: "2026-06-10T08:30:00.000Z",
  updatedByName: "Kev",
  isToday: true,
};

// ---------------------------------------------------------------------------
// patchActionStateInPayload
// ---------------------------------------------------------------------------

describe("patchActionStateInPayload", () => {
  it("patches the student across students, studentQueue, AND studentQueueAll", () => {
    const payload = makePayload({
      students: [makeStudent(), makeStudent({ studentKey: "b", student: "Student B" })],
      studentQueue: [makeQueueRow()],
      studentQueueAll: [makeQueueRow(), makeQueueRow({ studentKey: "b", key: "row-b" })],
    });

    const result = patchActionStateInPayload(payload, "a", ACTION);

    expect(result.students[0].actionState).toEqual(ACTION);
    expect(result.studentQueue[0].actionState).toEqual(ACTION);
    expect(result.studentQueueAll[0].actionState).toEqual(ACTION);
    expect(result.studentQueueAll[1].actionState).toBeNull();
  });

  it("keeps untouched rows referentially identical so memoized rows skip re-render", () => {
    const payload = makePayload({
      students: [makeStudent(), makeStudent({ studentKey: "b" })],
      studentQueue: [makeQueueRow(), makeQueueRow({ studentKey: "b", key: "row-b" })],
      studentQueueAll: [makeQueueRow(), makeQueueRow({ studentKey: "b", key: "row-b" })],
    });

    const result = patchActionStateInPayload(payload, "a", ACTION);

    expect(result.studentQueue[1]).toBe(payload.studentQueue[1]);
    expect(result.studentQueueAll[1]).toBe(payload.studentQueueAll[1]);
    expect(result.students[1]).toBe(payload.students[1]);
  });

  it("clears the action state with null and does not mutate the input", () => {
    const payload = makePayload({
      students: [makeStudent({ actionState: ACTION })],
      studentQueue: [makeQueueRow({ actionState: ACTION })],
      studentQueueAll: [makeQueueRow({ actionState: ACTION })],
    });

    const result = patchActionStateInPayload(payload, "a", null);

    expect(result.students[0].actionState).toBeNull();
    expect(result.studentQueue[0].actionState).toBeNull();
    expect(result.studentQueueAll[0].actionState).toBeNull();
    expect(payload.studentQueue[0].actionState).toEqual(ACTION);
  });
});

// ---------------------------------------------------------------------------
// buildOptimisticInactiveEntry
// ---------------------------------------------------------------------------

describe("buildOptimisticInactiveEntry", () => {
  it("mirrors the server's manual-removal entry, summing currentRemaining like the route", () => {
    const entry = buildOptimisticInactiveEntry(
      {
        studentKey: "a",
        student: "Student A",
        parent: "Parent A",
        packages: [{ currentRemaining: 2.5 }, { currentRemaining: 1 }],
      },
      "2026-06-10T09:00:00.000Z",
    );

    expect(entry).toEqual({
      studentKey: "a",
      student: "Student A",
      parent: "Parent A",
      source: "manual",
      markedAt: "2026-06-10T09:00:00.000Z",
      removedAtRemaining: 3.5,
    });
  });
});

// ---------------------------------------------------------------------------
// captureWorklistRows / removeStudentFromWorklist / restoreStudentToWorklist
// ---------------------------------------------------------------------------

describe("captureWorklistRows", () => {
  it("captures the queue and queue-all rows for a student, null when absent", () => {
    const queueRow = makeQueueRow();
    const queueAllRow = makeQueueRow({ key: "row-a-all" });
    const payload = makePayload({
      studentQueue: [queueRow],
      studentQueueAll: [queueAllRow, makeQueueRow({ studentKey: "b", key: "row-b" })],
    });

    expect(captureWorklistRows(payload, "a")).toEqual({ queueRow, queueAllRow });
    expect(captureWorklistRows(payload, "b")).toEqual({
      queueRow: null,
      queueAllRow: payload.studentQueueAll[1],
    });
    expect(captureWorklistRows(payload, "zzz")).toEqual({ queueRow: null, queueAllRow: null });
  });
});

describe("removeStudentFromWorklist", () => {
  const entry: InactiveStudentSummary = {
    studentKey: "a",
    student: "Student A",
    parent: "Parent A",
    source: "manual",
    markedAt: "2026-06-10T09:00:00.000Z",
    removedAtRemaining: 3,
  };

  it("removes the student from both queue lists and appends the inactive entry", () => {
    const payload = makePayload({
      students: [makeStudent()],
      studentQueue: [makeQueueRow(), makeQueueRow({ studentKey: "b", key: "row-b" })],
      studentQueueAll: [makeQueueRow(), makeQueueRow({ studentKey: "b", key: "row-b" })],
    });

    const result = removeStudentFromWorklist(payload, "a", entry);

    expect(result.studentQueue.map((row) => row.studentKey)).toEqual(["b"]);
    expect(result.studentQueueAll.map((row) => row.studentKey)).toEqual(["b"]);
    expect(result.inactiveStudents).toEqual([entry]);
  });

  it("leaves students and calendar untouched so calendar studentIndex stays valid", () => {
    const payload = makePayload({
      students: [makeStudent(), makeStudent({ studentKey: "b" })],
      studentQueue: [makeQueueRow()],
      studentQueueAll: [makeQueueRow()],
    });

    const result = removeStudentFromWorklist(payload, "a", entry);

    expect(result.students).toBe(payload.students);
    expect(result.calendar).toBe(payload.calendar);
  });

  it("replaces an existing inactive entry for the same student instead of duplicating", () => {
    const stale: InactiveStudentSummary = { ...entry, markedAt: "2026-06-01T00:00:00.000Z" };
    const payload = makePayload({
      studentQueue: [makeQueueRow()],
      studentQueueAll: [makeQueueRow()],
      inactiveStudents: [stale],
    });

    const result = removeStudentFromWorklist(payload, "a", entry);

    expect(result.inactiveStudents).toEqual([entry]);
  });
});

describe("restoreStudentToWorklist", () => {
  it("drops the inactive entry and re-inserts the captured worklist rows", () => {
    const queueRow = makeQueueRow();
    const queueAllRow = makeQueueRow({ key: "row-a-all" });
    const payload = makePayload({
      studentQueue: [makeQueueRow({ studentKey: "b", key: "row-b" })],
      studentQueueAll: [makeQueueRow({ studentKey: "b", key: "row-b" })],
      inactiveStudents: [
        {
          studentKey: "a",
          student: "Student A",
          parent: "Parent A",
          source: "manual",
          markedAt: "2026-06-10T09:00:00.000Z",
          removedAtRemaining: 3,
        },
      ],
    });

    const result = restoreStudentToWorklist(payload, "a", { queueRow, queueAllRow });

    expect(result.inactiveStudents).toEqual([]);
    expect(result.studentQueue.map((row) => row.studentKey)).toEqual(["b", "a"]);
    expect(result.studentQueueAll.map((row) => row.studentKey)).toEqual(["b", "a"]);
  });

  it("only drops the inactive entry when no rows were captured (restore from modal)", () => {
    const payload = makePayload({
      studentQueue: [makeQueueRow({ studentKey: "b", key: "row-b" })],
      studentQueueAll: [makeQueueRow({ studentKey: "b", key: "row-b" })],
      inactiveStudents: [
        {
          studentKey: "a",
          student: "Student A",
          parent: "Parent A",
          source: "manual",
          markedAt: "2026-06-10T09:00:00.000Z",
          removedAtRemaining: 3,
        },
      ],
    });

    const result = restoreStudentToWorklist(payload, "a", null);

    expect(result.inactiveStudents).toEqual([]);
    expect(result.studentQueue.map((row) => row.studentKey)).toEqual(["b"]);
    expect(result.studentQueueAll.map((row) => row.studentKey)).toEqual(["b"]);
  });

  it("does not duplicate rows when the background refresh already restored them", () => {
    const queueRow = makeQueueRow();
    const payload = makePayload({
      studentQueue: [queueRow],
      studentQueueAll: [queueRow],
      inactiveStudents: [],
    });

    const result = restoreStudentToWorklist(payload, "a", { queueRow, queueAllRow: queueRow });

    expect(result.studentQueue.map((row) => row.studentKey)).toEqual(["a"]);
    expect(result.studentQueueAll.map((row) => row.studentKey)).toEqual(["a"]);
  });

  it("round-trips with removeStudentFromWorklist", () => {
    const payload = makePayload({
      studentQueue: [makeQueueRow(), makeQueueRow({ studentKey: "b", key: "row-b" })],
      studentQueueAll: [makeQueueRow(), makeQueueRow({ studentKey: "b", key: "row-b" })],
    });

    const removed = captureWorklistRows(payload, "a");
    const without = removeStudentFromWorklist(
      payload,
      "a",
      buildOptimisticInactiveEntry(
        { studentKey: "a", student: "Student A", parent: "Parent A", packages: [] },
        "2026-06-10T09:00:00.000Z",
      ),
    );
    const restored = restoreStudentToWorklist(without, "a", removed);

    expect(restored.studentQueue.map((row) => row.studentKey).sort()).toEqual(["a", "b"]);
    expect(restored.studentQueueAll.map((row) => row.studentKey).sort()).toEqual(["a", "b"]);
    expect(restored.inactiveStudents).toEqual([]);
  });
});
