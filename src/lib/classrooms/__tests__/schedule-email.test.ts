import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createResendScheduleEmailSender,
  getScheduleEmailPreview,
  sendScheduleEmailsForRun,
} from "../schedule-email";
import { REMOTE_NO_ROOM_NEEDED } from "../assignment-engine";

const run = {
  id: "run-1",
  assignmentDate: "2026-05-15",
  snapshotId: "snapshot-1",
  status: "completed",
  forceReassign: false,
  totalSessions: 2,
  assignedCount: 1,
  needsReviewCount: 0,
  noRoomCount: 0,
  remoteCount: 1,
  publishedCount: 0,
  failedPublishCount: 0,
  createdBy: null,
  createdAt: new Date("2026-05-14T00:00:00.000Z"),
  updatedAt: new Date("2026-05-14T00:00:00.000Z"),
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "row-1",
    groupId: overrides.groupId ?? "group-1",
    canonicalKey: overrides.canonicalKey ?? "Kevin",
    tutorDisplayName: overrides.tutorDisplayName ?? "Kevin",
    startTime: overrides.startTime ?? new Date("2026-05-15T09:00:00.000Z"),
    endTime: overrides.endTime ?? new Date("2026-05-15T10:00:00.000Z"),
    startMinute: overrides.startMinute ?? 16 * 60,
    endMinute: overrides.endMinute ?? 17 * 60,
    sessionType: overrides.sessionType ?? "OFFLINE",
    assignedRoom: overrides.assignedRoom ?? "Focus",
    status: overrides.status ?? "assigned",
    studentName: overrides.studentName ?? "Student One",
    subject: overrides.subject ?? "Math",
    classType: overrides.classType ?? "ONE_TO_ONE",
    title: overrides.title ?? "Math class",
  };
}

function makePreviewDb(input: {
  rows: ReturnType<typeof row>[];
  contacts: Array<Record<string, unknown>>;
}) {
  let selectCall = 0;
  const insertedRecipients: unknown[] = [];
  return {
    insertedRecipients,
    select: vi.fn(() => {
      const call = selectCall;
      selectCall += 1;
      if (call === 0) return { from: vi.fn().mockResolvedValue([]) };
      if (call === 1) return { from: vi.fn().mockResolvedValue([]) };
      if (call === 2) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([run]),
            })),
          })),
        };
      }
      if (call === 3) {
        return {
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn().mockResolvedValue(input.rows),
            })),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(input.contacts),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        if (value && typeof value === "object" && "recipientEmail" in value) {
          insertedRecipients.push(value);
        }
        return {
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        returning: vi.fn().mockResolvedValue([{ id: "email-run-1" }]),
      };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  };
}

describe("schedule email preview", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SCHEDULE_EMAIL_FROM", "BeGifted <schedule@example.com>");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("combines onsite and remote online rows for one tutor", async () => {
    const db = makePreviewDb({
      rows: [
        row({ id: "onsite", sessionType: "OFFLINE", assignedRoom: "Focus", status: "assigned" }),
        row({
          id: "remote",
          sessionType: "SCHEDULED",
          assignedRoom: REMOTE_NO_ROOM_NEEDED,
          status: "remote",
          startMinute: 18 * 60,
          endMinute: 19 * 60,
        }),
      ],
      contacts: [{
        canonicalKey: "Kevin",
        onsiteEmail: "kevhsh7@gmail.com",
        active: true,
      }],
    });

    const preview = await getScheduleEmailPreview(db as never, "run-1");

    expect(preview.ready).toBe(true);
    expect(preview.sendable).toBe(true);
    expect(preview.readyCount).toBe(1);
    expect(preview.blockedCount).toBe(0);
    expect(preview.recipients).toHaveLength(1);
    expect(preview.previews[0].blocks.map((block) => block.room)).toContain("Remote / no room needed");
  });

  it("formats schedule blocks from Bangkok minute columns", async () => {
    const db = makePreviewDb({
      rows: [
        row({
          startTime: new Date("2026-05-15T09:00:00.000Z"),
          endTime: new Date("2026-05-15T10:00:00.000Z"),
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        }),
      ],
      contacts: [{
        canonicalKey: "Kevin",
        onsiteEmail: "kevhsh7@gmail.com",
        active: true,
      }],
    });

    const preview = await getScheduleEmailPreview(db as never, "run-1");

    expect(preview.previews[0].blocks[0].time).toBe("09:00-10:00");
  });

  it("blocks sending when the non-online email is missing", async () => {
    const db = makePreviewDb({
      rows: [row({ canonicalKey: "Pearcha", tutorDisplayName: "Pearcha" })],
      contacts: [{ canonicalKey: "Pearcha", onsiteEmail: null, onlineEmail: "online@example.com", active: true }],
    });

    const preview = await getScheduleEmailPreview(db as never, "run-1");

    expect(preview.ready).toBe(false);
    expect(preview.sendable).toBe(false);
    expect(preview.blockers.map((blocker) => blocker.type)).toContain("missing_recipient_email");
  });

  it("is sendable when at least one tutor is ready and another tutor is blocked", async () => {
    const db = makePreviewDb({
      rows: [
        row({ id: "ready-row", groupId: "ready-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "blocked-row", groupId: "blocked-group", canonicalKey: "Pearcha", tutorDisplayName: "Pearcha" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Pearcha", onsiteEmail: null, onlineEmail: "online@example.com", active: true },
      ],
    });

    const preview = await getScheduleEmailPreview(db as never, "run-1");

    expect(preview.ready).toBe(false);
    expect(preview.sendable).toBe(true);
    expect(preview.readyCount).toBe(1);
    expect(preview.blockedCount).toBe(1);
  });

  it("sends ready tutors and skips blocked tutors", async () => {
    const db = makePreviewDb({
      rows: [
        row({ id: "ready-row", groupId: "ready-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "blocked-row", groupId: "blocked-group", canonicalKey: "Pearcha", tutorDisplayName: "Pearcha" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Pearcha", onsiteEmail: null, onlineEmail: "online@example.com", active: true },
      ],
    });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", sender);

    expect(sender.sendEmail).toHaveBeenCalledTimes(1);
    expect(result.summary).toEqual({ attempted: 1, success: 1, failed: 0, blocked: 1 });
    expect(result.recipients.map((recipient) => recipient.sendStatus).sort()).toEqual(["blocked", "sent"]);
  });
});

describe("Resend schedule email sender", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SCHEDULE_EMAIL_FROM", "BeGifted <schedule@example.com>");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts email payloads to the Resend API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ id: "email-1" }),
    } as Response);

    const result = await createResendScheduleEmailSender().sendEmail({
      to: "teacher@example.com",
      subject: "BeGifted schedule for 15/5/2026",
      html: "<p>Schedule</p>",
      text: "Schedule",
      idempotencyKey: "classroom-schedule:run-1:Kevin",
    });

    expect(result).toEqual({ id: "email-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer re_test",
          "Idempotency-Key": "classroom-schedule:run-1:Kevin",
        }),
      }),
    );
  });
});
