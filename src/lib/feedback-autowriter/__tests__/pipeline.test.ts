import { describe, expect, it, vi } from "vitest";
import type { OpenRouterCallResult } from "../openrouter";
import { isInfraFailure, routeMismatch, runWritingPipeline, type CallRecord } from "../pipeline";
import { AUTOWRITER_MODELS } from "../config";
import { GOOD_FIELDS, STUDENT_NAME } from "./fixtures";

const usage = { promptTokens: 1000, completionTokens: 2000, reasoningTokens: 1700, cachedTokens: 0, costUsd: 0.002 };
const writerJson = JSON.stringify({
  topics: GOOD_FIELDS.topics,
  performance: GOOD_FIELDS.performance.replaceAll("Somchai", "[STUDENT_1]"),
  improvement: GOOD_FIELDS.improvement.replaceAll("Somchai", "[STUDENT_1]"),
  homework: "",
  studentAttended: true,
  lessonHappened: true,
});

function ok(content: string, provider: string | null, model: string | null): OpenRouterCallResult {
  return { ok: true, content, model, provider, generationId: "g", finishReason: "stop", usage, latencyMs: 10 };
}
function fail(error: string, httpStatus: number | null): OpenRouterCallResult {
  return { ok: false, error, httpStatus, model: null, provider: null, finishReason: null, usage: null, latencyMs: 10 };
}
const GLM = (content: string) => ok(content, "Together", "z-ai/glm-5.3-flash");
const LUNA = (content: string) => ok(content, "OpenAI", "openai/gpt-6-luna");
const FAITHFUL = JSON.stringify({ faithful: true, unsupported: [] });
const UNFAITHFUL = JSON.stringify({ faithful: false, unsupported: ["scored 95%"] });

function run(replies: OpenRouterCallResult[], evidence: "summary" | "transcript" = "summary") {
  const records: CallRecord[] = [];
  const requests: Array<{ model: string; messages: Array<{ content: string }>; schemaName: string }> = [];
  const callModel = vi.fn(async (request: { model: string; messages: Array<{ role: string; content: string }>; schemaName: string }) => {
    requests.push(request);
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected call");
    return reply;
  });
  const promise = runWritingPipeline({
    apiKey: "k",
    session: {
      wiseSessionId: "6a0000000000000000000002",
      studentFullName: STUDENT_NAME,
      studentDisplayName: "Somchai",
      classDetails: ["Programme: 11+/13+", "Class subject: NVR", "Terms: 11+/13+ = the ISEB 11+/13+ entrance tests"],
      scheduledMinutes: 60,
      summary: { text: "Overview: Kevin and Somchai practised fractions; Somchai rushed simplification but corrected it.", meetingUUIDs: [] },
      evidence,
    },
    tutorNames: ["Kevin Hsieh", "Kev"],
    priorFeedback: [],
    record: async (record) => { records.push(record); },
    remainingMs: () => 700_000,
    callModel: callModel as never,
  });
  return { promise, records, requests };
}

describe("runWritingPipeline", () => {
  it("accepts a valid, faithful GLM draft judged on the ZDR route", async () => {
    const { promise, records, requests } = run([GLM(writerJson), GLM(FAITHFUL)]);
    const result = await promise;
    expect(result).toMatchObject({ kind: "draft", arm: "glm" });
    expect(records.map((record) => `${record.role}:${record.arm}`)).toEqual(["writer:glm", "judge:glm"]);
    expect(requests.map((request) => request.model)).toEqual(["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"]);
  });

  it("never sends student or tutor names to the judge", async () => {
    const { promise, requests } = run([GLM(writerJson), GLM(FAITHFUL)]);
    await promise;
    const judgeText = requests[1].messages.map((message) => message.content).join("\n");
    expect(judgeText).not.toMatch(/Somchai|Kevin/u);
    expect(judgeText).toContain("[STUDENT_1]");
  });

  it("gives the judge the same trusted class details the writer had", async () => {
    const { promise, requests } = run([GLM(writerJson), GLM(FAITHFUL)]);
    await promise;
    const writerText = requests[0].messages.map((message) => message.content).join("\n");
    const judgeText = requests[1].messages.map((message) => message.content).join("\n");
    for (const text of [writerText, judgeText]) {
      expect(text).toContain("- Programme: 11+/13+");
      expect(text).toContain("- Class subject: NVR");
    }
    expect(judgeText).toContain("naming the programme, exam or subject they give is supported");
  });

  it("falls back to Luna when the GLM draft is unfaithful, and has GLM judge it", async () => {
    const { promise, records } = run([GLM(writerJson), GLM(UNFAITHFUL), LUNA(writerJson), GLM(FAITHFUL)]);
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(records.map((record) => `${record.role}:${record.arm}`)).toEqual(["writer:glm", "judge:glm", "writer:luna", "judge:glm"]);
  });

  it("holds when both drafts fail content checks", async () => {
    const { promise } = run([GLM(JSON.stringify({ ...JSON.parse(writerJson), topics: "Fractions." })), LUNA("not json")]);
    const result = await promise;
    expect(result.kind).toBe("held");
    if (result.kind === "held") expect(result.reasons.length).toBeGreaterThan(1);
  });

  it("treats an OpenRouter outage or missing credit as infra, not a hold", async () => {
    expect(await run([fail("Insufficient credits", 402)]).promise).toEqual({ kind: "infra", error: "glm:Insufficient credits" });
    expect(await run([fail("timeout", null)]).promise).toEqual({ kind: "infra", error: "glm:timeout" });
  });

  it("never sends the summary to the fallback host after a provider-side generation error", async () => {
    const errored: OpenRouterCallResult = { ...fail("finish_reason_error", 200), finishReason: "error" };
    const { promise, requests } = run([errored]);
    expect(await promise).toEqual({ kind: "infra", error: "glm:finish_reason_error" });
    expect(requests).toHaveLength(1);
  });

  it("treats a moderation refusal as the text's problem and tries the fallback writer", async () => {
    const { promise, records } = run([fail("Input flagged by moderation", 403), LUNA(writerJson), GLM(FAITHFUL)]);
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(records.map((record) => `${record.role}:${record.arm}`)).toEqual(["writer:glm", "writer:luna", "judge:glm"]);
  });

  it("gives the judge a second try, then retries later instead of falling back", async () => {
    const once = run([GLM(writerJson), GLM("not json"), GLM(FAITHFUL)]);
    expect(await once.promise).toMatchObject({ kind: "draft", arm: "glm" });

    const twice = run([GLM(writerJson), GLM("not json"), GLM("{}")]);
    expect(await twice.promise).toEqual({ kind: "infra", error: "judge:judge_unparseable" });
    expect(twice.requests.map((request) => request.model)).not.toContain("openai/gpt-6-luna");
  });

  it("writes from a transcript on the zero-retention GLM route only — never the fallback host", async () => {
    const { promise, requests } = run([GLM(writerJson), GLM(UNFAITHFUL)], "transcript");
    expect(await promise).toMatchObject({ kind: "held" });
    expect(requests.map((request) => request.model)).toEqual(["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"]);
    expect(requests[1].messages.map((message) => message.content).join("\n")).toContain("Lesson transcript:");
  });

  it("treats a response from an unpinned host as infra", async () => {
    const { promise } = run([ok(writerJson, "SomeOtherHost", "z-ai/glm-5.3-flash")]);
    expect(await promise).toEqual({ kind: "infra", error: "glm:provider_mismatch:SomeOtherHost" });
  });
});

describe("helpers", () => {
  it("classifies truncation, moderation and context length as content; provider and service errors as infra", () => {
    const failure = (error: string, httpStatus: number | null) =>
      ({ ok: false as const, error, httpStatus, model: null, provider: null, finishReason: null, usage: null, latencyMs: 1 });
    expect(isInfraFailure(failure("finish_reason_length", 200))).toBe(false);
    expect(isInfraFailure(failure("finish_reason_content_filter", 200))).toBe(false);
    expect(isInfraFailure(failure("flagged", 403))).toBe(false);
    expect(isInfraFailure(failure("This endpoint's maximum context length is 128000 tokens", 400))).toBe(false);
    expect(isInfraFailure(failure("finish_reason_error", 200))).toBe(true);
    expect(isInfraFailure(failure("finish_reason_missing", 200))).toBe(true);
    expect(isInfraFailure(failure("Invalid schema", 400))).toBe(true);
    expect(isInfraFailure(failure("HTTP 500", 500))).toBe(true);
  });

  it("only checks routes that are pinned", () => {
    expect(routeMismatch(AUTOWRITER_MODELS.fallbackWriter, LUNA("x"))).toBeNull();
    expect(routeMismatch(AUTOWRITER_MODELS.writer, ok("x", "Together", "z-ai/glm-6-flash"))).toBe("model_mismatch:z-ai/glm-6-flash");
  });
});
