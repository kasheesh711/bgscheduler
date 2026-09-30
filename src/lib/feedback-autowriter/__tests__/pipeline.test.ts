import { describe, expect, it, vi } from "vitest";
import type { OpenRouterCallResult } from "../openrouter";
import { isInfraFailure, routeMismatch, runWritingPipeline, type CallRecord } from "../pipeline";
import { AUTOWRITER_MODELS } from "../config";
import { speakerLabelNote } from "../prompt";
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
const SOL = (content: string) => ok(content, "Azure", "openai/gpt-6.1-sol");
const LUNA = (content: string) => ok(content, "Azure", "openai/gpt-6-luna");
const GLM = (content: string) => ok(content, "Together", "z-ai/glm-5.3-flash");
const FAITHFUL = JSON.stringify({ faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] });
const UNFAITHFUL = JSON.stringify({ faithful: false, unsupported: ["scored 95%"], misattributed: [], homeworkNotSet: [] });
const MISATTRIBUTED = JSON.stringify({
  faithful: false, unsupported: [], misattributed: ["[STUDENT_1] said 8 of the 10 pages have been covered"], homeworkNotSet: [],
});
const SUMMARY = "Overview: Kevin and Somchai practised fractions; Somchai rushed simplification but corrected it.";

interface Request {
  model: string;
  provider: { zdr?: boolean; data_collection?: string; order?: string[] };
  effort: string;
  messages: Array<{ role: string; content: string }>;
  schemaName: string;
}

function run(replies: OpenRouterCallResult[], evidence: "summary" | "transcript" = "summary", summaryText = SUMMARY, studentAliases?: string[]) {
  const records: CallRecord[] = [];
  const requests: Request[] = [];
  const callModel = vi.fn(async (request: Request) => {
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
      studentAliases,
      studentDisplayName: "Somchai",
      classDetails: ["Programme: 11+/13+", "Class subject: NVR", "Terms: 11+/13+ = the ISEB 11+/13+ entrance tests"],
      scheduledMinutes: 60,
      summary: { text: summaryText, meetingUUIDs: [] },
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
  it("accepts a valid, faithful Sol draft judged by GLM", async () => {
    const { promise, records, requests } = run([SOL(writerJson), GLM(FAITHFUL)]);
    const result = await promise;
    expect(result).toMatchObject({ kind: "draft", arm: "sol" });
    expect(records.map((record) => `${record.role}:${record.arm}`)).toEqual(["writer:sol", "judge:glm"]);
    expect(requests.map((request) => request.model)).toEqual(["openai/gpt-6.1-sol", "z-ai/glm-5.3-flash"]);
  });

  it("asks for Sol at reasoning low on a zero-data-retention route, from any ZDR host", async () => {
    const { promise, requests } = run([SOL(writerJson), GLM(FAITHFUL)]);
    await promise;
    expect(requests[0]).toMatchObject({
      model: "openai/gpt-6.1-sol",
      effort: "low",
      schemaName: "post_class_feedback",
      provider: { zdr: true, data_collection: "deny" },
    });
    // Not pinned to one host: zdr alone decides where it may run.
    expect(requests[0].provider.order).toBeUndefined();
    expect(requests[1]).toMatchObject({ model: "z-ai/glm-5.3-flash", provider: { order: ["together"], zdr: true } });

    const otherHost = run([ok(writerJson, "OpenAI", "openai/gpt-6.1-sol"), GLM(FAITHFUL)]);
    expect(await otherHost.promise).toMatchObject({ kind: "draft", arm: "sol" });
  });

  it("never sends student or tutor names to the judge", async () => {
    const { promise, requests } = run([SOL(writerJson), GLM(FAITHFUL)]);
    await promise;
    const judgeText = requests[1].messages.map((message) => message.content).join("\n");
    expect(judgeText).not.toMatch(/Somchai|Kevin/u);
    expect(judgeText).toContain("[STUDENT_1]");
  });

  it("gives the judge the same trusted class details the writer had", async () => {
    const { promise, requests } = run([SOL(writerJson), GLM(FAITHFUL)]);
    await promise;
    const writerText = requests[0].messages.map((message) => message.content).join("\n");
    const judgeText = requests[1].messages.map((message) => message.content).join("\n");
    for (const text of [writerText, judgeText]) {
      expect(text).toContain("- Programme: 11+/13+");
      expect(text).toContain("- Class subject: NVR");
    }
    expect(judgeText).toContain("naming the programme, exam or subject they give is supported");
  });

  it("falls back to Luna when the Sol draft is unfaithful, and has GLM judge it", async () => {
    const { promise, records, requests } = run([SOL(writerJson), GLM(UNFAITHFUL), LUNA(writerJson), GLM(FAITHFUL)]);
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(records.map((record) => `${record.role}:${record.arm}`)).toEqual(["writer:sol", "judge:glm", "writer:luna", "judge:glm"]);
    expect(requests[2]).toMatchObject({ model: "openai/gpt-6-luna", effort: "max", provider: { zdr: true, data_collection: "deny" } });
  });

  it("holds when both drafts fail content checks", async () => {
    const { promise } = run([SOL(JSON.stringify({ ...JSON.parse(writerJson), topics: "Fractions." })), LUNA("not json")]);
    const result = await promise;
    expect(result.kind).toBe("held");
    if (result.kind === "held") expect(result.reasons.length).toBeGreaterThan(1);
  });

  it("treats an OpenRouter outage or missing credit as infra, not a hold", async () => {
    expect(await run([fail("Insufficient credits", 402)]).promise).toEqual({ kind: "infra", error: "sol:Insufficient credits" });
    expect(await run([fail("timeout", null)]).promise).toEqual({ kind: "infra", error: "sol:timeout" });
  });

  it("never sends the summary to the fallback host after a provider-side generation error", async () => {
    const errored: OpenRouterCallResult = { ...fail("finish_reason_error", 200), finishReason: "error" };
    const { promise, requests } = run([errored]);
    expect(await promise).toEqual({ kind: "infra", error: "sol:finish_reason_error" });
    expect(requests).toHaveLength(1);
  });

  it("treats a moderation refusal as the text's problem and tries the fallback writer", async () => {
    const { promise, records } = run([fail("Input flagged by moderation", 403), LUNA(writerJson), GLM(FAITHFUL)]);
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(records.map((record) => `${record.role}:${record.arm}`)).toEqual(["writer:sol", "writer:luna", "judge:glm"]);
  });

  it("gives the judge a second try, then retries later instead of falling back", async () => {
    const once = run([SOL(writerJson), GLM("not json"), GLM(FAITHFUL)]);
    expect(await once.promise).toMatchObject({ kind: "draft", arm: "sol" });

    const twice = run([SOL(writerJson), GLM("not json"), GLM("{}")]);
    expect(await twice.promise).toEqual({ kind: "infra", error: "judge:judge_unparseable" });
    expect(twice.requests.map((request) => request.model)).not.toContain("openai/gpt-6-luna");
  });

  it("writes from a transcript with Sol and falls back to Luna on a content failure — every route zero-retention", async () => {
    const { promise, records, requests } = run([SOL(writerJson), GLM(UNFAITHFUL), LUNA(writerJson), GLM(FAITHFUL)], "transcript");
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(requests.map((request) => request.model))
      .toEqual(["openai/gpt-6.1-sol", "z-ai/glm-5.3-flash", "openai/gpt-6-luna", "z-ai/glm-5.3-flash"]);
    for (const request of requests) expect(request.provider).toMatchObject({ zdr: true, data_collection: "deny" });
    expect(records.every((record) => record.result.evidence === "transcript")).toBe(true);
    expect(requests[1].messages.map((message) => message.content).join("\n")).toContain("Lesson transcript:");
    // Without Zoom's confirmation both writers and the judge are told the labels are inferred.
    for (const request of requests) expect(request.messages[0].content).toContain(speakerLabelNote("inferred"));
  });

  it("holds a transcript draft when Luna fails too", async () => {
    const { promise } = run([SOL(writerJson), GLM(UNFAITHFUL), LUNA("not json")], "transcript");
    const result = await promise;
    expect(result.kind).toBe("held");
    if (result.kind === "held") expect(result.reasons).toEqual([expect.stringMatching(/^sol:unfaithful:/u), expect.stringMatching(/^luna:/u)]);
  });

  it("writes at low effort (Sol) and judges at high effort (v4)", async () => {
    const { promise, requests } = run([SOL(writerJson), GLM(FAITHFUL)]);
    await promise;
    expect(requests.map((request) => request.effort)).toEqual(["low", "high"]);
  });

  it("tells the writer and the judge which other people the summary names", async () => {
    const summary = "Overview: Kevin was worried the exam preparation was incomplete; Nathan mentioned only 8 pages. Somchai practised fractions.";
    const { promise, requests } = run([SOL(writerJson), GLM(FAITHFUL)], "summary", summary);
    await promise;
    const line = "Other people named in the summary (never [STUDENT_1]): Nathan";
    for (const request of requests) expect(request.messages[1].content).toContain(`${line}\n\nLesson summary:`);
  });

  it("never lists the student's own guest name among the other people", async () => {
    // A lower-case guest name survives redaction where the summary capitalises it, but it is still the student.
    const summary = "Overview: Kevin checked the essay. Nathan said he finished it. Ploy said she did not.";
    const { promise, requests } = run([GLM(writerJson), GLM(FAITHFUL)], "summary", summary, ["nathan ipad"]);
    await promise;
    for (const request of requests) expect(request.messages[1].content).toContain("Other people named in the summary (never [STUDENT_1]): Ploy\n");
  });

  it("never gives the other-people line in transcript mode", async () => {
    const { promise, requests } = run([SOL(writerJson), GLM(FAITHFUL)], "transcript", "[00:00] TUTOR: Nathan said he read 8 pages\n[00:05] STUDENT: I read 6");
    await promise;
    for (const request of requests) expect(request.messages[1].content).not.toContain("Other people named");
  });

  it("holds a draft that gives another person's words to the student, as a wrong-person problem", async () => {
    const { promise, records } = run([SOL(writerJson), GLM(MISATTRIBUTED), LUNA(writerJson), GLM(MISATTRIBUTED)]);
    const result = await promise;
    expect(result).toEqual({
      kind: "held",
      reasons: [
        "sol:unfaithful:wrong person: [STUDENT_1] said 8 of the 10 pages have been covered",
        "luna:unfaithful:wrong person: [STUDENT_1] said 8 of the 10 pages have been covered",
      ],
    });
    // Call records keep the three lists as returned, plus the flat list the hold reason uses.
    const recorded = {
      faithful: false,
      unsupported: [],
      misattributed: ["[STUDENT_1] said 8 of the 10 pages have been covered"],
      homeworkNotSet: [],
      problems: ["wrong person: [STUDENT_1] said 8 of the 10 pages have been covered"],
    };
    expect(records.filter((record) => record.role === "judge").map((record) => record.result)).toEqual([
      { ...recorded, judgedArm: "sol", evidence: "summary" },
      { ...recorded, judgedArm: "luna", evidence: "summary" },
    ]);
  });

  it("names wrong-person and homework problems in the held reason ahead of three unsupported claims", async () => {
    // The reason keeps three problems (300 characters) and an alert shows 200: the v4 kinds must come first.
    const verdict = (homeworkNotSet: string[]) => JSON.stringify({
      faithful: false,
      unsupported: ["scored 95% on the test", "read chapter four aloud", "used a timer for every section"],
      misattributed: ["[STUDENT_1] mentioned only 8 pages"],
      homeworkNotSet,
    });
    const { promise } = run([GLM(writerJson), GLM(verdict([])), LUNA(writerJson), GLM(verdict(["finish the three remaining problems"]))]);
    expect(await promise).toEqual({
      kind: "held",
      reasons: [
        "glm:unfaithful:wrong person: [STUDENT_1] mentioned only 8 pages | scored 95% on the test | read chapter four aloud",
        "luna:unfaithful:wrong person: [STUDENT_1] mentioned only 8 pages | homework not set: finish the three remaining problems | " +
          "scored 95% on the test",
      ],
    });
  });

  it("fails closed on a judge reply without the v4 lists: no draft, retried later", async () => {
    const v3 = JSON.stringify({ faithful: true, unsupported: [] });
    const { promise } = run([SOL(writerJson), GLM(v3), GLM(v3)]);
    expect(await promise).toEqual({ kind: "infra", error: "judge:judge_unparseable" });
  });

  it("treats a writer response from another model as infra — never the fallback", async () => {
    const { promise, requests } = run([ok(writerJson, "Azure", "openai/gpt-6-luna")]);
    expect(await promise).toEqual({ kind: "infra", error: "sol:model_mismatch:openai/gpt-6-luna" });
    expect(requests).toHaveLength(1);
  });

  it("treats a judge response from an unpinned host as infra", async () => {
    const { promise } = run([SOL(writerJson), ok(FAITHFUL, "SomeOtherHost", "z-ai/glm-5.3-flash")]);
    expect(await promise).toEqual({ kind: "infra", error: "judge:provider_mismatch:SomeOtherHost" });
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
    expect(routeMismatch(AUTOWRITER_MODELS.judge, ok("x", "Together", "z-ai/glm-6-flash"))).toBe("model_mismatch:z-ai/glm-6-flash");
  });

  it("accepts Sol from any host and rejects any other model for the writer", () => {
    expect(routeMismatch(AUTOWRITER_MODELS.writer, SOL("x"))).toBeNull();
    expect(routeMismatch(AUTOWRITER_MODELS.writer, ok("x", "OpenAI", "openai/gpt-6.1-sol"))).toBeNull();
    expect(routeMismatch(AUTOWRITER_MODELS.writer, LUNA("x"))).toBe("model_mismatch:openai/gpt-6-luna");
    expect(routeMismatch(AUTOWRITER_MODELS.writer, GLM("x"))).toBe("model_mismatch:z-ai/glm-5.3-flash");
    expect(routeMismatch(AUTOWRITER_MODELS.writer, ok("x", "Azure", "openai/gpt-6.1-sol-mini"))).toBe("model_mismatch:openai/gpt-6.1-sol-mini");
    expect(routeMismatch(AUTOWRITER_MODELS.writer, ok("x", "Azure", null))).toBe("model_mismatch:none");
  });
});
