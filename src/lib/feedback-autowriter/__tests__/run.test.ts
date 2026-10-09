import { afterEach, describe, expect, it, vi } from "vitest";
import { createWiseFeedbackOps, generateDraft, sessionCreditEntries, summarizeCosts, type DraftRecord, type PreparedSession } from "../run";
import { creditProblems } from "../submit";
import { parseAutowriterSessionDetail } from "../session";
import { CLASS_ID, SESSION_ID, STUDENT_ID, STUDENT_NAME, sessionDetail } from "./fixtures";

const session: PreparedSession = {
  purpose: "eval",
  sessionId: SESSION_ID,
  classId: "6a0000000000000000000001",
  className: STUDENT_NAME,
  scheduledStartAt: "2026-09-28T08:30:00.000Z",
  scheduledMinutes: 60,
  studentFullName: STUDENT_NAME,
  studentDisplayName: "Tom",
  classDetails: ["Programme: 11+/13+"],
  summary: { text: "Overview: the tutor and the student practised fractions.", meetingUUIDs: [] },
  submission: { kind: "none" },
  billing: null,
  humanFields: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("session credit identity", () => {
  const detail = () => parseAutowriterSessionDetail({ ...sessionDetail(), start_time: "2026-09-28T08:32:16.067Z", duration: 3569000 });
  const charge = () => ({ _id: "6b0000000000000000000001", credit: 1, type: "SESSION", meetingStatus: "ENDED",
    createdAt: "2026-09-28T08:32:16.067Z", duration: 3569000, userId: { _id: STUDENT_ID }, classroom: { _id: CLASS_ID } });
  const response = (...entries: unknown[]) => ({ data: { sessionCreditHistory: entries } });
  const billing = { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 } as const;

  it("keeps the legacy lesson-ID match", () => {
    expect(sessionCreditEntries(response({ _id: SESSION_ID, credit: 1 }), detail(), STUDENT_ID)).toEqual([{ credit: 1 }]);
  });

  it("matches a charge ID through exact lesson evidence", () => {
    expect(sessionCreditEntries(response(charge()), detail(), STUDENT_ID)).toEqual([{ credit: 1 }]);
  });

  it.each([
    { classroom: { _id: "another-class" } }, { userId: { _id: "another-student" } },
    { createdAt: "2026-09-28T08:32:16.068Z" }, { createdAt: "2026-09-28T08:30:00.000Z" },
    { createdAt: "invalid" }, { createdAt: null }, { duration: 3569001 }, { duration: null },
    { type: "CREDIT" }, { meetingStatus: "CANCELLED" }, { userId: null }, { classroom: null },
  ])("refuses a charge with different or missing evidence: %j", (patch) => {
    expect(sessionCreditEntries(response({ ...charge(), ...patch }), detail(), STUDENT_ID)).toEqual([]);
  });

  it.each([{ start_time: undefined }, { duration: undefined }, { duration: 0 }, { meetingStatus: "MISSED" }])(
    "refuses an incomplete lesson: %j", (patch) => {
      expect(sessionCreditEntries(response(charge()), parseAutowriterSessionDetail({ ...detail(), ...patch }), STUDENT_ID)).toEqual([]);
    });

  it("preserves duplicate and credit-amount failures, including mixed legacy and charge IDs", () => {
    for (const entries of [response(charge(), { ...charge(), _id: "another-charge" }), response(charge(), { _id: SESSION_ID, credit: 1 })]) {
      expect(creditProblems(sessionCreditEntries(entries, detail(), STUDENT_ID), billing)).toEqual(["session_credit_entries_2"]);
    }
    expect(creditProblems(sessionCreditEntries(response({ ...charge(), credit: 0 }), detail(), STUDENT_ID), billing)).toEqual(["session_credit_0"]);
    expect(creditProblems(sessionCreditEntries(response(), detail(), STUDENT_ID), billing)).toEqual(["session_credit_entries_0"]);
  });

  it("reads fresh Wise evidence and refuses a different lesson before matching credits", async () => {
    for (const [key, value] of Object.entries({ WISE_USER_ID: "actor", WISE_API_KEY: "key", WISE_INSTITUTE_ID: CLASS_ID })) vi.stubEnv(key, value);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(response(charge())))
      .mockResolvedValueOnce(Response.json({ data: { ...detail(), _id: "wrong-lesson" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createWiseFeedbackOps().getSessionCreditEntries(CLASS_ID, STUDENT_ID, SESSION_ID)).rejects.toThrow("Credit lesson identity mismatch");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: "no-store" });
  });
});

describe("generateDraft (evaluation CLI)", () => {
  it("asks each arm's own writer model — GLM stays GLM now that Sol writes", async () => {
    const bodies: Array<{ model: string; reasoning: { effort: string }; provider: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "not json" } }] }), { status: 200 });
    }));
    const drafts: DraftRecord[] = [];
    for (const arm of ["sol", "glm", "luna"] as const) {
      drafts.push(await generateDraft({ apiKey: "k", arm, session, tutorNames: [], priorFeedback: [] }));
    }
    expect(bodies.map((body) => [body.model, body.reasoning.effort])).toEqual([
      ["openai/gpt-6.1-sol", "low"],
      ["z-ai/glm-5.3-flash", "max"],
      ["openai/gpt-6-luna", "max"],
    ]);
    for (const body of bodies) expect(body.provider).toMatchObject({ zdr: true });
    expect(drafts.map((draft) => [draft.arm, draft.requestedModel])).toEqual([
      ["sol", "openai/gpt-6.1-sol"],
      ["glm", "z-ai/glm-5.3-flash"],
      ["luna", "openai/gpt-6-luna"],
    ]);
    expect(Object.keys(summarizeCosts(drafts))).toEqual(["sol", "glm", "luna"]);
    expect(summarizeCosts(drafts).sol).toMatchObject({ calls: 1, callsOk: 1, validatorPassed: 0 });
  });
});
