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
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_URL", "https://script.google.com/macros/s/test/exec");
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_SECRET", "secret-test");
    vi.stubEnv("SCHEDULE_EMAIL_PUBLIC_BASE_URL", "https://bgscheduler.test");
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
    expect(preview.previews[0].mapImageUrl).toBe("https://bgscheduler.test/api/classrooms/floor-plan-map?rooms=Focus");
  });

  it("renders email times from Bangkok-local assignment minutes", async () => {
    const db = makePreviewDb({
      rows: [
        row({
          startTime: new Date("2026-05-15T16:00:00.000Z"),
          endTime: new Date("2026-05-15T17:30:00.000Z"),
          startMinute: 16 * 60,
          endMinute: 17 * 60 + 30,
        }),
      ],
      contacts: [{
        canonicalKey: "Kevin",
        onsiteEmail: "kevhsh7@gmail.com",
        active: true,
      }],
    });

    const preview = await getScheduleEmailPreview(db as never, "run-1");

    expect(preview.previews[0].blocks[0].time).toBe("16:00-17:30");
    expect(preview.previews[0].text).toContain("16:00-17:30 | Student One");
    expect(preview.previews[0].html).toContain("16:00-17:30");
  });

  it("includes a numbered room route and map image in each email preview", async () => {
    const db = makePreviewDb({
      rows: [
        row({ id: "row-1", assignedRoom: "Focus", startMinute: 15 * 60, endMinute: 16 * 60 }),
        row({ id: "row-2", assignedRoom: "Joy", startMinute: 17 * 60, endMinute: 18 * 60 }),
      ],
      contacts: [{
        canonicalKey: "Kevin",
        onsiteEmail: "kevhsh7@gmail.com",
        active: true,
      }],
    });

    const preview = await getScheduleEmailPreview(db as never, "run-1");
    const email = preview.previews[0];

    expect(email.roomSteps).toEqual([
      { order: 1, time: "15:00-16:00", room: "Focus" },
      { order: 2, time: "17:00-18:00", room: "Joy" },
    ]);
    expect(email.mapImageUrl).toBe("https://bgscheduler.test/api/classrooms/floor-plan-map?rooms=Focus%7CJoy");
    expect(email.text).toContain("1. 15:00-16:00 - Focus");
    expect(email.text).toContain("2. 17:00-18:00 - Joy");
    expect(email.html).toContain("Teaching schedule");
    expect(email.html).toContain("School map");
    expect(email.html).toContain("https://bgscheduler.test/api/classrooms/floor-plan-map?rooms=Focus%7CJoy");
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

  it("blocks sending when Apps Script config is missing", async () => {
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_URL", "");
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_SECRET", "");
    const db = makePreviewDb({
      rows: [row()],
      contacts: [{ canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true }],
    });

    const preview = await getScheduleEmailPreview(db as never, "run-1");

    expect(preview.ready).toBe(false);
    expect(preview.sendable).toBe(false);
    expect(preview.hardBlockers.map((blocker) => blocker.message)).toEqual([
      "SCHEDULE_EMAIL_APPS_SCRIPT_URL is not configured.",
      "SCHEDULE_EMAIL_APPS_SCRIPT_SECRET is not configured.",
    ]);
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

  it("sends only selected tutor groups when recipient group ids are provided", async () => {
    const db = makePreviewDb({
      rows: [
        row({ id: "row-1", groupId: "group-1", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "row-2", groupId: "group-2", canonicalKey: "Samantha", tutorDisplayName: "Samantha" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Samantha", onsiteEmail: "sam@example.com", active: true },
      ],
    });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "email-2" }) };

    const result = await sendScheduleEmailsForRun(
      db as never,
      "run-1",
      "admin@example.com",
      sender,
      { recipientGroupIds: ["group-2"] },
    );

    expect(sender.sendEmail).toHaveBeenCalledTimes(1);
    expect(sender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "sam@example.com",
      idempotencyKey: "classroom-schedule:email-run-1:Samantha",
    }));
    expect(result.summary).toEqual({ attempted: 1, success: 1, failed: 0, blocked: 0 });
    expect(result.recipients.map((recipient) => recipient.tutorDisplayName)).toEqual(["Samantha"]);
  });

  it("does not send any emails when the selected tutor list is empty", async () => {
    const db = makePreviewDb({
      rows: [row()],
      contacts: [{ canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true }],
    });
    const sender = { sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) };

    const result = await sendScheduleEmailsForRun(
      db as never,
      "run-1",
      "admin@example.com",
      sender,
      { recipientGroupIds: [] },
    );

    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(result.summary).toEqual({ attempted: 0, success: 0, failed: 0, blocked: 0 });
    expect(result.recipients).toEqual([]);
  });

  it("records an Apps Script failure as a failed recipient", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "Apps Script quota exhausted" }),
    } as Response);
    const db = makePreviewDb({
      rows: [row()],
      contacts: [{ canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true }],
    });

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.summary).toEqual({ attempted: 1, success: 0, failed: 1, blocked: 0 });
    expect(result.recipients[0]).toMatchObject({
      sendStatus: "failed",
      error: "Apps Script quota exhausted",
    });
  });

  it("keeps sending other ready tutors when one Apps Script request fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Network failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, id: "apps-script-email-2", remainingQuota: 98 }),
      } as Response);
    const db = makePreviewDb({
      rows: [
        row({ id: "row-1", groupId: "group-1", canonicalKey: "Kevin", tutorDisplayName: "Kevin" }),
        row({ id: "row-2", groupId: "group-2", canonicalKey: "Samantha", tutorDisplayName: "Samantha" }),
      ],
      contacts: [
        { canonicalKey: "Kevin", onsiteEmail: "kevhsh7@gmail.com", active: true },
        { canonicalKey: "Samantha", onsiteEmail: "sam@example.com", active: true },
      ],
    });

    const result = await sendScheduleEmailsForRun(db as never, "run-1", "admin@example.com");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.summary).toEqual({ attempted: 2, success: 1, failed: 1, blocked: 0 });
    expect(result.recipients.map((recipient) => recipient.sendStatus).sort()).toEqual(["failed", "sent"]);
  });
});

describe("Apps Script schedule email sender", () => {
  beforeEach(() => {
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_URL", "https://script.google.com/macros/s/test/exec");
    vi.stubEnv("SCHEDULE_EMAIL_APPS_SCRIPT_SECRET", "secret-test");
    vi.stubEnv("SCHEDULE_EMAIL_SENDER_NAME", "BeGifted");
    vi.stubEnv("SCHEDULE_EMAIL_REPLY_TO", "kevhsh7@gmail.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts email payloads to Apps Script", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, id: "apps-script-email-1", remainingQuota: 99 }),
    } as Response);

    const result = await createAppsScriptScheduleEmailSender().sendEmail({
      to: "teacher@example.com",
      subject: "BeGifted schedule for 15/5/2026",
      html: "<p>Schedule</p>",
      text: "Schedule",
      idempotencyKey: "classroom-schedule:run-1:Kevin",
    });

    expect(result).toEqual({ id: "apps-script-email-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://script.google.com/macros/s/test/exec");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toMatchObject({
      secret: "secret-test",
      to: "teacher@example.com",
      subject: "BeGifted schedule for 15/5/2026",
      html: "<p>Schedule</p>",
      text: "Schedule",
      senderName: "BeGifted",
      replyTo: "kevhsh7@gmail.com",
      idempotencyKey: "classroom-schedule:run-1:Kevin",
    });
  });
});
