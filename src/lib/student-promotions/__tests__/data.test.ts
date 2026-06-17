import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  fetchWiseCourse,
  fetchWiseCourseParticipants,
  fetchWiseStudentRegistrationData,
  updateWiseCourseSubject,
  updateWiseStudentRegistrationAnswers,
} from "@/lib/wise/fetchers";
import { applyVerifiedStudentPromotionRun } from "../data";

vi.mock("@/lib/wise/fetchers", () => ({
  fetchWiseAcceptedStudents: vi.fn(),
  fetchWiseCourse: vi.fn(),
  fetchWiseCourseParticipants: vi.fn(),
  fetchWiseStudentRegistrationData: vi.fn(),
  updateWiseCourseSubject: vi.fn(),
  updateWiseStudentRegistrationAnswers: vi.fn(),
}));

type PromotionRun = typeof schema.studentPromotionRuns.$inferSelect;
type GradeAction = typeof schema.studentPromotionGradeActions.$inferSelect;
type CourseAction = typeof schema.studentPromotionCourseActions.$inferSelect;

interface FakeState {
  run: PromotionRun;
  gradeActions: GradeAction[];
  courseActions: CourseAction[];
  updates: Array<{ table: string; patch: Record<string, unknown> }>;
}

function promotionRun(overrides: Partial<PromotionRun> = {}): PromotionRun {
  return {
    id: "run-1",
    targetDate: "2026-07-01",
    status: "verified",
    sourceSnapshotId: "snapshot-1",
    wiseAcceptedStudentCount: 1,
    websiteSnapshotStudentCount: 1,
    gradeOnlyCount: 1,
    year8CourseMoveCount: 0,
    year11CourseMoveCount: 0,
    skippedGradeCount: 0,
    pendingCourseActionCount: 0,
    skippedCourseActionCount: 0,
    verifiedAt: new Date("2026-06-20T00:00:00.000Z"),
    verifiedByEmail: "admin@example.com",
    verifiedByName: "Admin",
    endpointVerificationNote: "Verified with no-op record",
    applyStartedAt: null,
    applyFinishedAt: null,
    appliedByEmail: null,
    appliedByName: null,
    errorSummary: null,
    metadata: {},
    createdByEmail: "admin@example.com",
    createdByName: "Admin",
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    ...overrides,
  } as PromotionRun;
}

function gradeAction(overrides: Partial<GradeAction> = {}): GradeAction {
  return {
    id: "grade-1",
    runId: "run-1",
    wiseStudentId: "student-1",
    studentName: "Student One",
    studentKey: "student-one",
    currentGradeRaw: "Year 8",
    parsedCurrentYear: 8,
    targetGrade: "Year 9 / Grade 8",
    actionType: "grade_increment_only",
    status: "pending",
    skipReason: null,
    requestPayload: null,
    responsePayload: null,
    errorMessage: null,
    appliedAt: null,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    ...overrides,
  } as GradeAction;
}

function courseAction(overrides: Partial<CourseAction> = {}): CourseAction {
  return {
    id: "course-1",
    runId: "run-1",
    wiseClassId: "class-1",
    currentSubject: "Y2-8 / G1-7 (Int.)",
    targetSubject: "Y9-11 / G8-10 (Int.)",
    transitionType: "year8_to_year9",
    studentIds: ["student-1", "student-2"],
    qualifyingStudentIds: ["student-1", "student-2"],
    status: "pending",
    skipReason: null,
    requestPayload: null,
    responsePayload: null,
    errorMessage: null,
    appliedAt: null,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    ...overrides,
  } as CourseAction;
}

function fakeDb(state: FakeState) {
  function rowsFor(table: unknown) {
    if (table === schema.studentPromotionRuns) return [state.run];
    if (table === schema.studentPromotionGradeActions) return state.gradeActions;
    if (table === schema.studentPromotionCourseActions) return state.courseActions;
    return [];
  }

  return {
    select() {
      return {
        from(table: unknown) {
          const builder = {
            where: () => builder,
            orderBy: () => builder,
            limit: (count: number) => Promise.resolve(rowsFor(table).slice(0, count)),
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rowsFor(table)).then(resolve, reject),
          };
          return builder;
        },
      };
    },
    update(table: unknown) {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where: () => {
              if (table === schema.studentPromotionRuns) {
                state.run = { ...state.run, ...patch };
                state.updates.push({ table: "runs", patch });
              } else if (table === schema.studentPromotionGradeActions) {
                state.gradeActions[0] = { ...state.gradeActions[0], ...patch };
                state.updates.push({ table: "gradeActions", patch });
              } else if (table === schema.studentPromotionCourseActions) {
                state.courseActions[0] = { ...state.courseActions[0], ...patch };
                state.updates.push({ table: "courseActions", patch });
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
}

function registrationAnswer(answer: string) {
  return {
    registrationData: {
      fields: [{ questionId: "if89sblj", answer }],
    },
  };
}

describe("student promotion apply service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    let now = Date.parse("2026-07-01T01:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 200;
      return now;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to apply before the July 1 Bangkok window", async () => {
    const state: FakeState = {
      run: promotionRun(),
      gradeActions: [gradeAction()],
      courseActions: [],
      updates: [],
    };

    await expect(applyVerifiedStudentPromotionRun({
      runId: "run-1",
      trigger: "admin",
      now: new Date("2026-06-30T17:04:59.000Z"),
      db: fakeDb(state) as never,
      client: {} as never,
    })).rejects.toThrow("cannot be applied before July 1");

    expect(fetchWiseStudentRegistrationData).not.toHaveBeenCalled();
    expect(updateWiseStudentRegistrationAnswers).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("returns an already terminal run without applying pending actions again", async () => {
    const state: FakeState = {
      run: promotionRun({ status: "applied" }),
      gradeActions: [gradeAction()],
      courseActions: [courseAction()],
      updates: [],
    };

    const detail = await applyVerifiedStudentPromotionRun({
      runId: "run-1",
      trigger: "cron",
      now: new Date("2026-06-30T17:05:00.000Z"),
      db: fakeDb(state) as never,
      client: {} as never,
    });

    expect(detail.run.status).toBe("applied");
    expect(fetchWiseStudentRegistrationData).not.toHaveBeenCalled();
    expect(fetchWiseCourse).not.toHaveBeenCalled();
    expect(updateWiseStudentRegistrationAnswers).not.toHaveBeenCalled();
    expect(updateWiseCourseSubject).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("revalidates grade and course actions immediately before Wise writes", async () => {
    const state: FakeState = {
      run: promotionRun(),
      gradeActions: [gradeAction()],
      courseActions: [courseAction()],
      updates: [],
    };
    vi.mocked(fetchWiseStudentRegistrationData).mockResolvedValue(registrationAnswer("Year 8") as never);
    vi.mocked(updateWiseStudentRegistrationAnswers).mockResolvedValue({ ok: true } as never);
    vi.mocked(fetchWiseCourse).mockResolvedValue({ subject: "Y2-8 / G1-7 (Int.)" } as never);
    vi.mocked(fetchWiseCourseParticipants).mockResolvedValue([
      { profile: "student", userId: { _id: "student-2" } },
      { profile: "student", userId: { _id: "student-1" } },
    ] as never);
    vi.mocked(updateWiseCourseSubject).mockResolvedValue({ ok: true } as never);

    const detail = await applyVerifiedStudentPromotionRun({
      runId: "run-1",
      trigger: "cron",
      now: new Date("2026-06-30T17:05:00.000Z"),
      db: fakeDb(state) as never,
      client: {} as never,
    });

    expect(detail.run.status).toBe("applied");
    expect(fetchWiseStudentRegistrationData).toHaveBeenCalledWith(expect.anything(), "696e1f4d90102225641cc413", "student-1");
    expect(updateWiseStudentRegistrationAnswers).toHaveBeenCalledWith(
      expect.anything(),
      "696e1f4d90102225641cc413",
      "student-1",
      [{ questionId: "if89sblj", answer: "Year 9 / Grade 8" }],
    );
    expect(fetchWiseCourse).toHaveBeenCalledWith(expect.anything(), "class-1");
    expect(fetchWiseCourseParticipants).toHaveBeenCalledWith(expect.anything(), "class-1");
    expect(updateWiseCourseSubject).toHaveBeenCalledWith(expect.anything(), "class-1", "Y9-11 / G8-10 (Int.)");
    expect(vi.mocked(fetchWiseStudentRegistrationData).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(updateWiseStudentRegistrationAnswers).mock.invocationCallOrder[0]);
    expect(vi.mocked(fetchWiseCourseParticipants).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(updateWiseCourseSubject).mock.invocationCallOrder[0]);
  });

  it("skips drifted actions and does not send Wise writes for them", async () => {
    const state: FakeState = {
      run: promotionRun(),
      gradeActions: [gradeAction()],
      courseActions: [courseAction()],
      updates: [],
    };
    vi.mocked(fetchWiseStudentRegistrationData).mockResolvedValue(registrationAnswer("Year 9") as never);
    vi.mocked(fetchWiseCourse).mockResolvedValue({ subject: "Y2-8 / G1-7 (Int.)" } as never);
    vi.mocked(fetchWiseCourseParticipants).mockResolvedValue([
      { profile: "student", userId: { _id: "student-1" } },
      { profile: "student", userId: { _id: "unexpected-student" } },
    ] as never);

    const detail = await applyVerifiedStudentPromotionRun({
      runId: "run-1",
      trigger: "cron",
      now: new Date("2026-06-30T17:05:00.000Z"),
      db: fakeDb(state) as never,
      client: {} as never,
    });

    expect(detail.run.status).toBe("applied_with_errors");
    expect(state.gradeActions[0].status).toBe("skipped");
    expect(state.gradeActions[0].skipReason).toBe("grade_drift");
    expect(state.courseActions[0].status).toBe("skipped");
    expect(state.courseActions[0].skipReason).toBe("course_roster_drift");
    expect(updateWiseStudentRegistrationAnswers).not.toHaveBeenCalled();
    expect(updateWiseCourseSubject).not.toHaveBeenCalled();
  });
});
