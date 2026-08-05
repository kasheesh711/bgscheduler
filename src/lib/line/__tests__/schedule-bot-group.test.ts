// ----------------------------------------------------------------------------
// Group schedule-bot security suite.
//
// The default path now replies into the conversation the command came from, so
// the requester is the recipient and there is no third party to mis-address.
// The assertions therefore split in two:
//   • nothing is EVER sent to a parent unless the explicit `send` verb is used
//   • non-admins get no reply at all, and trigger no lookups
//
// Reply and push are both injected fakes — nothing here reaches api.line.me.
// ----------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/line/student-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/line/student-links")>();
  return { ...actual, searchCurrentLineStudents: vi.fn() };
});
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
import { handleScheduleBotGroupCommand } from "@/lib/line/schedule-bot-group";
import { detectTrigger, exactCodeMatches } from "@/lib/line/schedule-bot-command";
import type { Database } from "@/lib/db";

const ADMIN = "Uadmin000000000000000000000000001";
const PARENT = "Uparent00000000000000000000000001";
const GROUP = "Cgroup000000000000000000000000001";
const NOW = new Date("2026-08-05T03:00:00Z");

const SELF_MENTION = { mention: { mentionees: [{ index: 0, length: 9, type: "user", isSelf: true }] } };

function makeDb(selectResults: unknown[][] = []) {
  const queue = [...selectResults];
  const inserts: Array<{ row: unknown }> = [];
  const deletes: unknown[] = [];

  function chain(result: unknown[]) {
    const node: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "limit", "orderBy"]) node[m] = () => node;
    node.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
    node.catch = () => node;
    return node;
  }

  const db = {
    select: () => chain(queue.shift() ?? []),
    insert: () => ({
      values: (row: unknown) => {
        inserts.push({ row });
        const node: Record<string, unknown> = { onConflictDoUpdate: () => node };
        node.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
        node.catch = () => node;
        return node;
      },
    }),
    delete: () => ({
      where: (c: unknown) => { deletes.push(c); return Promise.resolve(undefined); },
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

function schedule(sessionCount: number) {
  return {
    student: {
      studentKey: "aadhiya srisethi::nok srisethi", wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi", parentName: "Nok Srisethi",
      code: "Aadhu.Sr", shortName: "Aadhu",
    },
    monthKey: "2026-08", monthLabel: "August 2026",
    sessions: Array.from({ length: sessionCount }, (_, i) => ({ wiseSessionId: `s${i}` })),
    generatedAt: NOW.toISOString(),
  };
}

function deps(
  reply = vi.fn().mockResolvedValue({ sentMessageId: "m", response: {} }),
  push = vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} }),
) {
  return { reply, push, now: () => NOW, baseUrl: "https://example.test", ttlDays: 30 };
}

function call(
  db: Database,
  d: ReturnType<typeof deps>,
  text: string,
  { lineUserId = ADMIN, message = {} as Record<string, unknown> } = {},
) {
  return handleScheduleBotGroupCommand(
    { db, groupId: GROUP, lineUserId, text, replyToken: "tok", message },
    d,
  );
}

/** Every outbound message the bot attempted, via either channel. */
function sent(d: ReturnType<typeof deps>) {
  return [...d.reply.mock.calls, ...d.push.mock.calls];
}

const LINK = { token: "tok_abc", expiresAt: new Date("2026-09-04T03:00:00Z"), id: "link-1" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINE_SCHEDULE_BOT_ADMIN_IDS = ADMIN;
});

describe("detectTrigger", () => {
  it("accepts the /schedule prefix, case-insensitively", () => {
    expect(detectTrigger("/schedule Aadhu.Sr", [])).toEqual({ kind: "prefix", command: "Aadhu.Sr" });
    expect(detectTrigger("/SCHEDULE Aadhu.Sr", [])).toEqual({ kind: "prefix", command: "Aadhu.Sr" });
    expect(detectTrigger("  /schedule   Aadhu.Sr  ", [])).toEqual({ kind: "prefix", command: "Aadhu.Sr" });
  });

  it("still accepts a mobile @-mention", () => {
    const m = [{ index: 0, length: 9, type: "user", isSelf: true }];
    expect(detectTrigger("@BeGifted Aadhu.Sr", m)).toEqual({ kind: "mention", command: "Aadhu.Sr" });
  });

  it("ignores ordinary conversation", () => {
    // Regression: the desktop LINE client cannot produce a bot mention at all,
    // so a mention-only gate was unsatisfiable there and the bot never fired.
    expect(detectTrigger("Aadhu.Sr", []).kind).toBe("none");
    expect(detectTrigger("can we move Tuesday", []).kind).toBe("none");
    expect(detectTrigger("@BeGifted Aadhu.Sr", []).kind).toBe("none");
  });
});

describe("GRP-BOT-01 must address the bot", () => {
  it("ignores a group message with neither prefix nor mention", async () => {
    const d = deps();
    const { db } = makeDb();
    expect(await call(db, d, "Aadhu.Sr")).toEqual({ handled: false });
    expect(sent(d)).toHaveLength(0);
    expect(searchCurrentLineStudents).not.toHaveBeenCalled();
  });

  it("ignores a mention of another member", async () => {
    const d = deps();
    const { db } = makeDb();
    const result = await call(db, d, "@Nok Aadhu.Sr", {
      message: { mention: { mentionees: [{ index: 0, length: 4, type: "user", userId: PARENT }] } },
    });
    expect(result).toEqual({ handled: false });
    expect(sent(d)).toHaveLength(0);
  });
});

describe("GRP-BOT-02 sender allowlist", () => {
  it("stays completely silent for a parent in the group", async () => {
    const d = deps();
    const { db } = makeDb();
    const result = await call(db, d, "/schedule Aadhu.Sr", { lineUserId: PARENT });

    expect(result).toEqual({ handled: false });
    expect(sent(d)).toHaveLength(0);
    expect(searchCurrentLineStudents).not.toHaveBeenCalled();
  });

  it("is disabled entirely when the allowlist is unset", async () => {
    delete process.env.LINE_SCHEDULE_BOT_ADMIN_IDS;
    const d = deps();
    const { db } = makeDb();
    expect(await call(db, d, "/schedule Aadhu.Sr")).toEqual({ handled: false });
    expect(sent(d)).toHaveLength(0);
  });
});

describe("GRP-BOT-03 exact code only", () => {
  it("refuses a partial code even when search returns one student", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    const d = deps();
    const { db, inserts } = makeDb();

    const result = await call(db, d, "/schedule aadhu");

    expect(result.action).toBe("not_exact");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(d.reply.mock.calls[0][0].text).toContain("isn't an exact code");
  });

  it("reports an unknown code without listing anyone", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([] as never);
    const d = deps();
    const { db } = makeDb();
    const result = await call(db, d, "/schedule Aadhu.Sn");
    expect(result.action).toBe("not_exact");
    expect(d.reply.mock.calls[0][0].text).toBe('No student matches "Aadhu.Sn".');
  });

  it("matches the code case-insensitively", () => {
    const rows = [student()];
    expect(exactCodeMatches("aadhu.sr", rows)).toHaveLength(1);
    expect(exactCodeMatches("AADHU.SR", rows)).toHaveLength(1);
    expect(exactCodeMatches("aadhu", rows)).toHaveLength(0);
  });
});

/** Select-queue shorthand: [audience lookup, has-seen lookup]. */
const UNREGISTERED: unknown[][] = [[]];
const STAFF_GROUP = (seen = false): unknown[][] => [[{ audience: "staff" }], seen ? [{ id: "prior" }] : []];
const FAMILY_GROUP = (seen = false): unknown[][] => [[{ audience: "family" }], seen ? [{ id: "prior" }] : []];

describe("GRP-BOT-06 per-group audience", () => {
  beforeEach(() => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(12) as never);
    vi.mocked(mintStudentScheduleLink).mockResolvedValue(LINK as never);
  });

  it("asks which kind of chat it is before posting anything", async () => {
    const d = deps();
    const { db } = makeDb(UNREGISTERED);

    const result = await call(db, d, "/schedule Aadhu.Sr");

    expect(result.action).toBe("awaiting_setup");
    // Nothing was posted and no link exists yet.
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
    const prompt = d.reply.mock.calls[0][0].text as string;
    expect(prompt).toContain("FAMILY");
    expect(prompt).toContain("STAFF");
    expect(prompt).toContain("Aadhu.Sr");
    expect(prompt).toContain("12 classes");
  });

  it("accepts a BARE STAFF reply, exactly as the prompt asks", async () => {
    // Regression, seen in production: the prompt says "Reply FAMILY or STAFF",
    // but every message needed the /schedule prefix, so a bare STAFF was
    // silently dropped and the setup question just repeated.
    const d = deps();
    const { db, inserts } = makeDb([
      [{ expiresAt: new Date(NOW.getTime() + 60_000) }],   // hasPendingQuestion
      [{
        lineUserId: ADMIN, scopeKey: `group:${GROUP}`, studentKey: "k", wiseStudentId: "stu_1",
        studentName: "Teethad (Copter.Th) Thamprida", monthKey: "2026-08", sessionCount: 6,
        expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW,
      }],
    ]);

    const result = await call(db, d, "STAFF");

    expect(result.action).toBe("sent");
    expect(inserts.some((e) => (e.row as Record<string, unknown>).audience === "staff")).toBe(true);
  });

  it("accepts a bare YES when a confirmation is outstanding", async () => {
    const d = deps();
    const { db } = makeDb([
      [{ expiresAt: new Date(NOW.getTime() + 60_000) }],
      [{
        lineUserId: ADMIN, scopeKey: `group:${GROUP}`, studentKey: "k", wiseStudentId: "stu_1",
        studentName: "Teethad (Copter.Th) Thamprida", monthKey: "2026-08", sessionCount: 6,
        expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW,
      }],
      [{ audience: "staff" }],
    ]);

    expect((await call(db, d, "yes")).action).toBe("sent");
  });

  it("ignores a bare answer word with no pending question", async () => {
    // Ordinary conversation must never be read as an answer.
    const d = deps();
    const { db } = makeDb([[]]); // no pending row
    expect(await call(db, d, "ok")).toEqual({ handled: false });
    expect(sent(d)).toHaveLength(0);
  });

  it("ignores a bare answer word from a non-admin", async () => {
    const d = deps();
    const { db } = makeDb();
    expect(await call(db, d, "STAFF", { lineUserId: PARENT })).toEqual({ handled: false });
    expect(sent(d)).toHaveLength(0);
  });

  it("registers the chat and posts the Thai template on FAMILY", async () => {
    const d = deps();
    const { db, inserts } = makeDb([[{
      lineUserId: ADMIN, scopeKey: `group:${GROUP}`, studentKey: "k", wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi", monthKey: "2026-08", sessionCount: 12,
      expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW,
    }]]);

    const result = await call(db, d, "/schedule FAMILY");

    expect(result.action).toBe("sent");
    const text = d.reply.mock.calls[0][0].text as string;
    expect(text).toContain("น้องAadhu");
    expect(text).not.toContain("Srisethi");
    // The audience was persisted.
    expect(inserts.some((e) => (e.row as Record<string, unknown>).audience === "family")).toBe(true);
  });

  it("registers the chat and posts the English template on STAFF", async () => {
    const d = deps();
    const { db, inserts } = makeDb([[{
      lineUserId: ADMIN, scopeKey: `group:${GROUP}`, studentKey: "k", wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi", monthKey: "2026-08", sessionCount: 12,
      expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW,
    }]]);

    const result = await call(db, d, "/schedule STAFF");

    expect(result.action).toBe("sent");
    const text = d.reply.mock.calls[0][0].text as string;
    expect(text).toContain("12 classes");
    expect(text).toContain("https://example.test/schedule/tok_abc");
    expect(inserts.some((e) => (e.row as Record<string, unknown>).audience === "staff")).toBe(true);
  });

  it("changes a registered chat's audience with setup", async () => {
    const d = deps();
    const { db, inserts } = makeDb();
    const result = await call(db, d, "/schedule setup staff");
    expect(result.action).toBe("audience_set");
    expect(inserts.some((e) => (e.row as Record<string, unknown>).audience === "staff")).toBe(true);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });
});

describe("GRP-BOT-04 confirm each new student in a chat", () => {
  beforeEach(() => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(12) as never);
    vi.mocked(mintStudentScheduleLink).mockResolvedValue(LINK as never);
  });

  it("asks before a student this chat has not received before", async () => {
    // The guard against a VALID code typed in the WRONG family's group, which
    // exact-code matching cannot catch.
    const d = deps();
    const { db } = makeDb(FAMILY_GROUP(false));

    const result = await call(db, d, "/schedule Aadhu.Sr");

    expect(result.action).toBe("awaiting_confirm");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
    expect(d.reply.mock.calls[0][0].text).toContain("12 classes");
  });

  it("posts immediately for a student this chat has already received", async () => {
    const d = deps();
    const { db } = makeDb(STAFF_GROUP(true));

    const result = await call(db, d, "/schedule Aadhu.Sr");

    expect(result.action).toBe("sent");
    expect(d.reply.mock.calls[0][0].text).toContain("https://example.test/schedule/tok_abc");
  });

  it("posts to the chat, never to a user id", async () => {
    const d = deps();
    const { db } = makeDb(STAFF_GROUP(true));
    await call(db, d, "/schedule Aadhu.Sr");
    for (const [arg] of d.push.mock.calls) expect(arg.to).toBe(GROUP);
    expect(vi.mocked(mintStudentScheduleLink).mock.calls[0][1]).toMatchObject({ sentToGroupId: GROUP });
  });

  it("works via a mobile mention too", async () => {
    const d = deps();
    const { db } = makeDb(STAFF_GROUP(true));
    const result = await call(db, d, "@BeGifted Aadhu.Sr", { message: SELF_MENTION });
    expect(result.action).toBe("sent");
  });

  it("accepts an explicit month", async () => {
    const d = deps();
    const { db } = makeDb(STAFF_GROUP(true));
    await call(db, d, "/schedule Aadhu.Sr 2026-09");
    expect(vi.mocked(getStudentMonthlySchedule).mock.calls[0][1]).toMatchObject({ monthKey: "2026-09" });
  });

  it("falls back to a push at the chat when the reply token has expired", async () => {
    const d = deps(vi.fn().mockRejectedValue(new Error("Invalid reply token")));
    const { db } = makeDb(STAFF_GROUP(true));
    const result = await call(db, d, "/schedule Aadhu.Sr");
    expect(result.action).toBe("sent");
    expect(d.push.mock.calls[0][0].to).toBe(GROUP);
  });

  it("reports failure rather than claiming success when both channels fail", async () => {
    const d = deps(vi.fn().mockRejectedValue(new Error("no")), vi.fn().mockRejectedValue(new Error("no")));
    const { db } = makeDb(STAFF_GROUP(true));
    expect((await call(db, d, "/schedule Aadhu.Sr")).action).toBe("send_failed");
  });

  it("refuses a YES in a chat that was never set up", async () => {
    const d = deps();
    const { db } = makeDb([[{
      lineUserId: ADMIN, scopeKey: `group:${GROUP}`, studentKey: "k", wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi", monthKey: "2026-08", sessionCount: 12,
      expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW,
    }], []]);

    const result = await call(db, d, "/schedule yes");
    expect(result.action).toBe("awaiting_setup");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });
});

describe("GRP-BOT-04 send verb still confirms", () => {
  beforeEach(() => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(12) as never);
    vi.mocked(mintStudentScheduleLink).mockResolvedValue(LINK as never);
  });

  it("asks before the first send of a student into this chat", async () => {
    const d = deps();
    const { db, inserts } = makeDb([[{ audience: "staff" }]]); // registered, no prior send

    const result = await call(db, d, "/schedule Aadhu.Sr send");

    expect(result.action).toBe("awaiting_confirm");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(d.reply.mock.calls[0][0].text).toContain("12 classes");
  });

  it("sends nothing on YES when the pending row has lapsed", async () => {
    const d = deps();
    const { db } = makeDb([[{
      lineUserId: ADMIN, scopeKey: `group:${GROUP}`, studentKey: "k", wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi", monthKey: "2026-08", sessionCount: 12,
      expiresAt: new Date(NOW.getTime() - 1000), createdAt: NOW,
    }]]);
    const result = await call(db, d, "/schedule yes");
    expect(result.action).toBe("pending_expired");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("drops the pending row on NO", async () => {
    const d = deps();
    const { db, deletes } = makeDb();
    expect((await call(db, d, "/schedule no")).action).toBe("cancelled");
    expect(deletes).toHaveLength(1);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("uses the Thai parent template in a family chat once confirmed", async () => {
    const d = deps();
    const { db } = makeDb([[{
      lineUserId: ADMIN, scopeKey: `group:${GROUP}`, studentKey: "k", wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi", monthKey: "2026-08", sessionCount: 12,
      expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW,
    }], [{ audience: "family" }]]);

    const result = await call(db, d, "/schedule yes");
    expect(result.action).toBe("sent");
    const text = d.reply.mock.calls[0][0].text as string;
    expect(text).toContain("น้องAadhu");
    expect(text).not.toContain("Srisethi");
  });
});

describe("GRP-BOT-05 non-empty month", () => {
  it("refuses to hand back a blank calendar", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(0) as never);
    const d = deps();
    const { db } = makeDb();

    expect((await call(db, d, "/schedule Aadhu.Sr")).action).toBe("empty_month");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });
});

describe("command parsing", () => {
  it("explains itself when triggered with nothing else", async () => {
    const d = deps();
    const { db } = makeDb();
    const result = await call(db, d, "/schedule");
    expect(result.action).toBe("help");
    expect(searchCurrentLineStudents).not.toHaveBeenCalled();
  });

  it("replies with help rather than going silent on an unparseable command", async () => {
    const d = deps();
    const { db } = makeDb();
    const result = await call(db, d, "/schedule can we move Tuesday please");
    expect(result.action).toBe("help");
    expect(sent(d)).toHaveLength(1);
  });
});
