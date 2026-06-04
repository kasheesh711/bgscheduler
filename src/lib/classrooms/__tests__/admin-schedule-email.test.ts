import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../data", () => ({
  getClassroomAssignmentForDate: vi.fn(),
}));

import { getClassroomAssignmentForDate } from "../data";
import { sendAdminClassroomScheduleEmail } from "../admin-schedule-email";

const run = {
  id: "run-1",
  assignmentDate: "2026-05-26",
};

const row = {
  id: "row-1",
  tutorDisplayName: "Kevin",
  startMinute: 9 * 60,
  endMinute: 10 * 60,
  status: "assigned",
  assignedRoom: "Room A",
  studentName: "Student One",
  title: "Math class",
  subject: "Math",
  classType: "ONE_TO_ONE",
  publishStatus: "success",
  publishError: null,
  changeType: "carried",
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    run,
    rows: [row],
    rooms: [],
    snapshotMeta: { snapshotId: "snapshot-1", latestSyncFinishedAt: null, staleAgeMs: null, fresh: true },
    liveRoomBlocks: [],
    roomConflictWarnings: [],
    ...overrides,
  };
}

function makeDb(input: {
  existingEmailRuns?: Array<{ id: string }>;
  publishJobs?: unknown[] | null;
  teacherEmailRuns?: Array<{
    status: string;
    attemptedCount: number;
    successCount: number;
    failedCount: number;
    blockedCount: number;
    updatedAt: Date;
  }>;
  adminEmails?: string[];
}) {
  let selectCall = 0;
  const insertedEmailRuns: unknown[] = [];
  const insertedRecipients: unknown[] = [];
  const updates: unknown[] = [];
  return {
    insertedEmailRuns,
    insertedRecipients,
    updates,
    select: vi.fn(() => {
      const call = selectCall;
      selectCall += 1;
      if (call === 0) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue(input.existingEmailRuns ?? []),
            })),
          })),
        };
      }
      if (call === 1 && input.publishJobs !== null) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(input.publishJobs ?? []),
            })),
          })),
        };
      }
      if (call === 2 && input.publishJobs !== null) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(input.teacherEmailRuns ?? []),
            })),
          })),
        };
      }
      return {
        from: vi.fn().mockResolvedValue((input.adminEmails ?? ["admin@example.com"]).map((email) => ({ email }))),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        if (value && typeof value === "object" && "idempotencyKey" in value) {
          insertedEmailRuns.push(value);
          return { returning: vi.fn().mockResolvedValue([{ id: "email-run-1", ...(value as object) }]) };
        }
        insertedRecipients.push(value);
        return { returning: vi.fn().mockResolvedValue([]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: unknown) => {
        updates.push(value);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  };
}

describe("sendAdminClassroomScheduleEmail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getClassroomAssignmentForDate).mockResolvedValue(detail() as never);
  });

  it("sends the current-day schedule to all admin users", async () => {
    const db = makeDb({ publishJobs: [], adminEmails: ["Admin@Example.com", "ops@example.com"] });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "msg-1" }) };

    const result = await sendAdminClassroomScheduleEmail(db as never, {
      assignmentDate: "2026-05-26",
      now: new Date("2026-05-26T00:00:00.000Z"),
      sender,
    });

    expect(result.status).toBe("sent");
    expect(getClassroomAssignmentForDate).toHaveBeenCalledWith(db, "2026-05-26");
    expect(sender.sendEmail).toHaveBeenCalledTimes(2);
    expect(sender.sendEmail.mock.calls[0][0].text).toContain("BeGifted classroom assignments - 2026-05-26");
    expect(sender.sendEmail.mock.calls[0][0].text).toContain("Tutor schedule emails: not sent yet.");
    expect(sender.sendEmail.mock.calls[0][0].text).toContain("Kevin");
  });

  it("includes teacher schedule email counts in the admin summary", async () => {
    const db = makeDb({
      publishJobs: [],
      teacherEmailRuns: [
        {
          status: "sent",
          attemptedCount: 2,
          successCount: 2,
          failedCount: 0,
          blockedCount: 1,
          updatedAt: new Date("2026-05-26T00:05:00.000Z"),
        },
        {
          status: "partial",
          attemptedCount: 1,
          successCount: 0,
          failedCount: 1,
          blockedCount: 0,
          updatedAt: new Date("2026-05-26T00:01:00.000Z"),
        },
      ],
      adminEmails: ["admin@example.com"],
    });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "msg-1" }) };

    const result = await sendAdminClassroomScheduleEmail(db as never, {
      assignmentDate: "2026-05-26",
      now: new Date("2026-05-26T00:00:00.000Z"),
      sender,
    });

    expect(result.status).toBe("sent");
    expect(sender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Tutor schedule emails: 2 sent; 1 failed; 1 blocked; 3 attempted; 2 run(s); latest status sent"),
      html: expect.stringContaining("Tutor schedule emails: <strong>2</strong> sent; <strong>1</strong> failed; <strong>1</strong> blocked; 3 attempted across 2 run(s). Latest status: sent."),
    }));
  });

  it("waits during the retry window when no current-day run exists", async () => {
    vi.mocked(getClassroomAssignmentForDate).mockResolvedValue(detail({ run: null, rows: [] }) as never);
    const db = makeDb({ publishJobs: null });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "msg-1" }) };

    const result = await sendAdminClassroomScheduleEmail(db as never, {
      assignmentDate: "2026-05-26",
      now: new Date("2026-05-26T00:10:00.000Z"),
      sender,
    });

    expect(result.status).toBe("pending");
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(db.insertedEmailRuns).toHaveLength(0);
  });

  it("sends one failure summary at the final retry when still blocked", async () => {
    vi.mocked(getClassroomAssignmentForDate).mockResolvedValue(detail({ run: null, rows: [] }) as never);
    const db = makeDb({ publishJobs: null, adminEmails: ["admin@example.com"] });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "msg-1" }) };

    const result = await sendAdminClassroomScheduleEmail(db as never, {
      assignmentDate: "2026-05-26",
      now: new Date("2026-05-26T00:30:00.000Z"),
      sender,
    });

    expect(result.status).toBe("sent");
    expect(db.insertedEmailRuns[0]).toEqual(expect.objectContaining({ triggerKind: "failure" }));
    expect(sender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining("ACTION REQUIRED"),
      text: expect.stringContaining("No classroom assignment run exists"),
    }));
  });

  it("does not send duplicates after an email run exists for the date", async () => {
    const db = makeDb({ existingEmailRuns: [{ id: "email-run-1" }] });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "msg-1" }) };

    const result = await sendAdminClassroomScheduleEmail(db as never, {
      assignmentDate: "2026-05-26",
      sender,
    });

    expect(result.status).toBe("skipped");
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });
});
