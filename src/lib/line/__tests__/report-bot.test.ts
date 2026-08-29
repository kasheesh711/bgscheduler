// ----------------------------------------------------------------------------
// Report-bot suite.
//
// The assertions that matter: non-admins and non-staff chats get NOTHING (not
// even help), invalid windows are refused before any lookup runs, and the
// link carries the exact keys/dates the Parent Report page parses — with the
// feedback param absent so the page's default (included) applies.
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
import { handleReportCommand } from "@/lib/line/report-bot";
import type { Database } from "@/lib/db";

const ADMIN = "Uadmin000000000000000000000000001";
const OUTSIDER = "Uoutsider000000000000000000000001";
const GROUP = "Cgroup000000000000000000000000001";

const NOW = new Date("2026-08-05T03:00:00Z"); // 2026-08-05 10:00 Bangkok
const SNAP = { id: "snap-1", generatedAt: NOW };

/** Chainable Drizzle stand-in: one queue entry per awaited select chain. */
function makeDb(selectResults: unknown[][]) {
  const queue = [...selectResults];

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
  };

  return { db: db as unknown as Database, queue };
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

function dmDeps(push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} })) {
  return { push, now: () => NOW, baseUrl: "https://example.test", ttlDays: 30 };
}

function groupDeps(
  reply = vi.fn().mockResolvedValue({ sentMessageId: "m", response: {} }),
  push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} }),
) {
  return { reply, push, now: () => NOW, baseUrl: "https://example.test", ttlDays: 30 };
}

function linkFrom(text: string): URL {
  return new URL(text.split("\n").find((line) => line.startsWith("https://"))!);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINE_SCHEDULE_BOT_ADMIN_IDS = ADMIN;
});

describe("admin gate inheritance", () => {
  it("DM: a non-admin /report is silently unhandled and looks nothing up", async () => {
    const push = vi.fn();
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: OUTSIDER, text: "/report Copter.Th" },
      dmDeps(push),
    );

    expect(result).toEqual({ handled: false });
    expect(push).not.toHaveBeenCalled();
    expect(searchCurrentLineStudentsWithSnapshot).not.toHaveBeenCalled();
  });

  it("group: a non-admin /report gets no reply at all", async () => {
    const d = groupDeps();
    const { db } = makeDb([]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: OUTSIDER, text: "/report Copter.Th", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: false });
    expect(d.reply).not.toHaveBeenCalled();
    expect(d.push).not.toHaveBeenCalled();
  });
});

describe("DM report link", () => {
  it("fans out to siblings and links the trailing-30-day window with feedback on", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [student()] } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([SIBLING_ROWS]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/report Copter.Th" },
      dmDeps(push),
    );

    expect(result).toEqual({ handled: true, action: "report_link" });
    expect(push).toHaveBeenCalledTimes(1);
    const text: string = push.mock.calls[0][0].text;

    // Queried student leads; the sibling follows.
    expect(text.indexOf("📄 Teethad (Copter.Th)")).toBeLessThan(
      text.indexOf("📄 Jidapa (Jasmine.Th)"),
    );
    expect(text).toContain("Report (last 30 days, 6/7/2026 – 5/8/2026):");

    const url = linkFrom(text);
    expect(url.pathname).toBe("/student-report/report");
    expect(url.searchParams.getAll("student")).toEqual([
      "teethad (copter.th) thamprida::kanokwan thamprida",
      "jidapa (jasmine.th) thamprida::kanokwan thamprida",
    ]);
    expect(url.searchParams.get("from")).toBe("2026-07-06");
    expect(url.searchParams.get("to")).toBe("2026-08-05");
    // Absent feedback param = the page's default: tutor feedback included.
    expect(url.searchParams.has("feedback")).toBe(false);
  });

  it("honors a trailing-days argument", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [student()] } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([SIBLING_ROWS]);

    await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/report Copter.Th 60" },
      dmDeps(push),
    );

    const text: string = push.mock.calls[0][0].text;
    expect(text).toContain("Report (last 60 days, 6/6/2026 – 5/8/2026):");
    const url = linkFrom(text);
    expect(url.searchParams.get("from")).toBe("2026-06-06");
    expect(url.searchParams.get("to")).toBe("2026-08-05");
  });

  it("honors an explicit from/to range", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [student()] } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([SIBLING_ROWS]);

    await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/report Copter.Th 2026-08-01 2026-08-20" },
      dmDeps(push),
    );

    const text: string = push.mock.calls[0][0].text;
    expect(text).toContain("Report (1/8/2026 – 20/8/2026):");
    expect(text).not.toContain("last");
    const url = linkFrom(text);
    expect(url.searchParams.get("from")).toBe("2026-08-01");
    expect(url.searchParams.get("to")).toBe("2026-08-20");
  });

  it.each([
    ["/report Copter.Th 0", "zero days"],
    ["/report Copter.Th 366", "days above the cap"],
    ["/report Copter.Th 2026-08-20 2026-08-01", "a reversed range"],
    ["/report Copter.Th 2026-02-31 2026-03-05", "an impossible calendar date"],
  ])("refuses %s (%s) before any lookup", async (text) => {
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text },
      dmDeps(push),
    );

    expect(result).toEqual({ handled: true, action: "report_invalid_range" });
    expect(push.mock.calls[0][0].text).toContain("That range doesn't work.");
    expect(searchCurrentLineStudentsWithSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["/report Two Words", "a multi-word query"],
    ["/report Copter.Th 2026-8-1", "an unpadded date"],
    ["/report Copter.Th 2026-08-01", "a lone date"],
  ])("answers %s (%s) with help", async (text) => {
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text },
      dmDeps(push),
    );

    expect(result).toEqual({ handled: true, action: "report_help" });
    expect(push.mock.calls[0][0].text).toContain("/report Aadhu.Sr");
    expect(searchCurrentLineStudentsWithSnapshot).not.toHaveBeenCalled();
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
      { db, lineUserId: ADMIN, text: "/report Thamprida" },
      dmDeps(push),
    );

    expect(result.action).toBe("report_not_exact");
    const text: string = push.mock.calls[0][0].text;
    expect(text).toContain("isn't an exact code. Try /report");
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
      { db, lineUserId: ADMIN, text: "/report Copter.Th" },
      dmDeps(push),
    );

    expect(result.action).toBe("report_no_snapshot");
    expect(push.mock.calls[0][0].text).toContain("can't look up students");
  });

  it("does not fan out when the parent name is blank", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [student({ parentName: "" })] } as never,
    );
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    // No sibling select may run — the queue stays untouched.
    const { db, queue } = makeDb([]);

    await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/report Copter.Th" },
      dmDeps(push),
    );

    expect(queue).toHaveLength(0);
    const text: string = push.mock.calls[0][0].text;
    expect(linkFrom(text).searchParams.getAll("student")).toHaveLength(1);
    expect(text.match(/📄 /g)).toHaveLength(1);
  });

  it("caps the link at 8 students and says how many were dropped", async () => {
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
    const { db } = makeDb([siblings]);

    await handleReportCommand({
      db,
      lineUserId: ADMIN,
      command: "Kid0.Fam",
      surface: { kind: "dm" },
      respond,
      now: () => NOW,
      baseUrl: "https://example.test",
    });

    const text: string = respond.mock.calls[0][0];
    expect(linkFrom(text).searchParams.getAll("student")).toHaveLength(8);
    expect(text).toContain("first 8 students (+2 more)");
  });

  it("help lists the report command forms", async () => {
    const push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
    const { db } = makeDb([]);

    const result = await handleScheduleBotCommand(
      { db, lineUserId: ADMIN, text: "/report" },
      dmDeps(push),
    );

    expect(result).toEqual({ handled: true, action: "report_help" });
    const text: string = push.mock.calls[0][0].text;
    expect(text).toContain("Parent Report print link");
    expect(text).toContain("exact date range");
  });
});

describe("REP-BOT-G1 staff-chat gate", () => {
  it.each([
    ["family audience", [{ audience: "family" }]],
    ["no settings row", []],
    ["unexpected audience value", [{ audience: "weird" }]],
  ])("stays fully silent in a group with %s", async (_label, audienceRows) => {
    const d = groupDeps();
    const { db } = makeDb([audienceRows]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/report Copter.Th", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: true, action: "report_silent_audience" });
    expect(d.reply).not.toHaveBeenCalled();
    expect(d.push).not.toHaveBeenCalled();
    expect(searchCurrentLineStudentsWithSnapshot).not.toHaveBeenCalled();
  });

  it("even bare /report help is silent outside a staff chat", async () => {
    const d = groupDeps();
    const { db } = makeDb([[{ audience: "family" }]]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/report", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: true, action: "report_silent_audience" });
    expect(d.reply).not.toHaveBeenCalled();
  });

  it("answers with the link in a staff chat", async () => {
    vi.mocked(searchCurrentLineStudentsWithSnapshot).mockResolvedValue(
      { snapshot: SNAP, rows: [student()] } as never,
    );
    const d = groupDeps();
    const { db } = makeDb([[{ audience: "staff" }], SIBLING_ROWS]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/report Copter.Th", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: true, action: "report_link" });
    expect(d.reply).toHaveBeenCalledTimes(1);
    const text: string = d.reply.mock.calls[0][0].text;
    expect(linkFrom(text).pathname).toBe("/student-report/report");
  });

  it("answers bare /report with help in a staff chat", async () => {
    const d = groupDeps();
    const { db } = makeDb([[{ audience: "staff" }]]);

    const result = await handleScheduleBotGroupCommand(
      { db, groupId: GROUP, lineUserId: ADMIN, text: "/report", replyToken: "tok" },
      d,
    );

    expect(result).toEqual({ handled: true, action: "report_help" });
    expect(d.reply).toHaveBeenCalledTimes(1);
  });
});
