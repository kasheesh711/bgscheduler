import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/calendar", () => ({
  getUpcomingDeadlines: vi.fn(async () => []),
  UPCOMING_DEADLINES_MAX_LIMIT: 100,
}));
vi.mock("@/lib/admissions/announcements", () => ({
  listAnnouncementsForCase: vi.fn(async () => []),
}));

import {
  admissionsCaseMembers,
  admissionsCases,
  admissionsCaseTasks,
  admissionsNotificationLog,
  admissionsNotificationRuns,
  admissionsSelfReportSections,
} from "@/lib/db/schema";
import { getUpcomingDeadlines } from "@/lib/admissions/calendar";
import { listAnnouncementsForCase } from "@/lib/admissions/announcements";
import {
  ADMISSIONS_SIGN_IN_URL,
  INTERRUPT_DAILY_CAP,
  buildDeadlineReminders,
  buildWeeklyDigest,
  deriveStudentFirstName,
  runDailyNotifications,
  runWeeklyDigest,
  sendAdmissionsEmail,
  sendMemberInviteForCase,
} from "@/lib/admissions/notifications";
import type { AdmissionsMemberDto } from "@/lib/admissions/types";
import type { Database } from "@/lib/db";

const CASE_ID = "22222222-2222-4222-8222-222222222222";

// 2026-07-01 12:00 Asia/Bangkok → today 2026-07-01, T-7d 2026-07-08, T-48h 2026-07-03.
const NOW = new Date("2026-07-01T05:00:00Z");
const TODAY_KEY = "2026-07-01";
const D7_KEY = "2026-07-08";
const D2_KEY = "2026-07-03";

const getUpcomingDeadlinesMock = vi.mocked(getUpcomingDeadlines);
const listAnnouncementsMock = vi.mocked(listAnnouncementsForCase);

type Row = Record<string, unknown>;

interface SelectBehavior {
  /** Rows resolved when the builder is awaited straight after .where(). */
  where?: Row[];
  /** Rows resolved when .limit() is called after .where(). */
  limit?: Row[];
}

interface MockDbOptions {
  selects?: Map<unknown, SelectBehavior>;
  insertError?: (table: unknown) => Error | null;
}

/** Chainable mock db covering the select/insert/update shapes notifications.ts uses. */
function makeDb(options: MockDbOptions = {}) {
  const inserts: Array<{ table: unknown; values: Row }> = [];
  const updates: Array<{ table: unknown; set: Row }> = [];
  let idCounter = 0;

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const behavior = options.selects?.get(table) ?? {};
        const afterWhere = {
          then: (
            onFulfilled?: (rows: Row[]) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) => Promise.resolve(behavior.where ?? []).then(onFulfilled, onRejected),
          limit: async () => behavior.limit ?? [],
        };
        return {
          where: () => afterWhere,
          innerJoin: () => ({ where: () => afterWhere }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => ({
        returning: async () => {
          const error = options.insertError?.(table) ?? null;
          if (error) throw error;
          inserts.push({ table, values });
          return [{ id: `id-${++idCounter}`, ...values }];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Row) => ({
        where: async () => {
          updates.push({ table, set });
        },
      }),
    }),
  } as unknown as Database;

  return { db, inserts, updates };
}

function memberRow(overrides: Row): Row {
  return {
    id: "member-1",
    caseId: CASE_ID,
    email: "student@example.com",
    role: "student",
    status: "active",
    notificationPrefs: null,
    ...overrides,
  };
}

function calendarItem(overrides: Row) {
  return {
    id: "item-1",
    caseId: CASE_ID,
    source: "task" as const,
    title: "Finish essay draft",
    date: D7_KEY,
    overdue: false,
    ownerRole: "student" as const,
    ...overrides,
  } as never;
}

function fetchBody(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = mock.mock.calls[callIndex][1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: "re_123" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESEND_API_KEY", "test-api-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("sendAdmissionsEmail", () => {
  const input = {
    to: "Student@Example.com",
    subject: "Test subject",
    html: "<p>Hello</p>",
    category: "direct_message" as const,
    tier: "interrupt" as const,
    caseId: CASE_ID,
  };

  it("skips an already-logged dedupe key without sending or logging", async () => {
    const { db, inserts } = makeDb({
      selects: new Map([[admissionsNotificationLog, { limit: [{ id: "existing" }] }]]),
    });

    const result = await sendAdmissionsEmail({ ...input, dedupeKey: "item-1:7d:x" }, db);

    expect(result).toEqual({ skipped: true, resendEmailId: null, logId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("sends via Resend and records the log row with the resendEmailId", async () => {
    const { db, inserts } = makeDb({
      selects: new Map([[admissionsNotificationLog, { limit: [] }]]),
    });

    const result = await sendAdmissionsEmail({ ...input, dedupeKey: "key-1" }, db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer test-api-key");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe(admissionsNotificationLog);
    expect(inserts[0].values).toEqual(expect.objectContaining({
      caseId: CASE_ID,
      recipientEmail: "student@example.com",
      category: "direct_message",
      tier: "interrupt",
      subject: "Test subject",
      resendEmailId: "re_123",
      dedupeKey: "key-1",
    }));
    expect(result).toEqual({ skipped: false, resendEmailId: "re_123", logId: "id-1" });
  });

  it("throws when RESEND_API_KEY is not configured (no log row)", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const { db, inserts } = makeDb();

    await expect(sendAdmissionsEmail(input, db)).rejects.toThrow(/RESEND_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("throws the provider message on a non-2xx response (no log row)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ message: "Invalid from address" }),
    });
    const { db, inserts } = makeDb();

    await expect(sendAdmissionsEmail(input, db)).rejects.toThrow("Invalid from address");
    expect(inserts).toHaveLength(0);
  });
});

describe("buildDeadlineReminders", () => {
  it("plans T-7d/T-48h reminders per assigned recipient, ignoring notification prefs (CM-112)", async () => {
    const { db } = makeDb({
      selects: new Map<unknown, SelectBehavior>([
        [admissionsCases, { where: [{ id: CASE_ID }] }],
        [admissionsCaseMembers, {
          where: [
            // Every downgradable category is "off" — deadline reminders must
            // still be planned (they have no pref key, CM-112 fail-closed).
            memberRow({
              email: "student@example.com",
              role: "student",
              notificationPrefs: { announcements: "off", tasks: "off", comments: "off" },
            }),
            memberRow({ id: "member-2", email: "counselor@example.com", role: "counselor" }),
          ],
        }],
      ]),
    });
    getUpcomingDeadlinesMock.mockResolvedValueOnce([
      calendarItem({ id: "item-a", title: "Essay draft", date: D7_KEY, ownerRole: "student" }),
      calendarItem({ id: "item-b", title: "Verify transcript", date: D2_KEY, ownerRole: "counselor" }),
      calendarItem({ id: "item-c", title: "Far future", date: "2026-07-20", ownerRole: "student" }),
      calendarItem({ id: "item-d", title: "Ownerless app deadline", date: D7_KEY, ownerRole: null }),
    ]);

    const reminders = await buildDeadlineReminders(NOW, db);

    expect(reminders).toEqual([
      {
        recipientEmail: "counselor@example.com",
        items: [{
          caseId: CASE_ID,
          itemId: "item-b",
          title: "Verify transcript",
          date: D2_KEY,
          window: "2d",
          dedupeKey: `item-b:2d:counselor@example.com`,
        }],
      },
      {
        recipientEmail: "student@example.com",
        items: [{
          caseId: CASE_ID,
          itemId: "item-a",
          title: "Essay draft",
          date: D7_KEY,
          window: "7d",
          dedupeKey: `item-a:7d:student@example.com`,
        }],
      },
    ]);
  });
});

describe("runDailyNotifications", () => {
  function dailySelects(members: Row[], todayInterruptCount: number): Map<unknown, SelectBehavior> {
    return new Map<unknown, SelectBehavior>([
      [admissionsCases, { where: [{ id: CASE_ID }] }],
      [admissionsCaseMembers, { where: members }],
      [admissionsNotificationLog, { where: [{ value: todayInterruptCount }], limit: [] }],
    ]);
  }

  it("sends individual reminder emails while under the daily cap", async () => {
    const { db, inserts, updates } = makeDb({
      selects: dailySelects([memberRow({})], 0),
    });
    getUpcomingDeadlinesMock.mockResolvedValueOnce([
      calendarItem({ id: "item-a", title: "Essay draft" }),
      calendarItem({ id: "item-b", title: "SAT registration" }),
    ]);

    const result = await runDailyNotifications(NOW, db);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const logInserts = inserts.filter((call) => call.table === admissionsNotificationLog);
    expect(logInserts.map((call) => call.values.dedupeKey)).toEqual([
      "item-a:7d:student@example.com",
      "item-b:7d:student@example.com",
    ]);
    expect(logInserts.every((call) =>
      call.values.category === "deadline_reminder" && call.values.tier === "interrupt",
    )).toBe(true);
    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      runType: "daily",
      sentCount: 2,
      skippedCount: 0,
      errorSummary: null,
    }));
    const finalize = updates[updates.length - 1];
    expect(finalize.table).toBe(admissionsNotificationRuns);
    expect(finalize.set).toEqual(expect.objectContaining({ status: "success", sentCount: 2 }));
  });

  it("collapses more than the cap into ONE combined email listing all items (CM-111)", async () => {
    const { db, inserts } = makeDb({
      selects: dailySelects([memberRow({})], 0),
    });
    getUpcomingDeadlinesMock.mockResolvedValueOnce([
      calendarItem({ id: "item-a", title: "Essay draft" }),
      calendarItem({ id: "item-b", title: "SAT registration" }),
      calendarItem({ id: "item-c", title: "Ask recommender" }),
      calendarItem({ id: "item-d", title: "FAFSA form" }),
    ]);

    const result = await runDailyNotifications(NOW, db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = fetchBody(fetchMock);
    expect(body.subject).toBe("Reminder: 4 admissions deadlines coming up");
    for (const title of ["Essay draft", "SAT registration", "Ask recommender", "FAFSA form"]) {
      expect(body.html).toContain(title);
    }
    const logInserts = inserts.filter((call) => call.table === admissionsNotificationLog);
    expect(logInserts).toHaveLength(1);
    expect(logInserts[0].values.dedupeKey).toBe(
      `deadline-combined:student@example.com:${TODAY_KEY}`,
    );
    expect(result.sentCount).toBe(1);
  });

  it("counts today's already-sent interrupt emails toward the cap", async () => {
    const { db } = makeDb({
      selects: dailySelects([memberRow({})], INTERRUPT_DAILY_CAP),
    });
    getUpcomingDeadlinesMock.mockResolvedValueOnce([
      calendarItem({ id: "item-a", title: "Essay draft" }),
    ]);

    await runDailyNotifications(NOW, db);

    // 3 already sent + 1 planned > 3 → collapse even for a single item.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchBody(fetchMock).subject).toBe("Reminder: 1 admissions deadlines coming up");
  });

  it("skips when another notification run is already in flight (single-flight)", async () => {
    const { db, inserts, updates } = makeDb({
      insertError: (table) =>
        table === admissionsNotificationRuns
          ? Object.assign(new Error("duplicate key"), { code: "23505" })
          : null,
    });

    const result = await runDailyNotifications(NOW, db);

    expect(result).toEqual({
      skipped: true,
      runId: null,
      runType: "daily",
      sentCount: 0,
      skippedCount: 0,
      errorSummary: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    // The stale-run sweep still ran before the guarded insert.
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsNotificationRuns);
    expect(updates[0].set).toEqual(expect.objectContaining({ status: "failed" }));
  });
});

describe("buildWeeklyDigest", () => {
  const RECENT_ANNOUNCEMENT = {
    id: "ann-recent",
    cohortId: null,
    caseId: CASE_ID,
    title: "College fair",
    body: "Sign-ups open",
    authorEmail: "counselor@example.com",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
  const OLD_ANNOUNCEMENT = {
    ...RECENT_ANNOUNCEMENT,
    id: "ann-old",
    title: "Ancient news",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };

  function digestSelects(members: Row[]): Map<unknown, SelectBehavior> {
    return new Map<unknown, SelectBehavior>([
      [admissionsCases, { limit: [{ fullName: "Nara Chai", preferredName: null }] }],
      [admissionsCaseTasks, {
        where: [
          {
            id: "task-recent",
            title: "Draft activities list",
            owner: "student",
            dueDate: "2026-07-15",
            createdAt: new Date("2026-06-30T00:00:00Z"),
          },
          {
            id: "task-old",
            title: "Old task",
            owner: "student",
            dueDate: null,
            createdAt: new Date("2026-06-01T00:00:00Z"),
          },
        ],
      }],
      [admissionsCaseMembers, { where: members }],
    ]);
  }

  it("shapes content per role and keeps only the past 7 days", async () => {
    listAnnouncementsMock.mockResolvedValueOnce([RECENT_ANNOUNCEMENT, OLD_ANNOUNCEMENT]);
    const selects = digestSelects([
      memberRow({ id: "m-c", email: "counselor@example.com", role: "counselor" }),
      memberRow({ id: "m-s", email: "student@example.com", role: "student" }),
      memberRow({ id: "m-p", email: "parent@example.com", role: "parent" }),
    ]);
    selects.set(admissionsSelfReportSections, {
      where: [
        { sectionKey: "about_you", submittedAt: new Date("2026-06-29T00:00:00Z") },
        { sectionKey: "research_notes", submittedAt: null },
      ],
    });
    const { db } = makeDb({ selects });

    const digest = await buildWeeklyDigest(CASE_ID, NOW, db);

    expect(digest.studentFirstName).toBe("Nara");
    expect(digest.recipients).toHaveLength(3);

    const counselor = digest.recipients.find((r) => r.role === "counselor");
    expect(counselor?.announcements.map((a) => a.id)).toEqual(["ann-recent"]);
    expect(counselor?.newTasks.map((t) => t.id)).toEqual(["task-recent"]);
    expect(counselor?.sectionSubmissions).toEqual([
      { sectionKey: "about_you", submittedAt: "2026-06-29T00:00:00.000Z" },
    ]);

    const student = digest.recipients.find((r) => r.role === "student");
    expect(student?.announcements.map((a) => a.id)).toEqual(["ann-recent"]);
    expect(student?.newTasks.map((t) => t.id)).toEqual(["task-recent"]);
    expect(student?.sectionSubmissions).toEqual([]);

    const parent = digest.recipients.find((r) => r.role === "parent");
    expect(parent?.announcements.map((a) => a.id)).toEqual(["ann-recent"]);
    expect(parent?.newTasks).toEqual([]);
    expect(parent?.sectionSubmissions).toEqual([]);
  });

  it("respects per-category pref downgrades and drops fully-muted recipients (CM-112)", async () => {
    listAnnouncementsMock.mockResolvedValueOnce([RECENT_ANNOUNCEMENT]);
    const { db } = makeDb({
      selects: digestSelects([
        memberRow({
          id: "m-c",
          email: "counselor@example.com",
          role: "counselor",
          notificationPrefs: { announcements: "off", comments: "off" },
        }),
        memberRow({
          id: "m-s",
          email: "student@example.com",
          role: "student",
          notificationPrefs: { announcements: "off", tasks: "off" },
        }),
      ]),
    });

    const digest = await buildWeeklyDigest(CASE_ID, NOW, db);

    // Counselor keeps tasks only; the fully-muted student gets no digest.
    expect(digest.recipients).toHaveLength(1);
    expect(digest.recipients[0].recipientEmail).toBe("counselor@example.com");
    expect(digest.recipients[0].announcements).toEqual([]);
    expect(digest.recipients[0].newTasks.map((t) => t.id)).toEqual(["task-recent"]);
    expect(digest.recipients[0].sectionSubmissions).toEqual([]);
  });

  it("throws NotFound when the case/student join resolves nothing", async () => {
    listAnnouncementsMock.mockResolvedValueOnce([]);
    const { db } = makeDb({
      selects: new Map<unknown, SelectBehavior>([[admissionsCases, { limit: [] }]]),
    });

    await expect(buildWeeklyDigest(CASE_ID, NOW, db)).rejects.toThrow("NotFound");
  });
});

describe("runWeeklyDigest", () => {
  it("sends batch-tier digests with a same-day idempotent dedupe key", async () => {
    listAnnouncementsMock.mockResolvedValueOnce([{
      id: "ann-recent",
      cohortId: null,
      caseId: CASE_ID,
      title: "College fair",
      body: "Sign-ups open",
      authorEmail: "counselor@example.com",
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    }]);
    const { db, inserts } = makeDb({
      selects: new Map<unknown, SelectBehavior>([
        [admissionsCases, {
          where: [{ id: CASE_ID }],
          limit: [{ fullName: "Nara Chai", preferredName: null }],
        }],
        [admissionsCaseTasks, { where: [] }],
        [admissionsCaseMembers, {
          where: [memberRow({ id: "m-p", email: "parent@example.com", role: "parent" })],
        }],
        [admissionsNotificationLog, { limit: [] }],
      ]),
    });

    const result = await runWeeklyDigest(NOW, db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = fetchBody(fetchMock);
    expect(body.subject).toBe("Weekly admissions update — Nara");
    expect(body.to).toEqual(["parent@example.com"]);
    const logInserts = inserts.filter((call) => call.table === admissionsNotificationLog);
    expect(logInserts).toHaveLength(1);
    expect(logInserts[0].values).toEqual(expect.objectContaining({
      category: "digest",
      tier: "batch",
      dedupeKey: `digest:${CASE_ID}:parent@example.com:${TODAY_KEY}`,
    }));
    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      runType: "weekly",
      sentCount: 1,
      skippedCount: 0,
    }));
  });
});

describe("member invites (PRD §3.7)", () => {
  const MEMBER: AdmissionsMemberDto = {
    id: "member-9",
    caseId: CASE_ID,
    email: "parent@example.com",
    role: "parent",
    status: "invited",
    invitedAt: "2026-07-01T00:00:00.000Z",
    activatedAt: null,
    revokedAt: null,
    addedByEmail: "counselor@example.com",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };

  it("sends a Thai-first invite containing ONLY the child's first name and the sign-in link", async () => {
    const { db, inserts } = makeDb({
      selects: new Map<unknown, SelectBehavior>([
        [admissionsCases, { limit: [{ fullName: "Nara Chai Somsak", preferredName: null }] }],
      ]),
    });

    const result = await sendMemberInviteForCase(MEMBER, db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = fetchBody(fetchMock);
    const subject = body.subject as string;
    const html = body.html as string;

    // Thai-first subject carrying the first name.
    expect(subject.startsWith("คำเชิญ")).toBe(true);
    expect(subject).toContain("Nara");
    // Body: first name + sign-in link only.
    expect(html).toContain("Nara");
    expect(html).toContain(ADMISSIONS_SIGN_IN_URL);
    // No surname, no case data of any kind.
    expect(subject).not.toContain("Chai");
    expect(subject).not.toContain("Somsak");
    expect(html).not.toContain("Chai");
    expect(html).not.toContain("Somsak");
    expect(html).not.toContain(CASE_ID);
    expect(subject).not.toContain(CASE_ID);

    const logInserts = inserts.filter((call) => call.table === admissionsNotificationLog);
    expect(logInserts).toHaveLength(1);
    expect(logInserts[0].values).toEqual(expect.objectContaining({
      category: "invite",
      tier: "interrupt",
      recipientEmail: "parent@example.com",
      dedupeKey: null,
    }));
    expect(result.skipped).toBe(false);
  });

  it("throws NotFound for a missing or soft-deleted case (caller catches, never rethrows)", async () => {
    const { db } = makeDb({
      selects: new Map<unknown, SelectBehavior>([[admissionsCases, { limit: [] }]]),
    });

    await expect(sendMemberInviteForCase(MEMBER, db)).rejects.toThrow("NotFound");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("deriveStudentFirstName", () => {
  it("prefers the preferred name's first token", () => {
    expect(deriveStudentFirstName({ fullName: "Nara Chai", preferredName: "Beam Junior" }))
      .toBe("Beam");
  });

  it("falls back to the full name's first token", () => {
    expect(deriveStudentFirstName({ fullName: "Nara Chai", preferredName: null })).toBe("Nara");
  });

  it("falls back to \"Student\" when no name is derivable", () => {
    expect(deriveStudentFirstName({ fullName: "   ", preferredName: null })).toBe("Student");
  });
});
