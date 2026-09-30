import { describe, expect, it, vi } from "vitest";
import type { OpenRouterCallResult } from "../openrouter";
import { isInfraFailure, routeMismatch, runWritingPipeline, type CallRecord } from "../pipeline";
import {
  AUTOWRITER_CALL_DEADLINE_MARGIN_MS,
  AUTOWRITER_JUDGE_TIMEOUT_MS,
  AUTOWRITER_MODELS,
  AUTOWRITER_SWEEP_MIN_REMAINING_MS,
  AUTOWRITER_WRITER_TIMEOUT_MS,
} from "../config";
import { JUDGE_PROMPT_VERSION } from "../judge";
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
const PASSING = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
const FAITHFUL = JSON.stringify(PASSING);
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
  schema: object;
  timeoutMs: number;
}

/**
 * Replies per queue, each in call order: `writers` for the writer calls; `judge` for every judge level (each level
 * takes its own copy), unless `medium` or `high` gives that level its own replies.
 */
interface Script {
  writers: OpenRouterCallResult[];
  judge?: OpenRouterCallResult[];
  medium?: OpenRouterCallResult[];
  high?: OpenRouterCallResult[];
}

interface Options {
  evidence?: "summary" | "transcript";
  summaryText?: string;
  studentAliases?: string[];
  /** The function's time left when the pipeline starts. */
  remainingMs?: number;
  /** How long a call takes on the fake clock (default 0): calls made together run together. */
  latencyMs?: (request: Request) => number;
}

function run(script: Script, options: Options = {}) {
  const records: CallRecord[] = [];
  const requests: Request[] = [];
  const queues = {
    writer: [...script.writers],
    medium: [...(script.medium ?? script.judge ?? [])],
    high: [...(script.high ?? script.judge ?? [])],
  };
  let elapsedMs = 0;
  const callModel = vi.fn(async (request: Request) => {
    requests.push(request);
    const startedAt = elapsedMs;
    const reply = (request.schemaName === "post_class_feedback" ? queues.writer : queues[request.effort as "medium" | "high"]).shift();
    if (!reply) throw new Error(`unexpected ${request.schemaName} call at ${request.effort}`);
    // After a tick, so calls started together share their start time.
    await Promise.resolve();
    elapsedMs = Math.max(elapsedMs, startedAt + (options.latencyMs?.(request) ?? 0));
    return reply;
  });
  const promise = runWritingPipeline({
    apiKey: "k",
    session: {
      wiseSessionId: "6a0000000000000000000002",
      studentFullName: STUDENT_NAME,
      studentAliases: options.studentAliases,
      studentDisplayName: "Somchai",
      classDetails: ["Programme: 11+/13+", "Class subject: NVR", "Terms: 11+/13+ = the ISEB 11+/13+ entrance tests"],
      scheduledMinutes: 60,
      summary: { text: options.summaryText ?? SUMMARY, meetingUUIDs: [] },
      evidence: options.evidence ?? "summary",
    },
    tutorNames: ["Kevin Hsieh", "Kev"],
    priorFeedback: [],
    record: async (record) => { records.push(record); },
    remainingMs: () => (options.remainingMs ?? 700_000) - elapsedMs,
    callModel: callModel as never,
  });
  return { promise, records, requests };
}

const judgeRequests = (requests: Request[]) => requests.filter((request) => request.schemaName === "feedback_faithfulness");
const roles = (records: CallRecord[]) => records.map((record) => `${record.role}:${record.arm}`);

describe("runWritingPipeline", () => {
  it("accepts a valid Sol draft that GLM finds faithful at both levels", async () => {
    const { promise, records, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    const result = await promise;
    expect(result).toMatchObject({ kind: "draft", arm: "sol", judge: { ...PASSING, levels: { medium: PASSING, high: PASSING } } });
    expect(roles(records)).toEqual(["writer:sol", "judge:glm", "judge:glm"]);
    expect(requests.map((request) => request.model)).toEqual(["openai/gpt-6.1-sol", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"]);
  });

  it("asks for Sol at reasoning low on a zero-data-retention route, from any ZDR host", async () => {
    const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    await promise;
    expect(requests[0]).toMatchObject({
      model: "openai/gpt-6.1-sol",
      effort: "low",
      schemaName: "post_class_feedback",
      provider: { zdr: true, data_collection: "deny" },
    });
    // Not pinned to one host: zdr alone decides where it may run.
    expect(requests[0].provider.order).toBeUndefined();
    for (const request of judgeRequests(requests)) {
      expect(request).toMatchObject({ model: "z-ai/glm-5.3-flash", provider: { order: ["together"], zdr: true } });
    }

    const otherHost = run({ writers: [ok(writerJson, "OpenAI", "openai/gpt-6.1-sol")], judge: [GLM(FAITHFUL)] });
    expect(await otherHost.promise).toMatchObject({ kind: "draft", arm: "sol" });
  });

  it("never sends student or tutor names to the judge", async () => {
    const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    await promise;
    expect(judgeRequests(requests)).toHaveLength(2);
    for (const request of judgeRequests(requests)) {
      const judgeText = request.messages.map((message) => message.content).join("\n");
      expect(judgeText).not.toMatch(/Somchai|Kevin/u);
      expect(judgeText).toContain("[STUDENT_1]");
    }
  });

  it("gives the judge the same trusted class details the writer had", async () => {
    const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    await promise;
    for (const request of requests) {
      const text = request.messages.map((message) => message.content).join("\n");
      expect(text).toContain("- Programme: 11+/13+");
      expect(text).toContain("- Class subject: NVR");
    }
    for (const request of judgeRequests(requests)) {
      expect(request.messages[0].content).toContain("naming the programme, exam or subject they give is supported");
    }
  });

  it("falls back to Luna when the Sol draft is unfaithful, and has GLM judge it", async () => {
    const { promise, records, requests } = run({ writers: [SOL(writerJson), LUNA(writerJson)], judge: [GLM(UNFAITHFUL), GLM(FAITHFUL)] });
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(roles(records)).toEqual(["writer:sol", "judge:glm", "judge:glm", "writer:luna", "judge:glm", "judge:glm"]);
    expect(requests[3]).toMatchObject({ model: "openai/gpt-6-luna", effort: "max", provider: { zdr: true, data_collection: "deny" } });
  });

  it("holds when both drafts fail content checks", async () => {
    const { promise } = run({ writers: [SOL(JSON.stringify({ ...JSON.parse(writerJson), topics: "Fractions." })), LUNA("not json")] });
    const result = await promise;
    expect(result.kind).toBe("held");
    if (result.kind === "held") expect(result.reasons.length).toBeGreaterThan(1);
  });

  it("treats an OpenRouter outage or missing credit as infra, not a hold", async () => {
    expect(await run({ writers: [fail("Insufficient credits", 402)] }).promise)
      .toEqual({ kind: "infra", error: "sol:Insufficient credits", modelFailure: false, stage: "writer" });
    expect(await run({ writers: [fail("timeout", null)] }).promise)
      .toEqual({ kind: "infra", error: "sol:timeout", modelFailure: true, stage: "writer" });
  });

  it("tells whose call failed, and the models' failures from our account's, our connection's and our function's time", async () => {
    // Transcript first counts only […, true, "writer"]: the writer's own failures.
    const infra = async (script: Script, remainingMs = 700_000) => {
      const result = await run(script, { evidence: "transcript", remainingMs }).promise;
      return result.kind === "infra" ? [result.error, result.modelFailure, result.stage] : result.kind;
    };
    const written = [SOL(writerJson)];
    // The writer: a time-out, a reply that is not JSON, a provider error, the wrong model.
    expect(await infra({ writers: [fail("timeout", null)] })).toEqual(["sol:timeout", true, "writer"]);
    expect(await infra({ writers: [fail("invalid_json_response", 502)] })).toEqual(["sol:invalid_json_response", true, "writer"]);
    expect(await infra({ writers: [fail("Provider returned error", 500)] })).toEqual(["sol:Provider returned error", true, "writer"]);
    expect(await infra({ writers: [ok(writerJson, "Azure", "openai/gpt-6-luna")] })).toEqual(["sol:model_mismatch:openai/gpt-6-luna", true, "writer"]);
    // The judge, at either level: a time-out, or no verdict in two tries. The writer had delivered.
    expect(await infra({ writers: written, medium: [GLM(FAITHFUL)], high: [fail("timeout", null)] })).toEqual(["judge:high:timeout", true, "judge"]);
    expect(await infra({ writers: written, medium: [fail("timeout", null)], high: [GLM(FAITHFUL)] })).toEqual(["judge:medium:timeout", true, "judge"]);
    expect(await infra({ writers: written, medium: [GLM("not json"), GLM("{}")], high: [GLM(FAITHFUL)] }))
      .toEqual(["judge:medium:judge_unparseable", true, "judge"]);
    // Ours: a bad key, no credit, rate limited, the connection, and a time-out on a call our remaining time cut short.
    expect(await infra({ writers: [fail("User not found", 401)] })).toEqual(["sol:User not found", false, "writer"]);
    expect(await infra({ writers: written, judge: [fail("Insufficient credits", 402)] })).toEqual(["judge:medium:Insufficient credits", false, "judge"]);
    expect(await infra({ writers: [fail("Rate limit exceeded", 429)] })).toEqual(["sol:Rate limit exceeded", false, "writer"]);
    expect(await infra({ writers: [fail("network_TypeError", null)] })).toEqual(["sol:network_TypeError", false, "writer"]);
    expect(await infra({ writers: [fail("timeout", null)] }, 150_000)).toEqual(["sol:timeout", false, "writer"]);
    expect(await infra({ writers: [] }, 60_000)).toEqual(["function_budget_exhausted", false, "writer"]);
  });

  it("never sends the summary to the fallback host after a provider-side generation error", async () => {
    const errored: OpenRouterCallResult = { ...fail("finish_reason_error", 200), finishReason: "error" };
    const { promise, requests } = run({ writers: [errored] });
    expect(await promise).toEqual({ kind: "infra", error: "sol:finish_reason_error", modelFailure: true, stage: "writer" });
    expect(requests).toHaveLength(1);
  });

  it("treats a moderation refusal as the text's problem and tries the fallback writer", async () => {
    const { promise, records } = run({ writers: [fail("Input flagged by moderation", 403), LUNA(writerJson)], judge: [GLM(FAITHFUL)] });
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(roles(records)).toEqual(["writer:sol", "writer:luna", "judge:glm", "judge:glm"]);
  });

  it("gives a judge level a second try, then retries later instead of falling back", async () => {
    // Only the level whose reply was unusable is asked again.
    const once = run({ writers: [SOL(writerJson)], medium: [GLM("not json"), GLM(FAITHFUL)], high: [GLM(FAITHFUL)] });
    expect(await once.promise).toMatchObject({ kind: "draft", arm: "sol" });
    expect(judgeRequests(once.requests).map((request) => request.effort).toSorted()).toEqual(["high", "medium", "medium"]);

    const twice = run({ writers: [SOL(writerJson)], medium: [GLM(FAITHFUL)], high: [GLM("not json"), GLM("{}")] });
    expect(await twice.promise).toEqual({ kind: "infra", error: "judge:high:judge_unparseable", modelFailure: true, stage: "judge" });
    expect(twice.requests.map((request) => request.model)).not.toContain("openai/gpt-6-luna");
  });

  it("writes from a transcript with Sol and falls back to Luna on a content failure — every route zero-retention", async () => {
    const { promise, records, requests } = run(
      { writers: [SOL(writerJson), LUNA(writerJson)], judge: [GLM(UNFAITHFUL), GLM(FAITHFUL)] }, { evidence: "transcript" },
    );
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(requests.map((request) => request.model)).toEqual([
      "openai/gpt-6.1-sol", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash", "openai/gpt-6-luna", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash",
    ]);
    for (const request of requests) expect(request.provider).toMatchObject({ zdr: true, data_collection: "deny" });
    expect(records.every((record) => record.result.evidence === "transcript")).toBe(true);
    expect(requests[1].messages.map((message) => message.content).join("\n")).toContain("Lesson transcript:");
    // Without Zoom's confirmation both writers and the judge are told the labels are inferred.
    for (const request of requests) expect(request.messages[0].content).toContain(speakerLabelNote("inferred"));
  });

  it("holds a transcript draft when Luna fails too", async () => {
    const { promise } = run({ writers: [SOL(writerJson), LUNA("not json")], judge: [GLM(UNFAITHFUL)] }, { evidence: "transcript" });
    const result = await promise;
    expect(result.kind).toBe("held");
    if (result.kind === "held") expect(result.reasons).toEqual([expect.stringMatching(/^sol:unfaithful:/u), expect.stringMatching(/^luna:/u)]);
  });

  it("writes at low effort (Sol) and judges at medium and at high (v5)", async () => {
    const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    await promise;
    expect(requests.map((request) => request.effort)).toEqual(["low", "medium", "high"]);
  });

  it("tells the writer and the judge which other people the summary names", async () => {
    const summary = "Overview: Kevin was worried the exam preparation was incomplete; Nathan mentioned only 8 pages. Somchai practised fractions.";
    const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }, { summaryText: summary });
    await promise;
    const line = "Other people named in the summary (never [STUDENT_1]): Nathan";
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.messages[1].content).toContain(`${line}\n\nLesson summary:`);
  });

  it("never lists the student's own guest name among the other people", async () => {
    // A lower-case guest name survives redaction where the summary capitalises it, but it is still the student.
    const summary = "Overview: Kevin checked the essay. Nathan said he finished it. Ploy said she did not.";
    const { promise, requests } = run(
      { writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }, { summaryText: summary, studentAliases: ["nathan ipad"] },
    );
    await promise;
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.messages[1].content).toContain("Other people named in the summary (never [STUDENT_1]): Ploy\n");
  });

  it("never gives the other-people line in transcript mode", async () => {
    const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }, {
      evidence: "transcript", summaryText: "[00:00] TUTOR: Nathan said he read 8 pages\n[00:05] STUDENT: I read 6",
    });
    await promise;
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.messages[1].content).not.toContain("Other people named");
  });

  it("holds a draft that gives another person's words to the student, as a wrong-person problem", async () => {
    const { promise, records } = run({ writers: [SOL(writerJson), LUNA(writerJson)], judge: [GLM(MISATTRIBUTED), GLM(MISATTRIBUTED)] });
    const result = await promise;
    // Both levels quote the same words: listed once.
    expect(result).toEqual({
      kind: "held",
      reasons: [
        "sol:unfaithful:wrong person: [STUDENT_1] said 8 of the 10 pages have been covered",
        "luna:unfaithful:wrong person: [STUDENT_1] said 8 of the 10 pages have been covered",
      ],
    });
    // Call records keep the three lists as returned, plus the flat list the hold reason uses — one per level.
    const recorded = {
      faithful: false,
      unsupported: [],
      misattributed: ["[STUDENT_1] said 8 of the 10 pages have been covered"],
      homeworkNotSet: [],
      problems: ["wrong person: [STUDENT_1] said 8 of the 10 pages have been covered"],
      judgedGeneration: "g",
      evidence: "summary",
    };
    expect(records.filter((record) => record.role === "judge").map((record) => record.result)).toEqual([
      { ...recorded, effort: "medium", judgedArm: "sol" },
      { ...recorded, effort: "high", judgedArm: "sol" },
      { ...recorded, effort: "medium", judgedArm: "luna" },
      { ...recorded, effort: "high", judgedArm: "luna" },
    ]);
  });

  it("names wrong-person and homework problems in the held reason ahead of three unsupported claims", async () => {
    // The reason keeps three problems (300 characters) and an alert shows 200: the v4 kinds must come first.
    const verdict = (homeworkNotSet: string[]) => GLM(JSON.stringify({
      faithful: false,
      unsupported: ["scored 95% on the test", "read chapter four aloud", "used a timer for every section"],
      misattributed: ["[STUDENT_1] mentioned only 8 pages"],
      homeworkNotSet,
    }));
    const { promise } = run({
      writers: [SOL(writerJson), LUNA(writerJson)], judge: [verdict([]), verdict(["finish the three remaining problems"])],
    });
    expect(await promise).toEqual({
      kind: "held",
      reasons: [
        "sol:unfaithful:wrong person: [STUDENT_1] mentioned only 8 pages | scored 95% on the test | read chapter four aloud",
        "luna:unfaithful:wrong person: [STUDENT_1] mentioned only 8 pages | homework not set: finish the three remaining problems | " +
          "scored 95% on the test",
      ],
    });
  });

  it("fails closed on a judge reply without the v4 lists: no draft, retried later", async () => {
    const v3 = GLM(JSON.stringify({ faithful: true, unsupported: [] }));
    const { promise } = run({ writers: [SOL(writerJson)], judge: [v3, v3] });
    expect(await promise).toEqual({ kind: "infra", error: "judge:medium:judge_unparseable", modelFailure: true, stage: "judge" });
  });

  it("treats a writer response from another model as infra — never the fallback", async () => {
    const { promise, requests } = run({ writers: [ok(writerJson, "Azure", "openai/gpt-6-luna")] });
    expect(await promise).toEqual({ kind: "infra", error: "sol:model_mismatch:openai/gpt-6-luna", modelFailure: true, stage: "writer" });
    expect(requests).toHaveLength(1);
  });

  it("treats a judge response from an unpinned host as infra, at either level", async () => {
    const { promise } = run({ writers: [SOL(writerJson)], medium: [GLM(FAITHFUL)], high: [ok(FAITHFUL, "SomeOtherHost", "z-ai/glm-5.3-flash")] });
    expect(await promise).toEqual({ kind: "infra", error: "judge:high:provider_mismatch:SomeOtherHost", modelFailure: true, stage: "judge" });
  });
});

describe("judge v5: medium and high must both pass (owner decision, 30 Sep)", () => {
  it("judges at both levels on byte-identical messages, for a summary and a transcript", async () => {
    for (const evidence of ["summary", "transcript"] as const) {
      const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }, { evidence });
      await promise;
      const [medium, high] = judgeRequests(requests);
      expect([medium.effort, high.effort], evidence).toEqual(["medium", "high"]);
      expect(JSON.stringify(high.messages), evidence).toBe(JSON.stringify(medium.messages));
      // Everything but the effort is the same request.
      expect({ ...high, effort: null }, evidence).toEqual({ ...medium, effort: null });
      expect(high.schemaName).toBe("feedback_faithfulness");
    }
  });

  it("runs the two levels in parallel: both are asked before either answers", async () => {
    const asked: string[] = [];
    let answer = () => {};
    const bothAsked = new Promise<void>((resolve) => { answer = resolve; });
    const callModel = vi.fn(async (request: Request) => {
      if (request.schemaName === "post_class_feedback") return SOL(writerJson);
      asked.push(request.effort);
      // Neither level answers until both have been asked: in sequence this would never finish.
      if (asked.length === 2) answer();
      await bothAsked;
      return GLM(FAITHFUL);
    });
    const result = await runWritingPipeline({
      apiKey: "k",
      session: {
        wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
        classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] },
      },
      tutorNames: ["Kevin Hsieh", "Kev"],
      priorFeedback: [],
      record: async () => {},
      remainingMs: () => 700_000,
      callModel: callModel as never,
    });
    expect(result.kind).toBe("draft");
    expect(asked).toEqual(["medium", "high"]);
  });

  it("passes a draft only when both levels find it faithful: either level alone rejects it", async () => {
    const draft = { writers: [SOL(writerJson), LUNA(writerJson)] };
    const onlyMedium = run({ ...draft, medium: [GLM(UNFAITHFUL), GLM(FAITHFUL)], high: [GLM(FAITHFUL), GLM(FAITHFUL)] });
    expect(await onlyMedium.promise).toMatchObject({ kind: "draft", arm: "luna" });
    const onlyHigh = run({ ...draft, medium: [GLM(FAITHFUL), GLM(FAITHFUL)], high: [GLM(MISATTRIBUTED), GLM(FAITHFUL)] });
    expect(await onlyHigh.promise).toMatchObject({ kind: "draft", arm: "luna" });

    // Neither writer's draft passes both levels: held, each time for what the one level found.
    const held = run({ ...draft, medium: [GLM(FAITHFUL), GLM(UNFAITHFUL)], high: [GLM(MISATTRIBUTED), GLM(FAITHFUL)] });
    expect(await held.promise).toEqual({
      kind: "held",
      reasons: [
        "sol:unfaithful:wrong person: [STUDENT_1] said 8 of the 10 pages have been covered",
        "luna:unfaithful:scored 95%",
      ],
    });
  });

  it("holds for the union of both verdicts, each problem once, in the usual order", async () => {
    const medium = GLM(JSON.stringify({ faithful: false, unsupported: ["scored 95%"], misattributed: [], homeworkNotSet: ["three problems by Friday"] }));
    const high = GLM(JSON.stringify({ faithful: false, unsupported: ["scored 95%"], misattributed: ["[STUDENT_1] said 8 pages"], homeworkNotSet: [] }));
    const { promise } = run({ writers: [SOL(writerJson), LUNA("not json")], medium: [medium], high: [high] });
    expect(await promise).toEqual({
      kind: "held",
      reasons: [
        "sol:unfaithful:wrong person: [STUDENT_1] said 8 pages | homework not set: three problems by Friday | scored 95%",
        "luna:output_not_json",
      ],
    });
  });

  it("stores both levels' verdicts with the draft, and their union", async () => {
    const { promise } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    const result = await promise;
    expect(result.kind === "draft" ? result.judge : null).toEqual({ ...PASSING, levels: { medium: PASSING, high: PASSING } });
  });

  it("records both judge calls with their effort, as judge v5", async () => {
    const { promise, records } = run({ writers: [SOL(writerJson)], medium: [GLM("not json"), GLM(FAITHFUL)], high: [GLM(FAITHFUL)] });
    await promise;
    const judged = records.filter((record) => record.role === "judge");
    expect(judged.map((record) => [record.result.effort, record.result.error ?? record.result.faithful]).toSorted()).toEqual([
      ["high", true], ["medium", "judge_unparseable"], ["medium", true],
    ]);
    expect(JUDGE_PROMPT_VERSION).toBe(5);
    for (const record of judged) {
      expect(record).toMatchObject({ arm: "glm", requestedModel: "z-ai/glm-5.3-flash", promptVersion: JUDGE_PROMPT_VERSION });
      expect(record.result).toMatchObject({ judgedArm: "sol", judgedGeneration: "g", evidence: "summary" });
    }
  });

  it("rethrows an unexpected error from one level once both have settled", async () => {
    const callModel = vi.fn(async (request: Request) => {
      if (request.schemaName === "post_class_feedback") return SOL(writerJson);
      if (request.effort === "high") throw new Error("socket hang up");
      return GLM(FAITHFUL);
    });
    const records: CallRecord[] = [];
    await expect(runWritingPipeline({
      apiKey: "k",
      session: {
        wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
        classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] },
      },
      tutorNames: ["Kevin Hsieh", "Kev"],
      priorFeedback: [],
      record: async (record) => { records.push(record); },
      remainingMs: () => 700_000,
      callModel: callModel as never,
    })).rejects.toThrow("socket hang up");
    // The other level finished (and was recorded) first.
    expect(records.filter((record) => record.role === "judge").map((record) => record.result.effort)).toEqual(["medium"]);
  });
});

describe("time budget (owner decision, 30 Sep: a longer judge time-out on transcripts)", () => {
  const timeouts = (requests: Request[]) => requests.map((request) => request.timeoutMs);

  it("gives the judges 240 s on a transcript and 120 s on a summary; the writer 180 s", async () => {
    expect(AUTOWRITER_JUDGE_TIMEOUT_MS).toEqual({ summary: 120_000, transcript: 240_000 });
    const transcript = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }, { evidence: "transcript" });
    await transcript.promise;
    expect(timeouts(transcript.requests)).toEqual([180_000, 240_000, 240_000]);
    const summary = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    await summary.promise;
    expect(timeouts(summary.requests)).toEqual([180_000, 120_000, 120_000]);
  });

  it("never starts a judge without its full time-out: the class retries with a fresh function instead", async () => {
    const script = () => ({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    const margin = AUTOWRITER_CALL_DEADLINE_MARGIN_MS;
    // One millisecond short of the transcript judge's 240 s: the writer runs (cut to what is left), no judge is asked.
    const short = run(script(), { evidence: "transcript", remainingMs: 240_000 + margin - 1 });
    expect(await short.promise).toEqual({ kind: "infra", error: "function_budget_exhausted", modelFailure: false, stage: "judge" });
    expect(judgeRequests(short.requests)).toEqual([]);
    expect(timeouts(short.requests)).toEqual([180_000]);
    // Exactly enough: both levels run with the full time-out.
    const enough = run(script(), { evidence: "transcript", remainingMs: 240_000 + margin });
    expect(await enough.promise).toMatchObject({ kind: "draft" });
    expect(timeouts(judgeRequests(enough.requests))).toEqual([240_000, 240_000]);
    // A summary's judges need 120 s.
    const summaryShort = run(script(), { remainingMs: 120_000 + margin - 1 });
    expect(await summaryShort.promise).toMatchObject({ kind: "infra", error: "function_budget_exhausted", stage: "judge" });
    const summaryEnough = run(script(), { remainingMs: 120_000 + margin });
    expect(await summaryEnough.promise).toMatchObject({ kind: "draft" });
    expect(timeouts(judgeRequests(summaryEnough.requests))).toEqual([120_000, 120_000]);
  });

  it("still cuts a writer's time-out to what is left, down to 30 s", async () => {
    const cut = run({ writers: [fail("timeout", null)] }, { remainingMs: 100_000 });
    await cut.promise;
    expect(timeouts(cut.requests)).toEqual([100_000 - AUTOWRITER_CALL_DEADLINE_MARGIN_MS]);
    const none = run({ writers: [] }, { remainingMs: 30_000 + AUTOWRITER_CALL_DEADLINE_MARGIN_MS - 1 });
    expect(await none.promise).toEqual({ kind: "infra", error: "function_budget_exhausted", modelFailure: false, stage: "writer" });
  });

  it("in any session a sweep or a webhook starts, both judges get their full time-out even after the slowest writer", async () => {
    // Every entry point leaves AUTOWRITER_SWEEP_MIN_REMAINING_MS for one session's models and its POST.
    const slowestWriter = (request: Request) => request.schemaName === "post_class_feedback" ? AUTOWRITER_WRITER_TIMEOUT_MS : 0;
    for (const evidence of ["summary", "transcript"] as const) {
      const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }, {
        evidence, remainingMs: AUTOWRITER_SWEEP_MIN_REMAINING_MS, latencyMs: slowestWriter,
      });
      expect(await promise, evidence).toMatchObject({ kind: "draft" });
      expect(timeouts(judgeRequests(requests)), evidence).toEqual(Array(2).fill(AUTOWRITER_JUDGE_TIMEOUT_MS[evidence]));
    }
    // The spare time before the writer (Wise reads, the transcript fetch): 95 s on a transcript.
    expect(AUTOWRITER_SWEEP_MIN_REMAINING_MS - AUTOWRITER_WRITER_TIMEOUT_MS - AUTOWRITER_CALL_DEADLINE_MARGIN_MS - AUTOWRITER_JUDGE_TIMEOUT_MS.transcript)
      .toBe(95_000);
  });

  it("counts the two levels' time once (they run together), and does not start a second try that no longer fits", async () => {
    // Both levels take the whole 240 s and medium's reply is unusable: 560 − 180 − 240 = 140 s are left, not enough
    // for medium's second try, so none is made.
    const everyCallSlow = (request: Request) => request.schemaName === "post_class_feedback" ? AUTOWRITER_WRITER_TIMEOUT_MS : 240_000;
    const { promise, requests } = run({ writers: [SOL(writerJson)], medium: [GLM("not json"), GLM(FAITHFUL)], high: [GLM(FAITHFUL)] }, {
      evidence: "transcript", remainingMs: AUTOWRITER_SWEEP_MIN_REMAINING_MS, latencyMs: everyCallSlow,
    });
    expect(await promise).toEqual({ kind: "infra", error: "function_budget_exhausted", modelFailure: false, stage: "judge" });
    expect(judgeRequests(requests).map((request) => request.effort)).toEqual(["medium", "high"]);

    // With time to spare the second try is made, with its full time-out.
    const roomy = run({ writers: [SOL(writerJson)], medium: [GLM("not json"), GLM(FAITHFUL)], high: [GLM(FAITHFUL)] }, {
      evidence: "transcript", remainingMs: 700_000, latencyMs: (request) => request.schemaName === "post_class_feedback" ? 6_000 : 60_000,
    });
    expect(await roomy.promise).toMatchObject({ kind: "draft" });
    expect(timeouts(judgeRequests(roomy.requests))).toEqual([240_000, 240_000, 240_000]);
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
