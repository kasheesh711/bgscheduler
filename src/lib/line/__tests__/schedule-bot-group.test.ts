// ----------------------------------------------------------------------------
// Group schedule-bot security suite.
//
// The bot posts a child's schedule into a chat containing other people, so the
// assertion in nearly every case is "zero messages sent". Reply and push are
// both injected fakes — nothing here can reach api.line.me.
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
import {
  exactCodeMatches,
  handleScheduleBotGroupCommand,
} from "@/lib/line/schedule-bot-group";
import type { Database } from "@/lib/db";

const ADMIN = "Uadmin000000000000000000000000001";
const PARENT = "Uparent00000000000000000000000001";
const GROUP = "Cgroup000000000000000000000000001";
const NOW = new Date("2026-08-05T03:00:00Z");

const SELF_MENTION = { mention: { mentionees: [{ index: 0, length: 9, type: "user", isSelf: true }] } };

/** Chainable Drizzle stand-in; selects are consumed in order. */
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
      studentKey: "aadhiya srisethi::nok srisethi",
      wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi",
      parentName: "Nok Srisethi",
      code: "Aadhu.Sr",
      shortName: "Aadhu",
    },
    monthKey: "2026-08",
    monthLabel: "August 2026",
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
  {
    lineUserId = ADMIN,
    message = SELF_MENTION as Record<string, unknown>,
  }: { lineUserId?: string; message?: Record<string, unknown> } = {},
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINE_SCHEDULE_BOT_ADMIN_IDS = ADMIN;
});

describe("GRP-BOT-01 self-mention required", () => {
  it("ignores a group message that does not mention the bot", async () => {
    const d = deps();
    const { db } = makeDb();
    const result = await call(db, d, "Aadhu.Sr", { message: {} });

    expect(result).toEqual({ handled: false });
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
    const result = await call(db, d, "@BeGifted Aadhu.Sr", { lineUserId: PARENT });

    expect(result).toEqual({ handled: false });
    // No reply at all: a parent must not learn the bot exists…
    expect(sent(d)).toHaveLength(0);
    // …nor be able to probe the student roster with it.
    expect(searchCurrentLineStudents).not.toHaveBeenCalled();
  });

  it("is disabled entirely when the allowlist is unset", async () => {
    delete process.env.LINE_SCHEDULE_BOT_ADMIN_IDS;
    const d = deps();
    const { db } = makeDb();

    expect(await call(db, d, "@BeGifted Aadhu.Sr")).toEqual({ handled: false });
    expect(sent(d)).toHaveLength(0);
  });
});

describe("GRP-BOT-03 exact code only", () => {
  it("refuses a partial code even when search returns exactly one student", async () => {
    // The DM path would accept this; in a group a near-miss must not send.
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    const d = deps();
    const { db, inserts } = makeDb();

    const result = await call(db, d, "@BeGifted aadhu");

    expect(result.action).toBe("not_exact");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(d.reply.mock.calls[0][0].text).toContain("isn't an exact code");
    expect(d.reply.mock.calls[0][0].text).toContain("Aadhu.Sr");
  });

  it("refuses when two students share the queried code", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([
      student(),
      student({ studentKey: "b", studentName: "Bee (Aadhu.Sr) Other" }),
    ] as never);
    const d = deps();
    const { db } = makeDb();

    expect((await call(db, d, "@BeGifted Aadhu.Sr")).action).toBe("not_exact");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("reports an unknown code without listing anyone", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([] as never);
    const d = deps();
    const { db } = makeDb();

    const result = await call(db, d, "@BeGifted Aadhu.Sn");
    expect(result.action).toBe("not_exact");
    expect(d.reply.mock.calls[0][0].text).toBe('No student matches "Aadhu.Sn".');
  });

  it("matches the code case-insensitively", () => {
    const rows = [student()];
    expect(exactCodeMatches("aadhu.sr", rows)).toHaveLength(1);
    expect(exactCodeMatches("AADHU.SR", rows)).toHaveLength(1);
    expect(exactCodeMatches("aadhu", rows)).toHaveLength(0);
    expect(exactCodeMatches("", rows)).toHaveLength(0);
  });
});

describe("GRP-BOT-04 confirm on first sight in a group", () => {
  beforeEach(() => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(12) as never);
  });

  it("asks before the first send of a student into this group", async () => {
    const d = deps();
    const { db, inserts } = makeDb([[]]); // no prior send for this (group, student)

    const result = await call(db, d, "@BeGifted Aadhu.Sr");

    expect(result.action).toBe("awaiting_confirm");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1); // the pending row only

    const prompt = d.reply.mock.calls[0][0].text as string;
    expect(prompt).toContain("Aadhu.Sr");
    expect(prompt).toContain("August 2026");
    expect(prompt).toContain("12 classes");
  });

  it("sends straight away for a student this group already received", async () => {
    vi.mocked(mintStudentScheduleLink).mockResolvedValue({
      token: "tok_abc", expiresAt: new Date("2026-09-04T03:00:00Z"), id: "link-1",
    } as never);
    const d = deps();
    const { db } = makeDb([[{ id: "prior-send" }]]);

    const result = await call(db, d, "@BeGifted Aadhu.Sr");

    expect(result.action).toBe("sent");
    expect(d.reply.mock.calls[0][0].text).toContain("https://example.test/schedule/tok_abc");
  });

  it("asks again for a DIFFERENT student in the same group", async () => {
    // This is the guard against a right code typed in the wrong family's chat.
    const d = deps();
    const { db } = makeDb([[]]);

    expect((await call(db, d, "@BeGifted Aadhu.Sr")).action).toBe("awaiting_confirm");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("sends nothing on YES when no pending row exists", async () => {
    const d = deps();
    const { db } = makeDb([[]]);

    const result = await call(db, d, "@BeGifted yes");
    expect(result.action).toBe("pending_expired");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("sends nothing on YES when the pending row has lapsed", async () => {
    const d = deps();
    const { db } = makeDb([[{
      lineUserId: ADMIN,
      scopeKey: `group:${GROUP}`,
      studentKey: "k", wiseStudentId: "stu_1",
      studentName: "Aadhiya (Aadhu.Sr) Srisethi",
      monthKey: "2026-08",
      expiresAt: new Date(NOW.getTime() - 1000),
      createdAt: NOW,
    }]]);

    const result = await call(db, d, "@BeGifted yes");
    expect(result.action).toBe("pending_expired");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("drops the pending row on NO", async () => {
    const d = deps();
    const { db, deletes } = makeDb();

    const result = await call(db, d, "@BeGifted no");
    expect(result.action).toBe("cancelled");
    expect(deletes).toHaveLength(1);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });
});

describe("GRP-BOT-05 non-empty month", () => {
  it("refuses to post a blank calendar", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(0) as never);
    const d = deps();
    const { db, inserts } = makeDb();

    const result = await call(db, d, "@BeGifted Aadhu.Sr");

    expect(result.action).toBe("empty_month");
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});

describe("delivery", () => {
  beforeEach(() => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(12) as never);
    vi.mocked(mintStudentScheduleLink).mockResolvedValue({
      token: "tok_abc", expiresAt: new Date("2026-09-04T03:00:00Z"), id: "link-1",
    } as never);
  });

  it("posts via the reply token and records the send against the group", async () => {
    const d = deps();
    const { db, inserts } = makeDb([[{ id: "prior" }]]);

    await call(db, d, "@BeGifted Aadhu.Sr");

    expect(d.reply).toHaveBeenCalledTimes(1);
    expect(d.push).not.toHaveBeenCalled();
    // Nickname only — a group may contain more than one family.
    expect(d.reply.mock.calls[0][0].text).toContain("น้องAadhu");
    expect(d.reply.mock.calls[0][0].text).not.toContain("Srisethi");

    const audit = inserts.map((entry) => entry.row as Record<string, unknown>);
    expect(audit.some((row) => row.groupId === GROUP && row.linkId === "link-1")).toBe(true);
    expect(vi.mocked(mintStudentScheduleLink).mock.calls[0][1]).toMatchObject({
      sentToGroupId: GROUP,
    });
  });

  it("falls back to a push at the group when the reply token has expired", async () => {
    const reply = vi.fn().mockRejectedValue(new Error("Invalid reply token"));
    const d = deps(reply);
    const { db } = makeDb([[{ id: "prior" }]]);

    const result = await call(db, d, "@BeGifted Aadhu.Sr");

    expect(result.action).toBe("sent");
    expect(d.push).toHaveBeenCalledTimes(1);
    expect(d.push.mock.calls[0][0].to).toBe(GROUP);
  });

  it("reports a failure rather than claiming success when both channels fail", async () => {
    const reply = vi.fn().mockRejectedValue(new Error("no"));
    const push = vi.fn().mockRejectedValue(new Error("no"));
    const d = deps(reply, push);
    const { db } = makeDb([[{ id: "prior" }]]);

    const result = await call(db, d, "@BeGifted Aadhu.Sr");
    expect(result.action).toBe("send_failed");
  });
});

describe("command parsing", () => {
  it("accepts an explicit month after the mention", async () => {
    vi.mocked(searchCurrentLineStudents).mockResolvedValue([student()] as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(schedule(3) as never);
    const d = deps();
    const { db } = makeDb([[]]);

    await call(db, d, "@BeGifted Aadhu.Sr 2026-09");

    expect(vi.mocked(getStudentMonthlySchedule).mock.calls[0][1]).toMatchObject({
      monthKey: "2026-09",
    });
  });

  it("explains itself when mentioned with nothing else", async () => {
    const d = deps();
    const { db } = makeDb();

    const result = await call(db, d, "@BeGifted");
    expect(result.action).toBe("help");
    expect(searchCurrentLineStudents).not.toHaveBeenCalled();
  });

  it("ignores prose so ordinary chat never triggers a lookup", async () => {
    const d = deps();
    const { db } = makeDb();

    const result = await call(db, d, "@BeGifted can we move Tuesday please");
    expect(result).toEqual({ handled: false });
    expect(sent(d)).toHaveLength(0);
  });
});
