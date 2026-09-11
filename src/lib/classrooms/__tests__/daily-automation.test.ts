import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../morning-automation", () => ({ runClassroomMorningAutomation: vi.fn() }));
vi.mock("../data", () => ({ getClassroomAssignmentForDate: vi.fn() }));
vi.mock("../schedule-email", () => ({ sendScheduleEmailsForRun: vi.fn() }));
vi.mock("../admin-schedule-email", () => ({ sendAdminClassroomScheduleEmail: vi.fn() }));
import { runClassroomMorningAutomation } from "../morning-automation";
import { getClassroomAssignmentForDate } from "../data";
import { sendScheduleEmailsForRun } from "../schedule-email";
import { sendAdminClassroomScheduleEmail } from "../admin-schedule-email";
import { prepareNextDayClassrooms, deliverNextDayClassroomSchedules } from "../daily-automation";

const db = {} as never;
const now = new Date("2026-12-31T12:00:00Z");
describe("next-day classroom automation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getClassroomAssignmentForDate).mockResolvedValue({ run: { id: "tomorrow", createdAt: new Date("2026-12-31T10:05:00Z") } } as never);
    vi.mocked(sendScheduleEmailsForRun).mockResolvedValue({ summary: { attempted: 2, success: 2, failed: 0, blocked: 0 } } as never);
    vi.mocked(sendAdminClassroomScheduleEmail).mockResolvedValue({ status: "sent" } as never);
  });
  it("prepares tomorrow at 17:00 without sending schedules, including year rollover", async () => {
    await prepareNextDayClassrooms(db, new Date("2026-12-31T10:00:00Z"));
    expect(runClassroomMorningAutomation).toHaveBeenCalledWith(db, { startDate: "2027-01-01", sendEmails: false, maxSyncWaitMs: 600_000 });
    expect(sendScheduleEmailsForRun).not.toHaveBeenCalled();
  });
  it("sends only tomorrow's saved plan at 19:00, then the admin summary", async () => {
    expect((await deliverNextDayClassroomSchedules(db, now)).ok).toBe(true);
    expect(getClassroomAssignmentForDate).toHaveBeenCalledWith(db, "2027-01-01");
    expect(sendScheduleEmailsForRun).toHaveBeenCalledWith(db, "tomorrow", "cron@classroom-schedule-email", undefined, { mode: "failed_only" });
    expect(sendAdminClassroomScheduleEmail).toHaveBeenCalledWith(db, expect.objectContaining({ assignmentDate: "2027-01-01", now }));
    expect(vi.mocked(sendScheduleEmailsForRun).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sendAdminClassroomScheduleEmail).mock.invocationCallOrder[0]);
    expect(runClassroomMorningAutomation).not.toHaveBeenCalled();
  });
  it("does not deliver a previous day's provisional plan when preparation was missed", async () => {
    vi.mocked(getClassroomAssignmentForDate).mockResolvedValue({ run: { id: "old", createdAt: new Date("2026-12-30T10:05:00Z") } } as never);
    expect((await deliverNextDayClassroomSchedules(db, now)).ok).toBe(false);
    expect(sendScheduleEmailsForRun).not.toHaveBeenCalled();
    expect(sendAdminClassroomScheduleEmail).toHaveBeenCalledWith(db, expect.objectContaining({ additionalBlockers: [expect.stringContaining("17:00")] }));
  });
  it("still alerts admins after a tutor-email error and reports failure", async () => {
    vi.mocked(sendScheduleEmailsForRun).mockRejectedValue(new Error("Relay unavailable"));
    expect(await deliverNextDayClassroomSchedules(db, now)).toMatchObject({ ok: false, errorSummary: "Relay unavailable" });
    expect(sendAdminClassroomScheduleEmail).toHaveBeenCalledTimes(1);
  });
  it("reports blocked tutors even if the admin summary succeeded", async () => {
    vi.mocked(sendScheduleEmailsForRun).mockResolvedValue({ summary: { attempted: 1, success: 1, failed: 0, blocked: 1 } } as never);
    expect((await deliverNextDayClassroomSchedules(db, now)).ok).toBe(false);
  });
});
