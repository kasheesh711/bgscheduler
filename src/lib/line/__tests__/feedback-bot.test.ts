// The assertions that matter: a chat that is not a registered teacher chat for
// this bot gets NOTHING (FB-BOT-G1), the reply holds ONE subject from all
// tutors (FB-BOT-S1), and it stays under LINE's text limit.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  feedbackReply,
  handleFeedbackGroupCommand,
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

const base = { groupId: "Cgroup1", replyToken: "token", text: "/feedback Arav.Sr" };
const GROUP = [{ canonicalKey: "Mimi" }];

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
    const text = feedbackReply("Chemistry", Array.from({ length: 5 }, () => row({ topics: long, performance: long })));
    expect(text.length).toBeLessThan(5000);
    expect(text).toContain("…");
  });
});
