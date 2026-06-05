import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Database } from "@/lib/db";
import type { WiseClient } from "@/lib/wise/client";
import { PROGRESS_TEST_COUNTING_START } from "@/lib/progress-tests/config";
import type { ProgressTestCycleStateInsert, ProgressTestCycleStateRecord } from "@/lib/progress-tests/db";
import {
  insertBooking,
  loadCycleState,
  markLedgerRowAsProgressTest,
  resolveTeacherUserIdForCanonicalKey,
  upsertCycleState,
} from "@/lib/progress-tests/db";
import { checkTeacherAvailabilityForSessions, scheduleWiseSession } from "@/lib/wise/fetchers";
import { confirmProgressTestBooking, markAtHomeSubmitted, selectAtHomeOption } from "@/lib/progress-tests/booking";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn(() => ({}) as WiseClient) }));
vi.mock("@/lib/wise/fetchers", () => ({
  checkTeacherAvailabilityForSessions: vi.fn(),
  scheduleWiseSession: vi.fn(),
}));
vi.mock("@/lib/progress-tests/db", () => ({
  insertBooking: vi.fn(),
  loadCycleState: vi.fn(),
  markLedgerRowAsProgressTest: vi.fn(),
  resolveTeacherUserIdForCanonicalKey: vi.fn(),
  upsertCycleState: vi.fn(),
}));

const insertBookingMock = insertBooking as unknown as Mock;
const loadCycleStateMock = loadCycleState as unknown as Mock;
const markLedgerRowMock = markLedgerRowAsProgressTest as unknown as Mock;
const resolveTeacherUserIdMock = resolveTeacherUserIdForCanonicalKey as unknown as Mock;
const upsertCycleStateMock = upsertCycleState as unknown as Mock;
const checkAvailabilityMock = checkTeacherAvailabilityForSessions as unknown as Mock;
const scheduleWiseSessionMock = scheduleWiseSession as unknown as Mock;

const START = new Date("2026-06-10T09:00:00.000Z");
const END = new Date("2026-06-10T10:00:00.000Z");

function makeCycleStateRecord(
  overrides: Partial<ProgressTestCycleStateRecord> = {},
): ProgressTestCycleStateRecord {
  return {
    enrollmentKey: "class-1|student-1",
    wiseStudentId: "student-1",
    wiseClassId: "class-1",
    studentKey: "ada|parent",
    studentName: "Ada Lovelace",
    subject: "Math",
    currentCount: 8,
    currentCycleStart: PROGRESS_TEST_COUNTING_START,
    cycleIndex: 0,
    status: "due",
    bookedTestWiseSessionId: null,
    bookedTestDate: null,
    bookedTestBookingMode: null,
    scheduleMethod: null,
    bookedTestLocation: null,
    atHomeSelectedAt: null,
    atHomeSubmittedAt: null,
    teacherNotifiedAt: null,
    teacherNotifiedForCycle: null,
    mostFrequentTutorCanonicalKey: "alice",
    mostFrequentTutorDisplayName: "Alice",
    lastAiSummary: null,
    lastAiSummaryAt: null,
    lastClassDate: null,
    updatedByEmail: null,
    updatedAt: PROGRESS_TEST_COUNTING_START,
    ...overrides,
  };
}

function bookingDb(): Database {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  } as unknown as Database;
}

describe("confirmProgressTestBooking", () => {
  const originalFlag = process.env.WISE_SESSION_CREATE_VERIFIED;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WISE_SESSION_CREATE_VERIFIED;
    loadCycleStateMock.mockResolvedValue(makeCycleStateRecord());
    resolveTeacherUserIdMock.mockResolvedValue("teacher-user-1");
    insertBookingMock.mockImplementation(async (input) => ({ id: "booking-1", ...input }));
    upsertCycleStateMock.mockResolvedValue(undefined);
    markLedgerRowMock.mockResolvedValue(undefined);
    checkAvailabilityMock.mockResolvedValue({ sessions: [{ sessionId: "s", conflict: false }] });
    scheduleWiseSessionMock.mockResolvedValue({ sessionId: "wise-session-1", raw: {} });
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.WISE_SESSION_CREATE_VERIFIED;
    else process.env.WISE_SESSION_CREATE_VERIFIED = originalFlag;
  });

  it("records the booking and makes NO Wise create call when the flag is off", async () => {
    const result = await confirmProgressTestBooking({
      enrollmentKey: "class-1|student-1",
      scheduledTestStart: START,
      scheduledTestEnd: END,
      scheduleMethod: "parent_pick",
      actor: { email: "Admin@Example.com", name: "Admin" },
      db: bookingDb(),
    });

    expect(insertBookingMock).toHaveBeenCalledTimes(1);
    // Step 1 audit row carries the intended endpoint + body.
    const audit = insertBookingMock.mock.calls[0][0];
    expect(audit.status).toBe("recorded");
    expect(audit.dryRun).toBe(true);
    expect(audit.requestPayload.endpoint).toBe("/teacher/classes/class-1/sessions");
    expect(audit.createdByEmail).toBe("admin@example.com");

    expect(scheduleWiseSessionMock).not.toHaveBeenCalled();
    expect(result.status).toBe("manual_required");
    expect(result.wiseSessionId).toBeNull();
    expect(result.bookingMode).toBe("manual");

    // The locally-stored booked date still drives the cycle (status scheduled).
    expect(upsertCycleStateMock).toHaveBeenCalledTimes(1);
    const upserted = upsertCycleStateMock.mock.calls[0][0];
    expect(upserted.status).toBe("scheduled");
    expect(upserted.bookedTestDate).toEqual(START);
    expect(upserted.bookedTestBookingMode).toBe("manual");
    expect(upserted.bookedTestWiseSessionId).toBeNull();
  });

  it("aborts fail-closed when the availability pre-check reports a conflict", async () => {
    process.env.WISE_SESSION_CREATE_VERIFIED = "true";
    checkAvailabilityMock.mockResolvedValue({ sessions: [{ sessionId: "s", hasConflict: true }] });

    const result = await confirmProgressTestBooking({
      enrollmentKey: "class-1|student-1",
      scheduledTestStart: START,
      scheduledTestEnd: END,
      scheduleMethod: "parent_pick",
      db: bookingDb(),
    });

    expect(result.status).toBe("failed");
    expect(scheduleWiseSessionMock).not.toHaveBeenCalled();
    // No cycle transition on a conflict abort.
    expect(upsertCycleStateMock).not.toHaveBeenCalled();
    expect(markLedgerRowMock).not.toHaveBeenCalled();
  });

  it("calls scheduleWiseSession and stores the returned sessionId when the flag is on", async () => {
    process.env.WISE_SESSION_CREATE_VERIFIED = "true";

    const result = await confirmProgressTestBooking({
      enrollmentKey: "class-1|student-1",
      scheduledTestStart: START,
      scheduledTestEnd: END,
      scheduleMethod: "parent_pick",
      location: "Joy",
      db: bookingDb(),
    });

    expect(scheduleWiseSessionMock).toHaveBeenCalledTimes(1);
    expect(scheduleWiseSessionMock.mock.calls[0][1]).toMatchObject({
      classId: "class-1",
      userId: "teacher-user-1",
      title: "Progress Test",
      scheduledStartTime: START.toISOString(),
      scheduledEndTime: END.toISOString(),
      location: "Joy",
    });
    expect(result.status).toBe("wise_created");
    expect(result.wiseSessionId).toBe("wise-session-1");
    expect(result.bookingMode).toBe("wise");

    const upserted = upsertCycleStateMock.mock.calls[0][0];
    expect(upserted.status).toBe("scheduled");
    expect(upserted.bookedTestWiseSessionId).toBe("wise-session-1");
    expect(upserted.bookedTestBookingMode).toBe("wise");
  });

  it("marks the booked ledger row as the progress test when Wise returns a sessionId", async () => {
    process.env.WISE_SESSION_CREATE_VERIFIED = "true";

    await confirmProgressTestBooking({
      enrollmentKey: "class-1|student-1",
      scheduledTestStart: START,
      scheduledTestEnd: END,
      scheduleMethod: "parent_pick",
      db: bookingDb(),
    });

    expect(markLedgerRowMock).toHaveBeenCalledWith("wise-session-1", "student-1", expect.anything());
  });

  it("records manual_required without a Wise call when the teacher userId cannot be resolved", async () => {
    process.env.WISE_SESSION_CREATE_VERIFIED = "true";
    resolveTeacherUserIdMock.mockResolvedValue(null);

    const result = await confirmProgressTestBooking({
      enrollmentKey: "class-1|student-1",
      scheduledTestStart: START,
      scheduledTestEnd: END,
      scheduleMethod: "parent_pick",
      db: bookingDb(),
    });

    expect(result.status).toBe("manual_required");
    expect(checkAvailabilityMock).not.toHaveBeenCalled();
    expect(scheduleWiseSessionMock).not.toHaveBeenCalled();
  });
});

describe("selectAtHomeOption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadCycleStateMock.mockResolvedValue(makeCycleStateRecord());
    insertBookingMock.mockImplementation(async (input) => ({ id: "booking-1", ...input }));
    upsertCycleStateMock.mockResolvedValue(undefined);
  });

  it("logs at-home selection and sets the cycle state scheduled with atHomeSelectedAt (no Wise booking)", async () => {
    const ok = await selectAtHomeOption({
      enrollmentKey: "class-1|student-1",
      actor: { email: "Admin@Example.com", name: "Admin" },
      db: bookingDb(),
    });

    expect(ok).toBe(true);
    expect(insertBookingMock).toHaveBeenCalledTimes(1);
    expect(insertBookingMock.mock.calls[0][0].requestPayload).toEqual({ mode: "at_home_selected" });
    const upserted = upsertCycleStateMock.mock.calls[0][0] as ProgressTestCycleStateInsert;
    expect(upserted.status).toBe("scheduled");
    expect(upserted.scheduleMethod).toBe("at_home");
    expect(upserted.atHomeSelectedAt).toBeInstanceOf(Date);
    expect(upserted.atHomeSubmittedAt).toBeNull();
    expect(upserted.bookedTestDate).toBeNull();
    expect(upserted.bookedTestWiseSessionId).toBeNull();
  });

  it("returns false when the enrollment has no cycle state", async () => {
    loadCycleStateMock.mockResolvedValue(null);
    const ok = await selectAtHomeOption({ enrollmentKey: "x|y", db: bookingDb() });
    expect(ok).toBe(false);
    expect(upsertCycleStateMock).not.toHaveBeenCalled();
  });
});

describe("markAtHomeSubmitted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadCycleStateMock.mockResolvedValue(
      makeCycleStateRecord({
        cycleIndex: 2,
        status: "scheduled",
        scheduleMethod: "at_home",
        atHomeSelectedAt: PROGRESS_TEST_COUNTING_START,
      }),
    );
    insertBookingMock.mockImplementation(async (input) => ({ id: "booking-1", ...input }));
    upsertCycleStateMock.mockResolvedValue(undefined);
  });

  it("records the submission and rolls the cycle (counts as the test done)", async () => {
    const ok = await markAtHomeSubmitted({ enrollmentKey: "class-1|student-1", db: bookingDb() });

    expect(ok).toBe(true);
    expect(insertBookingMock.mock.calls[0][0].requestPayload).toEqual({ mode: "at_home_submitted" });
    const upserted = upsertCycleStateMock.mock.calls[0][0] as ProgressTestCycleStateInsert;
    expect(upserted.cycleIndex).toBe(3);
    expect(upserted.currentCount).toBe(0);
    expect(upserted.status).toBe("accumulating");
    expect(upserted.scheduleMethod).toBeNull();
    expect(upserted.atHomeSelectedAt).toBeNull();
    expect(upserted.atHomeSubmittedAt).toBeNull();
  });
});
