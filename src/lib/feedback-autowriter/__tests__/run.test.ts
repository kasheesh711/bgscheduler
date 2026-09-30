import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDraft, summarizeCosts, type DraftRecord, type PreparedSession } from "../run";
import { SESSION_ID, STUDENT_NAME } from "./fixtures";

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
