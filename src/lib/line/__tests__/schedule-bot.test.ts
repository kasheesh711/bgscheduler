// ----------------------------------------------------------------------------
// Schedule-bot security suite.
//
// The assertion that matters in almost every case is "zero pushes to a parent".
// The bot is injected with a fake pusher so nothing here can reach api.line.me;
// every test counts what WOULD have been sent.
// ----------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/line/student-links", () => ({
  searchCurrentLineStudents: vi.fn(),
}));
vi.mock("@/lib/student-schedule/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/student-schedule/data")>();
  return { ...actual, getStudentMonthlySchedule: vi.fn() };
});
vi.mock("@/lib/student-schedule/links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/student-schedule/links")>();
  return { ...actual, mintStudentScheduleLink: vi.fn() };
});

import { searchCurrentLineStudents } from "@/lib/line/student-links";
import { getStudentMonthlySchedule } from "@/lib/student-schedule/data";
import { mintStudentScheduleLink } from "@/lib/student-schedule/links";
import {
  handleScheduleBotCommand,
  isScheduleBotAdmin,
  scheduleBotAdminIds,
} from "@/lib/line/schedule-bot";
import type { Database } from "@/lib/db";

const ADMIN = "Uadmin000000000000000000000000001";
const PARENT = "Uparent00000000000000000000000001";
const OUTSIDER = "Uoutsider000000000000000000000001";

const NOW = new Date("2026-08-05T03:00:00Z");

/**
 * Minimal chainable Drizzle stand-in. `selectResults` is consumed in order, one
 * entry per awaited select chain; inserts and deletes are recorded.
 */
function makeDb(selectResults: unknown[][]) {
  const queue = [...selectResults];
  const inserts: unknown[] = [];
  const deletes: unknown[] = [];

  function chain(result: unknown[]) {
    const node: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy"]) {
      node[method] = () => node;
    }
    node.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
    node.catch = () => node;
    return node;
  }

  const db = {
    select: () => chain(queue.shift() ?? []),
    insert: () => ({
      values: (row: unknown) => {
        inserts.push(row);
        const node: Record<string, unknown> = {
          onConflictDoUpdate: () => node,
          returning: () => Promise.resolve([{ id: "link-1" }]),
        };
        node.then = (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
        return node;
      },
    }),
    delete: () => ({
      where: (condition: unknown) => {
        deletes.push(condition);
        return Promise.resolve(undefined);
      },
    }),
  };

  return { db: db as unknown as Database, inserts, deletes };
}

function student(overrides: Record<string, unknown> = {}) {
  return {
    wiseStudentId: "stu_1",
    studentKey: "aadhiya srisethi::nok srisethi",
    studentName: "Aadhiya (Aadhu.Sr) Srisethi",
    parentName: "Nok Srisethi",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
    ...overrides,
  };
}

function contactRow(lineUserId = PARENT, displayName = "Khun Nok") {
  return { contactId: "contact-1", lineUserId, displayName };
}

function schedule(sessionCount: number) {
  return {
    student: {
      studentKey: "aadhiya srisethi::nok srisethi",
      wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi",
      parentName: "Nok Srisethi",
      code: "Aadhu.Sr",
      shortName: "Aadhu",
    },
    monthKey: "2026-08",
    monthLabel: "August 2026",
    sessions: Array.from({ length: sessionCount }, (_, index) => ({
      wiseSessionId: `ses_${index}`,
      dateKey: "2026-08-04",
      startTime: "2026-08-04T03:00:00.000Z",
      endTime: "2026-08-04T04:30:00.000Z",
      startLabel: "10:00",
      endLabel: "11:30",
      subject: "Mathematics",
      packageName: "Maths 20-pack",
      teacherName: "Kru Nok",
      durationMinutes: 90,
      meetingStatus: "SCHEDULED",
    })),
    generatedAt: NOW.toISOString(),
  };
}

function deps(push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} })) {
  return { push, now: () => NOW, baseUrl: "https://example.test", ttlDays: 30 };
}

/** Messages the fake pusher aimed at anyone other than the requesting admin. */
function parentPushes(push: ReturnType<typeof vi.fn>) {
  return push.mock.calls.filter(([arg]) => arg.to !== ADMIN);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINE_SCHEDULE_BOT_ADMIN_IDS = ADMIN;
});

describe("SCHED-BOT-01 sender allowlist", () => {
  it("ignores a non-allowlisted sender entirely and pushes nothing", async () => {
    const push = vi.fn();
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: OUTSIDER, text: "Aadhu.Sr" },
      deps(push),
    );

    expect(result).toEqual({ handled: false });
    expect(push).not.toHaveBeenCalled();
    // Nothing was even looked up — a parent must not be able to probe the roster.
    expect(searchCurrentLineStudents).not.toHaveBeenCalled();
  });

  it("disables the bot when the allowlist is unset or blank", async () => {
    for (const value of [undefined, "", "   ", ",,"]) {
      if (value === undefined) delete process.env.LINE_SCHEDULE_BOT_ADMIN_IDS;
      else process.env.LINE_SCHEDULE_BOT_ADMIN_IDS = value;

      const push = vi.fn();
      const { db } = makeDb([]);
      const result = await handleScheduleBotCommand(
        { db, lineUserId: ADMIN, text: "Aadhu.Sr" },
        deps(push),
      );
      expect(result).toEqual({ handled: false });
      expect(push).not.toHaveBeenCalled();
    }
  });

  it("parses a comma-separated allowlist", () => {
    expect(scheduleBotAdminIds("a, b ,,c")).toEqual(new Set(["a", "b", "c"]));
    expect(isScheduleBotAdmin("b", "a,b")).toBe(true);
    expect(isScheduleBotAdmin("z", "a,b")).toBe(false);
  });
});

describe("SCHED-BOT-02 verified link required", () => {
  it("refuses when the student has no verified contact", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    const push = vi.fn();
    const { db, inserts } = makeDb([[]]); // no verified contacts

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "Aadhu.Sr" },
      deps(push),
    );

    expect(result.action).toBe("no_verified_contact");
    expect(parentPushes(push)).toHaveLength(0);
    expect(inserts).toHaveLength(0); // no pending row written
    expect(push.mock.calls[0][0].text).toContain("/line-review");
  });

  it("refuses to guess when several contacts are verified", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    const push = vi.fn();
    const { db, inserts } = makeDb([[
      contactRow(PARENT, "Khun Nok"),
      contactRow("Uparent00000000000000000000000002", "Khun Dad"),
    ]]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "Aadhu.Sr" },
      deps(push),
    );

    expect(result.action).toBe("multiple_contacts");
    expect(parentPushes(push)).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

describe("SCHED-BOT-03 explicit confirm", () => {
  it("never sends on the first message — it writes a pending row and asks", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(12) as never);
    const push = vi.fn();
    const { db, inserts } = makeDb([[contactRow()]]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "Aadhu.Sr" },
      deps(push),
    );

    expect(result.action).toBe("awaiting_confirm");
    expect(parentPushes(push)).toHaveLength(0);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);

    // The prompt must echo all four fields so a wrong code is visible.
    const prompt = push.mock.calls[0][0].text as string;
    expect(prompt).toContain("Aadhu.Sr");
    expect(prompt).toContain("August 2026");
    expect(prompt).toContain("12 classes");
    expect(prompt).toContain("Khun Nok");
  });

  it("lists candidates and picks nothing when the code is ambiguous", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([
      student(),
      student({ studentKey: "b", studentName: "Bee (Bee.Sr) Srisethi" }),
    ] as never);
    const push = vi.fn();
    const { db, inserts } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "aadhu" },
      deps(push),
    );

    expect(result.action).toBe("ambiguous");
    expect(parentPushes(push)).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(push.mock.calls[0][0].text).toContain("Aadhu.Sr");
    expect(push.mock.calls[0][0].text).toContain("Bee.Sr");
  });

  it("refuses an expired pending confirmation", async () => {
    const push = vi.fn();
    const { db } = makeDb([[{
      lineUserId: ADMIN,
      studentKey: "k",
      wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi",
      parentName: "Nok",
      targetLineUserId: PARENT,
      targetDisplayName: "Khun Nok",
      monthKey: "2026-08",
      sessionCount: 12,
      expiresAt: new Date(NOW.getTime() - 1000),
      createdAt: NOW,
    }]]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "yes" },
      deps(push),
    );

    expect(result.action).toBe("pending_expired");
    expect(parentPushes(push)).toHaveLength(0);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("sends nothing on YES with no pending row at all", async () => {
    const push = vi.fn();
    const { db } = makeDb([[]]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "YES" },
      deps(push),
    );

    expect(result.action).toBe("pending_expired");
    expect(parentPushes(push)).toHaveLength(0);
  });

  it("drops the pending row on NO", async () => {
    const push = vi.fn();
    const { db, deletes } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "no" },
      deps(push),
    );

    expect(result.action).toBe("cancelled");
    expect(deletes).toHaveLength(1);
    expect(parentPushes(push)).toHaveLength(0);
  });
});

describe("SCHED-BOT-04 non-empty month", () => {
  it("refuses to push a month with no classes", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(0) as never);
    const push = vi.fn();
    const { db, inserts } = makeDb([[contactRow()]]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "Aadhu.Sr" },
      deps(push),
    );

    expect(result.action).toBe("empty_month");
    expect(parentPushes(push)).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

describe("happy path", () => {
  it("pushes exactly one message to the verified parent after YES", async () => {
    vi.mocked(mintStudentScheduleLink).mockResolvedValue({
      token: "tok_abc",
      expiresAt: new Date("2026-09-04T03:00:00Z"),
      id: "link-1",
    } as never);

    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([
      // pending row lookup
      [{
        lineUserId: ADMIN,
        studentKey: "aadhiya srisethi::nok srisethi",
        wiseStudentId: "stu_1",
        studentName: "Aadhiya (Aadhu.Sr) Srisethi",
        parentName: "Nok Srisethi",
        targetLineUserId: PARENT,
        targetDisplayName: "Khun Nok",
        monthKey: "2026-08",
        sessionCount: 12,
        expiresAt: new Date(NOW.getTime() + 60_000),
        createdAt: NOW,
      }],
      [{ id: "contact-1" }], // audit: contact
      [{ id: "thread-1" }],  // audit: thread
    ]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "yes" },
      deps(push),
    );

    expect(result.action).toBe("sent");

    const toParent = parentPushes(push);
    expect(toParent).toHaveLength(1);
    expect(toParent[0][0].to).toBe(PARENT);
    // Nickname, not the full legal name.
    expect(toParent[0][0].text).toContain("น้องAadhu");
    expect(toParent[0][0].text).not.toContain("Srisethi");
    expect(toParent[0][0].text).toContain("https://example.test/schedule/tok_abc");
    expect(toParent[0][0].retryKey).toBeTruthy();

    // And exactly one confirmation back to the admin.
    const toAdmin = push.mock.calls.filter(([arg]) => arg.to === ADMIN);
    expect(toAdmin).toHaveLength(1);
    expect(toAdmin[0][0].text).toContain("Khun Nok");
  });

  it("reports a failed push instead of claiming success", async () => {
    vi.mocked(mintStudentScheduleLink).mockResolvedValue({
      token: "tok_abc",
      expiresAt: new Date("2026-09-04T03:00:00Z"),
      id: "link-1",
    } as never);

    const push = vi.fn()
      .mockRejectedValueOnce(new Error("LINE push returned HTTP 500"))
      .mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });

    const { db } = makeDb([[{
      lineUserId: ADMIN,
      studentKey: "k",
      wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi",
      parentName: "Nok",
      targetLineUserId: PARENT,
      targetDisplayName: "Khun Nok",
      monthKey: "2026-08",
      sessionCount: 12,
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    }]]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "yes" },
      deps(push),
    );

    expect(result.action).toBe("send_failed");
    const toAdmin = push.mock.calls.filter(([arg]) => arg.to === ADMIN);
    expect(toAdmin[0][0].text).toContain("Nothing was delivered");
  });
});

describe("command parsing", () => {
  it("accepts an explicit month", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(3) as never);
    const push = vi.fn();
    const { db } = makeDb([[contactRow()]]);

    await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "Aadhu.Sr 2026-09" },
      deps(push),
    );

    expect(vi.mocked(getStudentMonthlySchedule).mock.calls[0][1]).toMatchObject({
      monthKey: "2026-09",
    });
  });

  it("answers help without touching the database", async () => {
    const push = vi.fn();
    const { db } = makeDb([]);
    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "help" },
      deps(push),
    );
    expect(result.action).toBe("help");
    expect(searchCurrentLineStudents).not.toHaveBeenCalled();
  });

  it("leaves free-form prose to the normal classifier path", async () => {
    const push = vi.fn();
    const { db } = makeDb([]);
    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "can we move Tuesday to Thursday please" },
      deps(push),
    );
    expect(result).toEqual({ handled: false });
    expect(push).not.toHaveBeenCalled();
  });
});
