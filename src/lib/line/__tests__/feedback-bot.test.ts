// The assertions that matter: a chat that is not a registered teacher chat for
// this bot gets NOTHING (FB-BOT-G1), the reply holds ONE subject from all
// tutors (FB-BOT-S1), and it stays under LINE's text limit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  feedbackLinkToken,
  feedbackReply,
  handleFeedbackGroupCommand,
  loadStudentProfile,
  readFeedbackLinkToken,
  selectSubjectClasses,
  titleSubject,
  type FeedbackClassRow,
} from "@/lib/line/feedback-bot";
import type { Database } from "@/lib/db";

/** Chainable Drizzle stand-in: one queue entry per awaited select chain. */
function makeDb(selectResults: unknown[][]) {
  const queue = [...selectResults];
  const select = vi.fn(() => {
    const result = queue.shift() ?? [];
    const node: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy"]) node[method] = () => node;
    node.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
    return node;
  });
  return { db: { select } as unknown as Database, select };
}

let nextId = 0;
const row = (overrides: Partial<FeedbackClassRow> = {}): FeedbackClassRow => ({
  wiseSessionId: `s${nextId += 1}`,
  wiseStudentId: "stu1",
  studentName: "Aarak (Arav.Sr) Srikueja",
  tutorKey: "Mimi",
  tutorName: "Mimi",
  scheduledStartAt: new Date("2026-11-13T12:30:00Z"), // 19:30 Bangkok
  topics: "Quadratics",
  performance: "Good",
  improvement: "",
  homework: null,
  ...overrides,
});

const NO_PROFILE = { school: "", year: "" };
const base = { groupId: "Cgroup1", replyToken: "token", text: "/feedback Arav.Sr", profile: async () => NO_PROFILE };
const GROUP = [{ canonicalKey: "Mimi" }];

beforeEach(() => vi.stubEnv("AUTH_SECRET", "test-secret"));
afterEach(() => vi.unstubAllEnvs());

describe("handleFeedbackGroupCommand", () => {
  it("ignores text that is not a /feedback command without a database read", async () => {
    const { db, select } = makeDb([]);
    expect(await handleFeedbackGroupCommand({ ...base, db, text: "/feedbacks", reply: vi.fn() })).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("FB-BOT-G1: stays silent in a chat that is not a registered teacher chat", async () => {
    const reply = vi.fn();
    const { db, select } = makeDb([[]]);
    expect(await handleFeedbackGroupCommand({ ...base, db, reply })).toBe("feedback_silent_chat");
    expect(await handleFeedbackGroupCommand({ ...base, db: makeDb([[]]).db, text: "/feedback", reply })).toBe("feedback_silent_chat");
    expect(await handleFeedbackGroupCommand({ ...base, db: makeDb([GROUP]).db, replyToken: null, reply })).toBe("feedback_silent_chat");
    expect(reply).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1); // no feedback lookup
  });

  it("FB-BOT-G1: only the bot that serves the tutor answers", async () => {
    vi.stubEnv("PROGRESS_LINE_TUTOR_BOT_KEYS", "Mimi");
    const reply = vi.fn();
    const cls = row();
    const titles = [{ wiseSessionId: cls.wiseSessionId, title: "Live Session - Chemistry" }];
    expect(await handleFeedbackGroupCommand({ ...base, db: makeDb([GROUP]).db, reply })).toBe("feedback_silent_chat");
    expect(reply).not.toHaveBeenCalled();
    expect(await handleFeedbackGroupCommand({ ...base, db: makeDb([GROUP, [cls], titles]).db, tutorBot: true, reply })).toBe("feedback_reply");
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ replyToken: "token", tutorBot: true }));
  });

  it("replies with help when the code is missing", async () => {
    const reply = vi.fn();
    expect(await handleFeedbackGroupCommand({ ...base, db: makeDb([GROUP]).db, text: "/feedback", reply })).toBe("feedback_help");
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("says that the student code was not found", async () => {
    const reply = vi.fn();
    expect(await handleFeedbackGroupCommand({ ...base, db: makeDb([GROUP, []]).db, reply })).toBe("feedback_not_found");
    expect(reply.mock.calls[0][0].text).toContain('"Arav.Sr"');
  });

  it("FB-BOT-S1: replies with the chat teacher's subject from all tutors", async () => {
    const reply = vi.fn();
    const math = row({ tutorKey: "Aey", tutorName: "Aey", topics: "Algebra" });
    const chemCover = row({ tutorKey: "Lukas", tutorName: "Lukas", topics: "Moles" });
    const chem = row({ topics: "Bonding" });
    const titles = [
      { wiseSessionId: math.wiseSessionId, title: "In-Person Session-Math" },
      { wiseSessionId: chemCover.wiseSessionId, title: "In-Person Session- Chemistry" },
      { wiseSessionId: chem.wiseSessionId, title: "Live Session - Chemistry" },
    ];
    expect(await handleFeedbackGroupCommand({ ...base, db: makeDb([GROUP, [math, chemCover, chem], titles]).db, reply })).toBe("feedback_reply");
    const text = reply.mock.calls[0][0].text as string;
    expect(text).toContain("· Chemistry (last 2 classes, all tutors)");
    expect(text).toContain("Lukas\nTopics: Moles");
    // FB-BOT-L1: the link token names this student code and subject.
    const token = /\/feedback\/(\S+)/.exec(text)?.[1] ?? "";
    expect(readFeedbackLinkToken(token)).toMatchObject({ code: "Arav.Sr", subject: "Chemistry" });
    expect(text).not.toContain("Algebra");

    // A typed subject overrides the chat teacher's subject.
    expect(await handleFeedbackGroupCommand({ ...base, text: "/feedback Arav.Sr mat", db: makeDb([GROUP, [math, chemCover, chem], titles]).db, reply })).toBe("feedback_reply");
    expect(reply.mock.calls[1][0].text).toContain("Algebra");
    expect(reply.mock.calls[1][0].text).not.toContain("Moles");
  });

  it("FB-BOT-S1: lists the subjects when no subject can be selected", async () => {
    const reply = vi.fn();
    const math = row({ tutorKey: "Aey" });
    const titles = [{ wiseSessionId: math.wiseSessionId, title: "In-Person Session-Math" }];
    expect(await handleFeedbackGroupCommand({ ...base, db: makeDb([GROUP, [math], titles]).db, reply })).toBe("feedback_no_subject");
    expect(reply.mock.calls[0][0].text).toContain("/feedback Arav.Sr Math");
    expect(await handleFeedbackGroupCommand({ ...base, text: "/feedback Arav.Sr physics", db: makeDb([GROUP, [math], titles]).db, reply })).toBe("feedback_no_subject");
    expect(reply.mock.calls[1][0].text).toContain("Subjects: Math");
  });
});

describe("selectSubjectClasses", () => {
  it("reads the subject from the class title", () => {
    expect(titleSubject("In-Person Session- Com sci")).toBe("Com sci");
    expect(titleSubject("Online Session - Math")).toBe("Math");
    expect(titleSubject("In-Person Session -Physics")).toBe("Physics");
    expect(titleSubject("Trial English Verbal")).toBe("Trial English Verbal");
  });

  it("keeps the five most recent classes and leaves out a class with no title", () => {
    const rows = Array.from({ length: 7 }, () => row());
    const titles = new Map(rows.slice(1).map((cls) => [cls.wiseSessionId, "Live Session-Chemistry"]));
    const selection = selectSubjectClasses(rows, titles, "Mimi", "");
    expect(selection.status === "ok" && selection.rows).toEqual(rows.slice(1, 6));
  });
});

describe("feedbackReply", () => {
  it("shows Bangkok time, skips empty fields, and marks a class without feedback", () => {
    const text = feedbackReply("Chemistry", [row(), row({ topics: null, performance: null })]);
    expect(text).toContain("Feedback: Aarak (Arav.Sr) Srikueja · Chemistry (last 2 classes, all tutors)");
    expect(text).toContain("19:30 · Mimi");
    expect(text).toContain("Topics: Quadratics\nPerformance: Good");
    expect(text).not.toContain("Needs work");
    expect(text).toContain("2) ");
    expect(text).toContain("No feedback yet.");
  });

  it("keeps five long feedback entries under the LINE text limit", () => {
    const long = "x".repeat(3000);
    const url = `https://bgscheduler.vercel.app/feedback/${feedbackLinkToken("Arav.Sr", "Chemistry", new Date())}`;
    const text = feedbackReply("Chemistry", Array.from({ length: 5 }, () => row({ topics: long, performance: long })), url, {
      school: "s".repeat(80), year: "y".repeat(80),
    });
    expect(text.length).toBeLessThan(5000);
    expect(text).toContain("…");
  });
});

describe("feedback link token (FB-BOT-L1)", () => {
  const NOW = new Date("2026-11-14T10:00:00Z");

  it("works for 24 hours and then stops", () => {
    const token = feedbackLinkToken("Arav.Sr", "Com sci", NOW)!;
    expect(readFeedbackLinkToken(token, new Date("2026-11-15T09:59:00Z"))).toEqual({
      code: "Arav.Sr", subject: "Com sci", expiresAt: new Date("2026-11-15T10:00:00Z"),
    });
    expect(readFeedbackLinkToken(token, new Date("2026-11-15T10:00:00Z"))).toBeNull();
  });

  it("refuses a changed, malformed, or differently signed token", () => {
    const token = feedbackLinkToken("Arav.Sr", "Math", NOW)!;
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ c: "Other.St", s: "Math", exp: 9999999999 })).toString("base64url");
    expect(readFeedbackLinkToken(`${forged}.${signature}`, NOW)).toBeNull();
    expect(readFeedbackLinkToken(`${payload}.${signature}.x`, NOW)).toBeNull();
    expect(readFeedbackLinkToken(payload, NOW)).toBeNull();
    expect(readFeedbackLinkToken("", NOW)).toBeNull();
    expect(readFeedbackLinkToken(token, NOW, "other-secret")).toBeNull();
  });

  it("gives no link when the secret is not set", () => {
    expect(feedbackLinkToken("Arav.Sr", "Math", NOW, "")).toBeNull();
    expect(feedbackReply("Math", [row()])).not.toContain("/feedback/");
  });

  it("the page selects the exact subject of the link", () => {
    const mathVr = row({ tutorKey: "Aey" });
    const math = row({ tutorKey: "Aey" });
    const titles = new Map([[mathVr.wiseSessionId, "Live Session - Math VR"], [math.wiseSessionId, "Live Session - Math"]]);
    const selection = selectSubjectClasses([mathVr, math], titles, "", "Math", true);
    expect(selection.status === "ok" && selection.rows).toEqual([math]);
  });
});

describe("school and year (FB-BOT-P1)", () => {
  it("reads school and year from the Wise registration form", async () => {
    const fields = async () => [
      { questionId: "5l92yygp", answer: " Bangkok Patana " },
      { questionId: "if89sblj", answer: "Year 10" },
      { questionId: "other", answer: "x" },
    ];
    expect(await loadStudentProfile("stu1", fields)).toEqual({ school: "Bangkok Patana", year: "Year 10" });
    expect(feedbackReply("Math", [row()], null, { school: "Bangkok Patana", year: "Year 10" }))
      .toContain("School: Bangkok Patana · Year: Year 10");
  });

  it("leaves them out when Wise fails or the student id is not known", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await loadStudentProfile("stu1", async () => { throw new Error("Wise down"); })).toEqual(NO_PROFILE);
    expect(await loadStudentProfile(null)).toEqual(NO_PROFILE);
    expect(feedbackReply("Math", [row()], null, { school: "", year: "Year 10" })).toContain("\nYear: Year 10\n");
    expect(feedbackReply("Math", [row()])).not.toContain("School");
    error.mockRestore();
  });

  it("the handler puts the profile of the student in the reply", async () => {
    const reply = vi.fn();
    const cls = row();
    const titles = [{ wiseSessionId: cls.wiseSessionId, title: "Live Session - Chemistry" }];
    const profile = vi.fn(async () => ({ school: "NIST", year: "Y9" }));
    await handleFeedbackGroupCommand({ ...base, db: makeDb([GROUP, [cls], titles]).db, reply, profile });
    expect(profile).toHaveBeenCalledWith("stu1");
    expect(reply.mock.calls[0][0].text).toContain("School: NIST · Year: Y9");
  });
});
