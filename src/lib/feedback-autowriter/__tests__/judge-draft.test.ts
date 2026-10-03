import { describe, expect, it, vi } from "vitest";
import { ATOM_MODEL_RULES } from "../atom/evidence";
import { AUTOWRITER_JUDGE_TIMEOUT_MS, AUTOWRITER_MODELS } from "../config";
import { judgeDraftAtEveryLevel, type DraftJudgeInput } from "../judge-draft";
import type { OpenRouterCallResult } from "../openrouter";
import { GOOD_FIELDS, STUDENT_NAME } from "./fixtures";

/** Synthetic lesson and people only. */
type Request = Parameters<DraftJudgeInput["call"]>[0];

const PASSING = JSON.stringify({ faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] });
const usage = { promptTokens: 900, completionTokens: 300, reasoningTokens: 200, cachedTokens: 0, costUsd: 0.001 };

function reply(content: string, patch: Partial<Extract<OpenRouterCallResult, { ok: true }>> = {}): OpenRouterCallResult {
  return {
    ok: true, content, model: AUTOWRITER_MODELS.judge.expectModel, provider: AUTOWRITER_MODELS.judge.expectProvider,
    generationId: "g", finishReason: "stop", usage, latencyMs: 5, ...patch,
  };
}

function input(call: DraftJudgeInput["call"], patch: Partial<DraftJudgeInput> = {}): DraftJudgeInput {
  return {
    apiKey: "test-key",
    fields: GOOD_FIELDS,
    record: "Overview: Somchai and the tutor practised fractions. Tawan, another pupil, asked about pizza slices.",
    evidence: "summary",
    names: { studentFullName: STUDENT_NAME, studentAliases: [], tutorNames: ["Kevin"] },
    classDetails: ["Programme: Y5-6"],
    call,
    remainingMs: () => 15 * 60 * 1000,
    sleep: async () => {},
    random: () => 0.5,
    ...patch,
  };
}

describe("judgeDraftAtEveryLevel", () => {
  it("judges at medium and high on byte-identical, redacted messages and passes only when both do", async () => {
    const requests: Request[] = [];
    const call = vi.fn(async (request: Request) => {
      requests.push(request);
      return reply(PASSING);
    });
    const result = await judgeDraftAtEveryLevel(input(call));
    expect(result).toMatchObject({ error: null, problems: [], verdict: { faithful: true, levels: { medium: { faithful: true }, high: { faithful: true } } } });
    expect(requests.map((request) => request.effort).toSorted()).toEqual(["high", "medium"]);
    expect(requests[0].messages).toEqual(requests[1].messages);
    expect(requests[0]).toMatchObject({ model: AUTOWRITER_MODELS.judge.model, schemaName: "feedback_faithfulness", timeoutMs: AUTOWRITER_JUDGE_TIMEOUT_MS.summary });
    const text = JSON.stringify(requests[0].messages);
    // The student's name never reaches the judge; the summary's other people are listed as in production.
    expect(text).not.toContain("Somchai");
    expect(text).toContain("[STUDENT_1]");
    expect(text).toContain("Tawan");
  });

  it("uses the transcript time-out and no other-people line for a transcript", async () => {
    const requests: Request[] = [];
    const call = vi.fn(async (request: Request) => {
      requests.push(request);
      return reply(PASSING);
    });
    await judgeDraftAtEveryLevel(input(call, { evidence: "transcript", speakerLabels: "verified", record: "[00:00] TUTOR: Fractions today." }));
    expect(requests[0].timeoutMs).toBe(AUTOWRITER_JUDGE_TIMEOUT_MS.transcript);
    expect(requests[0].messages[1].content).toContain("Lesson transcript:");
  });

  it("fails closed on the first level without a verdict, in effort order", async () => {
    const unparseable = vi.fn(async (request: Request) => reply(request.effort === "high" ? "not json" : PASSING));
    expect(await judgeDraftAtEveryLevel(input(unparseable))).toEqual({ verdict: null, problems: [], error: "judge:high:judge_unparseable" });
    const failed = vi.fn(async (request: Request): Promise<OpenRouterCallResult> => request.effort === "medium"
      ? { ok: false, error: "timeout", httpStatus: null, model: null, provider: null, finishReason: null, usage: null, latencyMs: 1 }
      : reply(PASSING));
    expect((await judgeDraftAtEveryLevel(input(failed))).error).toBe("judge:medium:timeout");
  });

  it("refuses a reply from another host only when the pinned route is required", async () => {
    const elsewhere = vi.fn(async () => reply(PASSING, { provider: "SomeOtherHost" }));
    expect((await judgeDraftAtEveryLevel(input(elsewhere))).error).toBeNull();
    expect((await judgeDraftAtEveryLevel(input(elsewhere, { requirePinnedRoute: true }))).error).toBe("judge:medium:provider_mismatch:SomeOtherHost");
  });

  it("gives the judge an ISEB post's Atom evidence, redacted, with production's Atom rules", async () => {
    const requests: Request[] = [];
    const call = vi.fn(async (request: Request) => {
      requests.push(request);
      return reply(PASSING);
    });
    const atom = "Matched activity: Fractions drill 3 — Somchai answered 18 of 20 correctly (90%) in 12 minutes.";
    await judgeDraftAtEveryLevel(input(call, { atomEvidence: atom }));
    const [system, user] = requests[0].messages;
    expect(system.content).toContain(ATOM_MODEL_RULES);
    expect(system.content).toContain("SOURCE_CONTRADICTION");
    expect(user.content).toContain("Frozen Atom lesson evidence:");
    expect(user.content).toContain("[STUDENT_1] answered 18 of 20 correctly (90%)");
    expect(user.content).not.toContain("Somchai");
    // Without Atom evidence the messages are production's plain ones.
    requests.length = 0;
    await judgeDraftAtEveryLevel(input(call, { atomEvidence: null }));
    expect(requests[0].messages[0].content).not.toContain(ATOM_MODEL_RULES);
    expect(requests[0].messages[1].content).not.toContain("Frozen Atom lesson evidence:");
  });

  it("lists the union of both levels' problems", async () => {
    const call = vi.fn(async (request: Request) => reply(request.effort === "high"
      ? JSON.stringify({ faithful: false, unsupported: [], misattributed: [], homeworkNotSet: ["the worksheet"] })
      : PASSING));
    const result = await judgeDraftAtEveryLevel(input(call));
    expect(result.verdict?.faithful).toBe(false);
    expect(result.problems).toEqual(["homework not set: the worksheet"]);
  });
});
