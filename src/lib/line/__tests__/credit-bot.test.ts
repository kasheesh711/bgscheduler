// ----------------------------------------------------------------------------
// Credit-bot suite.
//
// The assertions that matter: non-admins and non-staff chats get NOTHING (not
// even a refusal), balances match the raw snapshot packages, and the report
// link carries the exact keys/dates the Parent Report page parses.
// ----------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial: exactCodeMatches must run the real nicknameCodes normalization.
vi.mock("@/lib/line/student-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/line/student-links")>();
  return { ...actual, searchCurrentLineStudentsWithSnapshot: vi.fn() };
});

import { searchCurrentLineStudentsWithSnapshot } from "@/lib/line/student-links";
import { handleScheduleBotCommand } from "@/lib/line/schedule-bot";
import { handleScheduleBotGroupCommand } from "@/lib/line/schedule-bot-group";
import { handleCreditCommand } from "@/lib/line/credit-bot";
import type { Database } from "@/lib/db";

const ADMIN = "Uadmin000000000000000000000000001";
const OUTSIDER = "Uoutsider000000000000000000000001";
const GROUP = "Cgroup000000000000000000000000001";

const NOW = new Date("2026-08-05T03:00:00Z"); // 2026-08-05 10:00 Bangkok
const SNAP = { id: "snap-1", generatedAt: NOW };

/**
 * Chainable Drizzle stand-in: one queue entry per awaited select chain, with
 * inserts and updates recorded (the schedule-bot harness plus `update`).
 */
function makeDb(selectResults: unknown[][]) {
  const queue = [...selectResults];
  const updates: unknown[] = [];

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
    update: () => ({
      set: (values: unknown) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve(undefined);
        },
      }),
    }),
  };

  return { db: db as unknown as Database, updates, queue };
}

function student(overrides: Record<string, unknown> = {}) {
  return {
    wiseStudentId: "stu_1",
    studentKey: "teethad (copter.th) thamprida::kanokwan thamprida",
    studentName: "Teethad (Copter.Th) Thamprida",
    parentName: "Kanokwan Thamprida",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
    matchType: "exact_code",
    ...overrides,
  };
}

const SIBLING_ROWS = [
  { studentKey: "jidapa (jasmine.th) thamprida::kanokwan thamprida", studentName: "Jidapa (Jasmine.Th) Thamprida" },
  { studentKey: "teethad (copter.th) thamprida::kanokwan thamprida", studentName: "Teethad (Copter.Th) Thamprida" },
];

const PACKAGE_ROWS = [
  { studentKey: "teethad (copter.th) thamprida::kanokwan thamprida", subject: "Mathematics", packageName: "Maths 20", remainingCredits: 3.5 },
  { studentKey: "teethad (copter.th) thamprida::kanokwan thamprida", subject: "Physics", packageName: "Physics 10", remainingCredits: 1 },
  { studentKey: "jidapa (jasmine.th) thamprida::kanokwan thamprida", subject: "Biology", packageName: "Bio 10", remainingCredits: 12.86 },
];

function dmDeps(push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} })) {
  return { push, now: () => NOW, baseUrl: "https://example.test", ttlDays: 30 };
}

function groupDeps(
  reply = vi.fn().mockResolvedValue({ sentMessageId: "m", response: {} }),
  push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} }),
) {
  return { reply, push, now: () => NOW, baseUrl: "https://example.test", ttlDays: 30 };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINE_SCHEDULE_BOT_ADMIN_IDS = ADMIN;
});

describe("admin gate inheritance", () => {
  it("DM: a non-admin /credit is silently unhandled and looks nothing up", async () => {
    const push = vi.fn();
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: OUTSIDER, text: "/credit Copter.Th" },
      dmDeps(push),
    );

    expect(result).toEqual({ handled: false });
    expect(push).not.toHaveBeenCalled();
    expect(searchCurrentLineStudentsWithSnapshot).not.toHaveBeenCalled();
  });

  it("group: a non-admin /credit gets no reply at all", async () => {
    const d = groupDeps();
    const { db } = makeDb([]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: OUTSIDER, text: "/credit Copter.Th", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: false });
    expect(d.reply).not.toHaveBeenCalled();
    expect(d.push).not.toHaveBeenCalled();
  });
});

describe("DM balance reply", () => {
  it("fans out to siblings, orders the queried student first, and links the report", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [student()] } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([SIBLING_ROWS, PACKAGE_ROWS]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/credit Copter.Th" },
      dmDeps(push),
    );

    expect(result).toEqual({ handled: true, action: "credit_balance" });
    expect(push).toHaveBeenCalledTimes(1);
    const text: string = push.mock.calls[0][0].text;

    // Queried student leads with the family sum; the sibling follows.
    expect(text.indexOf("Teethad (Copter.Th)")).toBeLessThan(text.indexOf("Jidapa (Jasmine.Th)"));
    expect(text).toContain("💳 Teethad (Copter.Th) Thamprida — 4.5 credits left");
    expect(text).toContain("• Mathematics: 3.5");
    expect(text).toContain("• Physics: 1");
    expect(text).toContain("💳 Jidapa (Jasmine.Th) Thamprida — 12.86 credits left");

    // Report link: queried key first, trailing-30-day Bangkok window.
    const url = new URL(text.split("\n").find((line) => line.startsWith("https://"))!);
    expect(url.pathname).toBe("/student-report/report");
    expect(url.searchParams.getAll("student")).toEqual([
      "teethad (copter.th) thamprida::kanokwan thamprida",
      "jidapa (jasmine.th) thamprida::kanokwan thamprida",
    ]);
    expect(url.searchParams.get("from")).toBe("2026-07-06");
    expect(url.searchParams.get("to")).toBe("2026-08-05");

    expect(text).toContain("Data as of");
  });

  it("does not fan out when the parent name is blank", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [student({ parentName: "" })] } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    // Only the packages select runs — a sibling query on parentName "" would
    // sweep in every parent-less student on the snapshot.
    const { db, queue } = makeDb([[PACKAGE_ROWS[0]]]);

    await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/credit Copter.Th" },
      dmDeps(push),
    );

    expect(queue).toHaveLength(0);
    const text: string = push.mock.calls[0][0].text;
    expect(new URL(text.split("\n").find((line) => line.startsWith("https://"))!)
      .searchParams.getAll("student")).toHaveLength(1);
  });

  it("lists candidates instead of guessing when the code is not exact", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      {
        snapshot: SNAP,
        rows: [
          student(),
          student({ studentKey: "k2", studentName: "Jidapa (Jasmine.Th) Thamprida" }),
        ],
      } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/credit Thamprida" },
      dmDeps(push),
    );

    expect(result.action).toBe("credit_not_exact");
    const text: string = push.mock.calls[0][0].text;
    expect(text).toContain("isn't an exact code");
    expect(text).toContain("Copter.Th");
    expect(text).toContain("Jasmine.Th");
  });

  it("says so when no snapshot is active", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: null, rows: [] } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/credit Copter.Th" },
      dmDeps(push),
    );

    expect(result.action).toBe("credit_no_snapshot");
    expect(push.mock.calls[0][0].text).toContain("can't read balances");
  });

  it("caps the report link at 8 students and says how many were dropped", async () => {
    const siblings = Array.from({ length: 10 }, (_, index) => ({
      studentKey: `s${index} (kid${index}.fam)::parent fam`,
      studentName: `S${index} (Kid${index}.Fam) Fam`,
    }));
    const respond = vi.fn().mockResolvedValue(undefined);
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      {
        snapshot: SNAP,
        rows: [student({ studentKey: siblings[0].studentKey, studentName: siblings[0].studentName, parentName: "Parent Fam" })],
      } as never,
    );
    const { db } = makeDb([siblings, []]);

    await handleCreditCommand({
      db,
      lineUserId: ADMIN,
      command: "Kid0.Fam",
      surface: { kind: "dm" },
      respond,
      now: () => NOW,
      baseUrl: "https://example.test",
    });

    const text: string = respond.mock.calls[0][0];
    const url = new URL(text.split("\n").find((line) => line.startsWith("https://"))!);
    expect(url.searchParams.getAll("student")).toHaveLength(8);
    expect(text).toContain("first 8 students (+2 more)");
  });

  it("help lists the credit commands", async () => {
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/credit" },
      dmDeps(push),
    );

    expect(result.action).toBe("credit_help");
    expect(push.mock.calls[0][0].text).toContain("/credit setup");
  });
});

describe("CRED-BOT-R1 finished-package filter", () => {
  const KEY = "solo (solo.aa) a::";

  function soloStudent() {
    // Blank parent → no sibling fan-out, so the queue is just packages (+ the
    // pair query when a package sits at ≤ 0).
    return student({ studentKey: KEY, studentName: "Solo (Solo.Aa) A", parentName: "" });
  }

  function run(db: Database, respond = vi.fn().mockResolvedValue(undefined)) {
    return handleCreditCommand({
      db,
      lineUserId: ADMIN,
      command: "Solo.Aa",
      surface: { kind: "dm" },
      respond,
      now: () => NOW,
      baseUrl: "https://example.test",
    }).then(() => respond.mock.calls[0][0] as string);
  }

  it("hides a drained package with no upcoming classes and counts it", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [soloStudent()] } as never,
    );
    const { db, queue } = makeDb([
      [
        { studentKey: KEY, wiseClassId: "class-live", wiseStudentId: "stu_1", subject: "Y9-11 / G8-10 (Int.)", packageName: "Solo", remainingCredits: 6 },
        { studentKey: KEY, wiseClassId: "class-old", wiseStudentId: "stu_1", subject: "Y2-8 / G1-7 (Int.)", packageName: "Solo", remainingCredits: 0 },
      ],
      // Pair query: only the live payband still has upcoming sessions.
      [{ wiseClassId: "class-live", wiseStudentId: "stu_1" }],
    ]);

    const text = await run(db);

    expect(queue).toHaveLength(0);
    // Total sums visible rows only, and the stale payband line is gone.
    expect(text).toContain("💳 Solo (Solo.Aa) A — 6 credits left");
    expect(text).toContain("• Y9-11 / G8-10 (Int.): 6");
    expect(text).not.toContain("Y2-8");
    expect(text).toContain("🗂 1 finished package hidden");
  });

  it("keeps a drained package visible while classes are still booked", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [soloStudent()] } as never,
    );
    const { db } = makeDb([
      [{ studentKey: KEY, wiseClassId: "class-sat", wiseStudentId: "stu_1", subject: "SAT", packageName: "Solo", remainingCredits: -45.5 }],
      [{ wiseClassId: "class-sat", wiseStudentId: "stu_1" }],
    ]);

    const text = await run(db);

    expect(text).toContain("💳 Solo (Solo.Aa) A — -45.5 credits left");
    expect(text).toContain("• SAT: -45.5");
    expect(text).not.toContain("🗂");
  });

  it("keeps a positive package visible even with nothing booked yet", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [soloStudent()] } as never,
    );
    const { db } = makeDb([
      [
        { studentKey: KEY, wiseClassId: "class-sat", wiseStudentId: "stu_1", subject: "SAT", packageName: "Solo", remainingCredits: 40 },
        { studentKey: KEY, wiseClassId: "class-old", wiseStudentId: "stu_1", subject: "11+/13+", packageName: "Solo", remainingCredits: 0 },
      ],
      [], // no upcoming sessions at all
    ]);

    const text = await run(db);

    expect(text).toContain("• SAT: 40");
    expect(text).toContain("🗂 1 finished package hidden");
  });

  it("shows no-active-packages plus the hidden count when everything is finished", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [soloStudent()] } as never,
    );
    const { db } = makeDb([
      [
        { studentKey: KEY, wiseClassId: "camp", wiseStudentId: "stu_1", subject: "13-17 Jul | 8:30-15:00", packageName: "Creative STEAM Camp: Year 3–4", remainingCredits: 0 },
        { studentKey: KEY, wiseClassId: "receipt", wiseStudentId: "stu_1", subject: "Package: Creative STEAM (Receipt)", packageName: "Solo", remainingCredits: 0 },
      ],
      [],
    ]);

    const text = await run(db);

    expect(text).toContain("💳 Solo (Solo.Aa) A — no active packages");
    expect(text).toContain("🗂 2 finished packages hidden");
    // The student still rides the report link even with nothing visible.
    const url = new URL(text.split("\n").find((line) => line.startsWith("https://"))!);
    expect(url.searchParams.getAll("student")).toEqual([KEY]);
  });

  it("skips the pair query entirely when every package is positive", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [soloStudent()] } as never,
    );
    // A sentinel entry sits behind the packages select; it must survive the
    // command untouched — consuming it means the pair query ran needlessly.
    const sentinel = [{ wiseClassId: "never-read", wiseStudentId: "never-read" }];
    const { db, queue } = makeDb([
      [{ studentKey: KEY, wiseClassId: "class-live", wiseStudentId: "stu_1", subject: "Math", packageName: "Solo", remainingCredits: 3 }],
      sentinel,
    ]);

    const text = await run(db);

    expect(queue).toEqual([sentinel]);
    expect(text).toContain("• Math: 3");
    expect(text).not.toContain("🗂");
  });
});

describe("CRED-BOT-G1 staff-chat gate", () => {
  it.each([
    ["family audience", [{ audience: "family" }]],
    ["no settings row", []],
    ["unexpected audience value", [{ audience: "weird" }]],
  ])("stays completely silent in a group with %s", async (_label, settingsRows) => {
    const d = groupDeps();
    const { db } = makeDb([settingsRows]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/credit Copter.Th", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: true, action: "credit_silent_audience" });
    expect(d.reply).not.toHaveBeenCalled();
    expect(d.push).not.toHaveBeenCalled();
    expect(searchCurrentLineStudentsWithSnapshot).not.toHaveBeenCalled();
  });

  it("even /credit help is silent outside a staff chat", async () => {
    const d = groupDeps();
    const { db } = makeDb([[{ audience: "family" }]]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/credit", replyToken: "tok" },
      d,
    );

    expect(result.action).toBe("credit_silent_audience");
    expect(d.reply).not.toHaveBeenCalled();
  });

  it("answers balances in a staff chat", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [student()] } as never,
    );
    const d = groupDeps();
    const { db } = makeDb([[{ audience: "staff" }], SIBLING_ROWS, PACKAGE_ROWS]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/credit Copter.Th", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: true, action: "credit_balance" });
    expect(d.reply).toHaveBeenCalledTimes(1);
    expect(d.reply.mock.calls[0][0].text).toContain("4.5 credits left");
  });
});

describe("/credit setup", () => {
  it("turns the digest on for a staff group", async () => {
    const d = groupDeps();
    const { db, updates } = makeDb([[{ audience: "staff" }]]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/credit setup", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: true, action: "credit_digest_on" });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      creditDigestEnabled: true,
      creditDigestSetByLineUserId: ADMIN,
    });
    expect(d.reply.mock.calls[0][0].text).toContain("Daily credit digest ON");
  });

  it("turns the digest off with `setup off`", async () => {
    const d = groupDeps();
    const { db, updates } = makeDb([[{ audience: "staff" }]]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/credit setup off", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: true, action: "credit_digest_off" });
    expect(updates[0]).toMatchObject({ creditDigestEnabled: false });
    expect(d.reply.mock.calls[0][0].text).toContain("OFF");
  });

  it("refuses setup in a DM and points at the group", async () => {
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db, updates } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/credit setup" },
      dmDeps(push),
    );

    expect(result.action).toBe("credit_setup_dm_refused");
    expect(updates).toHaveLength(0);
    expect(push.mock.calls[0][0].text).toContain("staff group");
  });

  it("setup in a family group is silent and writes nothing", async () => {
    const d = groupDeps();
    const { db, updates } = makeDb([[{ audience: "family" }]]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/credit setup", replyToken: "tok" },
      d,
    );

    expect(result.action).toBe("credit_silent_audience");
    expect(updates).toHaveLength(0);
    expect(d.reply).not.toHaveBeenCalled();
  });
});

describe("/schedule keeps working alongside /credit", () => {
  it("a /credit command never reaches the schedule flow", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: null, rows: [] } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/credit Copter.Th" },
      dmDeps(push),
    );

    // Credit's no-snapshot copy, not the schedule bot's.
    expect(result.action).toBe("credit_no_snapshot");
    expect(push.mock.calls[0][0].text).toContain("balances");
  });
});
