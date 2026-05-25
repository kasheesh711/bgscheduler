import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppsScriptScheduleEmailSender,
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
  sentGroupIds?: string[];
}) {
  let selectCall = 0;
  const insertedRecipients: unknown[] = [];
  const insertedEmailRuns: unknown[] = [];
  const updatedEmailRuns: unknown[] = [];
  return {
    insertedRecipients,
    insertedEmailRuns,
    updatedEmailRuns,
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
      if (call === 4) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(input.contacts),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue((input.sentGroupIds ?? []).map((groupId) => ({ groupId }))),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        if (value && typeof value === "object" && "recipientEmail" in value) {
          insertedRecipients.push(value);
        }
        let emailRunId = "email-run-1";
        if (value && typeof value === "object" && "assignmentRunId" in value && "subject" in value) {
          insertedEmailRuns.push(value);
          emailRunId = `email-run-${insertedEmailRuns.length}`;
        }
        return {
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          returning: vi.fn().mockResolvedValue([{ id: emailRunId }]),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: unknown) => {
        updatedEmailRuns.push(value);
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    })),
  };
}

describe("schedule email preview", () => {
  beforeEach(() => {
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_URL", "https://script.google.com/macros/s/test/exec");
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_SECRET", "secret-1");
    vi.stubEnv("SCHEDULE_EMAIL_PUBLIC_BASE_URL", "https://schedule.example.com");
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
    expect(preview.previews[0].roomSteps).toEqual([
      { order: 1, time: "16:00-17:00", room: "Focus" },
    ]);
    expect(preview.previews[0].mapImageUrl).toBe("https://schedule.example.com/api/classrooms/floor-plan-map?rooms=Focus&v=2026-05-18-corridor");
    expect(preview.previews[0].html).toContain("School map");
    expect(preview.previews[0].html).toContain("https://schedule.example.com/api/classrooms/floor-plan-map?rooms=Focus&amp;v=2026-05-18-corridor");
    expect(preview.previews[0].text).toContain("Room route:");
    expect(preview.previews[0].text).toContain("Map: https://schedule.example.com/api/classrooms/floor-plan-map?rooms=Focus&v=2026-05-18-corridor");
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

  it("blocks on missing Apps Script config without requiring Resend config", async () => {
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_URL", "");
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_SECRET", "");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("SCHEDULE_EMAIL_FROM", "");
    const db = makePreviewDb({
      rows: [row()],
      contacts: [{
        canonicalKey: "Kevin",
        onsiteEmail: "kevhsh7@gmail.com",
        active: true,
      }],
    });

    const preview = await getScheduleEmailPreview(db as never, "run-1");

    const messages = preview.hardBlockers.map((blocker) => blocker.message);
    expect(messages).toEqual([
      "SCHEDULE_EMAIL_APPS_SCRIPT_URL is not configured.",
      "SCHEDULE_EMAIL_APPS_SCRIPT_SECRET is not configured.",
    ]);
    expect(messages.join(" ")).not.toContain("RESEND_API_KEY");
    expect(messages.join(" ")).not.toContain("SCHEDULE_EMAIL_FROM");
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

  it("sends only selected ready tutors", async () => {
    const db = makePreviewDb({
      rows: [
        row({ id: "kevin-row", groupId: "kevin-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "sam-row", groupId: "sam-group", canonicalKey: "Samantha", tutorDisplayName: "Samantha" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Samantha", onsiteEmail: "sam@example.com", active: true },
      ],
    });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", sender, {
      recipientGroupIds: ["sam-group"],
    });

    expect(sender.sendEmail).toHaveBeenCalledTimes(1);
    expect(sender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "sam@example.com",
      idempotencyKey: expect.stringMatching(/^classroom-schedule:run-1:Samantha:[a-f0-9]{16}$/),
    }));
    expect(result.summary).toEqual({ attempted: 1, success: 1, failed: 0, blocked: 0 });
    expect(result.recipients.map((recipient) => recipient.tutorDisplayName)).toEqual(["Samantha"]);
  });

  it("failed-only retry sends ready tutors without sent records and skips blocked tutors", async () => {
    const db = makePreviewDb({
      rows: [
        row({ id: "sent-row", groupId: "sent-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "failed-row", groupId: "failed-group", canonicalKey: "Nithit", tutorDisplayName: "Nithit" }),
        row({ id: "sand-ready", groupId: "sand-group", canonicalKey: "Sand", tutorDisplayName: "Sand" }),
        row({ id: "sand-no-room", groupId: "sand-group", canonicalKey: "Sand", tutorDisplayName: "Sand", status: "no_room" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Nithit", onsiteEmail: "nsinghsachthep@gmail.com", active: true },
        { canonicalKey: "Sand", onsiteEmail: "m.supatin@gmail.com", active: true },
      ],
      sentGroupIds: ["sent-group"],
    });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", sender, {
      mode: "failed_only",
    });

    expect(sender.sendEmail).toHaveBeenCalledTimes(1);
    expect(sender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "nsinghsachthep@gmail.com",
    }));
    expect(result.summary).toEqual({ attempted: 1, success: 1, failed: 0, blocked: 0 });
    expect(result.recipients.map((recipient) => recipient.tutorDisplayName)).toEqual(["Nithit"]);
  });

  it("automatically fails over remaining unsent ready tutors when primary quota is exhausted", async () => {
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL", "https://script.google.com/macros/s/backup/exec");
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET", "backup-secret");
    const db = makePreviewDb({
      rows: [
        row({ id: "kevin-row", groupId: "kevin-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "nithit-row", groupId: "nithit-group", canonicalKey: "Nithit", tutorDisplayName: "Nithit" }),
        row({ id: "pat-row", groupId: "pat-group", canonicalKey: "Pat", tutorDisplayName: "Pat" }),
        row({ id: "sand-ready", groupId: "sand-group", canonicalKey: "Sand", tutorDisplayName: "Sand" }),
        row({ id: "sand-no-room", groupId: "sand-group", canonicalKey: "Sand", tutorDisplayName: "Sand", status: "no_room" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Nithit", onsiteEmail: "nsinghsachthep@gmail.com", active: true },
        { canonicalKey: "Pat", onsiteEmail: "noiandpat@gmail.com", active: true },
        { canonicalKey: "Sand", onsiteEmail: "m.supatin@gmail.com", active: true },
      ],
    });
    const primarySender = {
      sendEmail: vi.fn(async (input) => {
        if (input.to === "kevhsh7@gmail.com") return { id: "primary-kevin" };
        throw new Error("MailApp daily recipient quota is exhausted");
      }),
    };
    const backupSender = {
      sendEmail: vi.fn(async (input) => ({ id: `backup-${input.to}` })),
    };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", primarySender, {
      backupSender,
    });

    expect(primarySender.sendEmail).toHaveBeenCalledTimes(2);
    expect(backupSender.sendEmail).toHaveBeenCalledTimes(2);
    expect(backupSender.sendEmail.mock.calls.map(([input]) => input.to)).toEqual([
      "nsinghsachthep@gmail.com",
      "noiandpat@gmail.com",
    ]);
    expect(result.summary).toEqual({ attempted: 3, success: 3, failed: 0, blocked: 1 });
    expect(result.failover).toEqual(expect.objectContaining({
      triggered: true,
      fromEmailRunId: "email-run-1",
      toEmailRunId: "email-run-2",
      reason: "MailApp daily recipient quota is exhausted",
      attempted: 2,
      sent: 2,
      failed: 0,
    }));
    const recipientsByName = new Map(result.recipients.map((recipient) => [recipient.tutorDisplayName, recipient]));
    expect(recipientsByName.get("Kevin")).toEqual(expect.objectContaining({
      sendStatus: "sent",
      senderKey: "primary",
      emailRunId: "email-run-1",
    }));
    expect(recipientsByName.get("Nithit")).toEqual(expect.objectContaining({
      sendStatus: "sent",
      senderKey: "backup",
      emailRunId: "email-run-2",
    }));
    expect(recipientsByName.get("Pat")).toEqual(expect.objectContaining({
      sendStatus: "sent",
      senderKey: "backup",
      emailRunId: "email-run-2",
    }));
    expect(recipientsByName.get("Sand")).toEqual(expect.objectContaining({
      sendStatus: "blocked",
      senderKey: "primary",
    }));
    expect(db.insertedEmailRuns).toHaveLength(2);
    expect(db.updatedEmailRuns[0]).toEqual(expect.objectContaining({
      status: "partial",
      attemptedCount: 2,
      successCount: 1,
      failedCount: 1,
      blockedCount: 1,
    }));
    expect(db.updatedEmailRuns[1]).toEqual(expect.objectContaining({
      status: "sent",
      attemptedCount: 2,
      successCount: 2,
      failedCount: 0,
      blockedCount: 0,
    }));
  });

  it("excludes already-sent tutors from automatic failover", async () => {
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL", "https://script.google.com/macros/s/backup/exec");
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET", "backup-secret");
    const db = makePreviewDb({
      rows: [
        row({ id: "kevin-row", groupId: "kevin-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "nithit-row", groupId: "nithit-group", canonicalKey: "Nithit", tutorDisplayName: "Nithit" }),
        row({ id: "pat-row", groupId: "pat-group", canonicalKey: "Pat", tutorDisplayName: "Pat" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Nithit", onsiteEmail: "nsinghsachthep@gmail.com", active: true },
        { canonicalKey: "Pat", onsiteEmail: "noiandpat@gmail.com", active: true },
      ],
      sentGroupIds: ["pat-group"],
    });
    const primarySender = {
      sendEmail: vi.fn(async (input) => {
        if (input.to === "kevhsh7@gmail.com") return { id: "primary-kevin" };
        throw new Error("MailApp daily recipient quota is exhausted");
      }),
    };
    const backupSender = { sendEmail: vi.fn().mockResolvedValue({ id: "backup-nithit" }) };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", primarySender, {
      backupSender,
    });

    expect(backupSender.sendEmail).toHaveBeenCalledTimes(1);
    expect(backupSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "nsinghsachthep@gmail.com",
    }));
    expect(result.summary).toEqual({ attempted: 2, success: 2, failed: 0, blocked: 1 });
    expect(result.recipients.find((recipient) => recipient.tutorDisplayName === "Pat")).toEqual(expect.objectContaining({
      sendStatus: "blocked",
      senderKey: "backup",
      error: "Recipient already has a sent schedule email for this assignment run.",
    }));
  });

  it("does not fail over non-quota primary send errors", async () => {
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL", "https://script.google.com/macros/s/backup/exec");
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET", "backup-secret");
    const db = makePreviewDb({
      rows: [
        row({ id: "kevin-row", groupId: "kevin-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "nithit-row", groupId: "nithit-group", canonicalKey: "Nithit", tutorDisplayName: "Nithit" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Nithit", onsiteEmail: "nsinghsachthep@gmail.com", active: true },
      ],
    });
    const primarySender = { sendEmail: vi.fn().mockRejectedValue(new Error("Unauthorized")) };
    const backupSender = { sendEmail: vi.fn().mockResolvedValue({ id: "backup-email" }) };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", primarySender, {
      backupSender,
    });

    expect(primarySender.sendEmail).toHaveBeenCalledTimes(2);
    expect(backupSender.sendEmail).not.toHaveBeenCalled();
    expect(result.failover).toBeUndefined();
    expect(result.summary).toEqual({ attempted: 2, success: 0, failed: 2, blocked: 0 });
  });

  it("does not recurse when an explicit backup send exhausts quota", async () => {
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL", "https://script.google.com/macros/s/backup/exec");
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET", "backup-secret");
    const db = makePreviewDb({
      rows: [
        row({ id: "kevin-row", groupId: "kevin-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "nithit-row", groupId: "nithit-group", canonicalKey: "Nithit", tutorDisplayName: "Nithit" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Nithit", onsiteEmail: "nsinghsachthep@gmail.com", active: true },
      ],
    });
    const backupSender = {
      sendEmail: vi.fn().mockRejectedValue(new Error("MailApp daily recipient quota is exhausted")),
    };
    const unusedSender = { sendEmail: vi.fn().mockResolvedValue({ id: "unused" }) };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", backupSender, {
      senderKey: "backup",
      backupSender: unusedSender,
    });

    expect(backupSender.sendEmail).toHaveBeenCalledTimes(1);
    expect(unusedSender.sendEmail).not.toHaveBeenCalled();
    expect(result.failover).toBeUndefined();
    expect(result.summary).toEqual({ attempted: 2, success: 0, failed: 2, blocked: 0 });
  });

  it("does not fail over failed-only retries", async () => {
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL", "https://script.google.com/macros/s/backup/exec");
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET", "backup-secret");
    const db = makePreviewDb({
      rows: [
        row({ id: "kevin-row", groupId: "kevin-group", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "nithit-row", groupId: "nithit-group", canonicalKey: "Nithit", tutorDisplayName: "Nithit" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Nithit", onsiteEmail: "nsinghsachthep@gmail.com", active: true },
      ],
    });
    const primarySender = {
      sendEmail: vi.fn().mockRejectedValue(new Error("MailApp daily recipient quota is exhausted")),
    };
    const backupSender = { sendEmail: vi.fn().mockResolvedValue({ id: "backup-email" }) };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", primarySender, {
      mode: "failed_only",
      backupSender,
    });

    expect(primarySender.sendEmail).toHaveBeenCalledTimes(1);
    expect(backupSender.sendEmail).not.toHaveBeenCalled();
    expect(result.failover).toBeUndefined();
    expect(result.summary).toEqual({ attempted: 2, success: 0, failed: 2, blocked: 0 });
    expect(db.updatedEmailRuns.at(-1)).toEqual(expect.objectContaining({
      status: "failed",
      attemptedCount: 2,
      failedCount: 2,
    }));
  });

  it("sends nothing and records no recipients for an empty selected list", async () => {
    const db = makePreviewDb({
      rows: [row()],
      contacts: [{
        canonicalKey: "Kevin",
        onsiteEmail: "kevhsh7@gmail.com",
        active: true,
      }],
    });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) };

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com", sender, {
      recipientGroupIds: [],
    });

    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(result.summary).toEqual({ attempted: 0, success: 0, failed: 0, blocked: 0 });
    expect(result.recipients).toEqual([]);
    expect(db.insertedRecipients).toEqual([]);
  });
});

describe("Apps Script schedule email sender", () => {
  beforeEach(() => {
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_URL", "https://script.google.com/macros/s/test/exec");
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_SECRET", "secret-1");
    vi.stubEnv("SCHEDULE_EMAIL_SENDER_NAME", "BeGifted Team");
    vi.stubEnv("SCHEDULE_EMAIL_REPLY_TO", "reply@example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts email payloads to the Apps Script relay", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, id: "apps-script-email-1" }),
    } as Response);

    const result = await createAppsScriptScheduleEmailSender().sendEmail({
      to: "teacher@example.com",
      subject: "BeGifted schedule for 15/5/2026",
      html: "<p>Schedule</p>",
      text: "Schedule",
      idempotencyKey: "classroom-schedule:run-1:Kevin",
    });

    expect(result).toEqual({ id: "apps-script-email-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://script.google.com/macros/s/test/exec",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      secret: "secret-1",
      to: "teacher@example.com",
      subject: "BeGifted schedule for 15/5/2026",
      html: "<p>Schedule</p>",
      text: "Schedule",
      senderName: "BeGifted Team",
      replyTo: "reply@example.com",
      idempotencyKey: "classroom-schedule:run-1:Kevin",
    });
  });

  it("posts backup email payloads to the backup Apps Script relay", async () => {
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL", "https://script.google.com/macros/s/backup/exec");
    vi.stubEnv("SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET", "backup-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, id: "apps-script-email-1" }),
    } as Response);

    await createAppsScriptScheduleEmailSender("backup").sendEmail({
      to: "teacher@example.com",
      subject: "BeGifted schedule for 15/5/2026",
      html: "<p>Schedule</p>",
      text: "Schedule",
      idempotencyKey: "classroom-schedule:run-1:Kevin:abc123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://script.google.com/macros/s/backup/exec",
      expect.any(Object),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.secret).toBe("backup-secret");
  });

  it("throws Apps Script relay errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "Bad secret" }),
    } as Response);

    await expect(createAppsScriptScheduleEmailSender().sendEmail({
      to: "teacher@example.com",
      subject: "Subject",
      html: "<p>Schedule</p>",
      text: "Schedule",
      idempotencyKey: "classroom-schedule:run-1:Kevin",
    })).rejects.toThrow("Bad secret");
  });
});
