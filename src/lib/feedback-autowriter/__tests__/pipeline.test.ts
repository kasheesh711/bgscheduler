import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAutowriterDashboard, type DashboardCallRow } from "../dashboard";
import { callOpenRouter, type OpenRouterCallResult } from "../openrouter";
import { isInfraFailure, routeMismatch, runWritingPipeline, type CallRecord, type RateLimitRetries } from "../pipeline";
import {
  AUTOWRITER_CALL_DEADLINE_MARGIN_MS,
  AUTOWRITER_JUDGE_TIMEOUT_MS,
  AUTOWRITER_MODELS,
  AUTOWRITER_SWEEP_MIN_REMAINING_MS,
  AUTOWRITER_WRITER_TIMEOUT_MS,
} from "../config";
import { JUDGE_PROMPT_VERSION } from "../judge";
import { speakerLabelNote } from "../prompt";
import { MIMI_STYLE_GUIDE, type FeedbackStyleGuide } from "../style";
import { buildSystemStatus } from "../system-status";
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
  canonicalTutorKey?: string;
  styleGuide?: FeedbackStyleGuide | null;
  evidence?: "summary" | "transcript";
  summaryText?: string;
  studentAliases?: string[];
  /** The function's time left when the pipeline starts. */
  remainingMs?: number;
  /** How long a call takes on the fake clock (default 0): calls made together run together. */
  latencyMs?: (request: Request) => number;
  /** The spread of a rate-limit retry's wait (default 0.5: exactly the schedule's 4 s, 10 s and 25 s). */
  random?: () => number;
  /** False for a stage: a sweep that has met a lasting rate limit there — no in-run retries of that stage's calls. */
  rateLimitRetries?: RateLimitRetries;
}

function run(script: Script, options: Options = {}) {
  const records: CallRecord[] = [];
  const requests: Request[] = [];
  /** Every wait before a rate-limited call was tried again, as asked for. */
  const waits: number[] = [];
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
    styleGuide: options.styleGuide,
    session: {
      canonicalTutorKey: options.canonicalTutorKey,
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
    // A wait takes its time on the fake clock, like a call: waits made together pass together.
    sleep: async (ms) => {
      waits.push(ms);
      const startedAt = elapsedMs;
      await Promise.resolve();
      elapsedMs = Math.max(elapsedMs, startedAt + ms);
    },
    random: options.random ?? (() => 0.5),
    rateLimitRetries: options.rateLimitRetries,
  });
  return { promise, records, requests, waits };
}

const judgeRequests = (requests: Request[]) => requests.filter((request) => request.schemaName === "feedback_faithfulness");
const writerRequests = (requests: Request[]) => requests.filter((request) => request.schemaName === "post_class_feedback");
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
    // (A rate limit is first tried again in the same run, three times: see the retries below.)
    expect(await infra({ writers: Array(4).fill(fail("Rate limit exceeded", 429)) })).toEqual(["sol:Rate limit exceeded", false, "writer"]);
    expect(await infra({ writers: [fail("network_TypeError", null)] })).toEqual(["sol:network_TypeError", false, "writer"]);
    expect(await infra({ writers: [fail("timeout", null)] }, 150_000)).toEqual(["sol:timeout", false, "writer"]);
    expect(await infra({ writers: [] }, 60_000)).toEqual(["function_budget_exhausted", false, "writer"]);
  });

  it("never takes an upstream rate limit for the writer's failure, though OpenRouter reports it inside a 200 response", async () => {
    // 30 Sep replay: Sol's route was rate-limited upstream; the error came as HTTP 200 with code 429 in the body.
    const message = "openai/gpt-6.1-sol is temporarily rate-limited upstream. Please retry shortly.";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message, code: 429 } }), { status: 200 }));
    const result = await runWritingPipeline({
      apiKey: "k",
      session: {
        wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
        classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] }, evidence: "transcript",
      },
      tutorNames: ["Kevin Hsieh", "Kev"],
      priorFeedback: [],
      record: async () => {},
      remainingMs: () => 700_000,
      callModel: (request) => callOpenRouter({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch }),
      sleep: async () => {},
    });
    // Retried later, never counted toward `writer_failed` and never sent on to the fallback writer.
    expect(result).toEqual({ kind: "infra", error: `sol:${message}`, modelFailure: false, stage: "writer", rateLimited: true });
    // The first request and its three retries in this run, all to the writer's own model.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const models = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).map(([, init]) => JSON.parse(init.body as string).model);
    expect(models).toEqual(Array(4).fill("openai/gpt-6.1-sol"));
  });

  it("never takes a rate limit for the writer's failure in any form OpenRouter reports it: the code as text, or carried on the choice", async () => {
    const message = "openai/gpt-6.1-sol is temporarily rate-limited upstream. Please retry shortly.";
    const forms: Array<[string, unknown]> = [
      ["code as text", { error: { message, code: "429" } }],
      ["on the choice", { model: "openai/gpt-6.1-sol", provider: "Azure", choices: [{ finish_reason: "error", message: { content: "" }, error: { message, code: 429 } }] }],
      ["on the choice, code as text", { choices: [{ finish_reason: "error", message: { content: "" }, error: { message, code: "429" } }] }],
    ];
    for (const [label, body] of forms) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
      const result = await runWritingPipeline({
        apiKey: "k",
        session: {
          wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
          classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] }, evidence: "transcript",
        },
        tutorNames: ["Kevin Hsieh", "Kev"],
        priorFeedback: [],
        record: async () => {},
        remainingMs: () => 700_000,
        callModel: (request) => callOpenRouter({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch }),
        sleep: async () => {},
      });
      // Not the writer's failure (`modelFailure: false`), tried again in the run, and never sent on to the fallback
      // writer — a generation error carried on the choice would otherwise count as the model's (`finish_reason_error`).
      expect(result, label).toEqual({ kind: "infra", error: `sol:${message}`, modelFailure: false, stage: "writer", rateLimited: true });
      expect(fetchImpl, label).toHaveBeenCalledTimes(4);
    }
    // Any other error on the choice is still the model's own generation error: not retried here, counted as before.
    const other = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "error", message: { content: "" }, error: { message: "Provider returned error", code: 502 } }],
    }), { status: 200 }));
    expect(await runWritingPipeline({
      apiKey: "k",
      session: {
        wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
        classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] }, evidence: "transcript",
      },
      tutorNames: ["Kevin Hsieh", "Kev"],
      priorFeedback: [],
      record: async () => {},
      remainingMs: () => 700_000,
      callModel: (request) => callOpenRouter({ ...request, fetchImpl: other as unknown as typeof fetch }),
      sleep: async () => {},
    })).toEqual({ kind: "infra", error: "sol:finish_reason_error", modelFailure: true, stage: "writer" });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("never takes an HTTP 429 for the writer's failure when its body is not JSON (a proxy's error page)", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>Too Many Requests</html>", { status: 429 }));
    const result = await runWritingPipeline({
      apiKey: "k",
      session: {
        wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
        classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] }, evidence: "transcript",
      },
      tutorNames: ["Kevin Hsieh", "Kev"],
      priorFeedback: [],
      record: async () => {},
      remainingMs: () => 700_000,
      callModel: (request) => callOpenRouter({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch }),
      sleep: async () => {},
    });
    // A reply that is not JSON counts as the writer's own failure on any other status; on a 429 it is the rate limit.
    expect(result).toEqual({ kind: "infra", error: "sol:invalid_json_response", modelFailure: false, stage: "writer", rateLimited: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
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

describe("per-tutor writer order (owner decision, 2 Oct: Luna first for the 13 tutors added that day)", () => {
  it("writes an added tutor's class with Luna at reasoning max first, judged by GLM", async () => {
    const { promise, records, requests } = run({ writers: [LUNA(writerJson)], judge: [GLM(FAITHFUL)] }, { canonicalTutorKey: "Celeste" });
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(roles(records)).toEqual(["writer:luna", "judge:glm", "judge:glm"]);
    expect(requests[0]).toMatchObject({ model: "openai/gpt-6-luna", effort: "max", provider: { zdr: true, data_collection: "deny" } });
  });

  it("falls back to Sol when the Luna draft is unfaithful", async () => {
    const { promise, records, requests } = run(
      { writers: [LUNA(writerJson), SOL(writerJson)], judge: [GLM(UNFAITHFUL), GLM(FAITHFUL)] }, { canonicalTutorKey: "Mint" },
    );
    expect(await promise).toMatchObject({ kind: "draft", arm: "sol" });
    expect(roles(records)).toEqual(["writer:luna", "judge:glm", "judge:glm", "writer:sol", "judge:glm", "judge:glm"]);
    expect(requests[3]).toMatchObject({ model: "openai/gpt-6.1-sol", effort: "low" });
  });

  it("keeps Sol first for the first five tutors and for a session without a tutor key", async () => {
    for (const canonicalTutorKey of ["Kevin", undefined]) {
      const { promise, requests } = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }, { canonicalTutorKey });
      expect(await promise).toMatchObject({ kind: "draft", arm: "sol" });
      expect(requests[0]).toMatchObject({ model: "openai/gpt-6.1-sol", effort: "low" });
    }
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
    expect(JUDGE_PROMPT_VERSION).toBe(6);
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

describe("a rate-limited call is tried again in the same run (owner decision, 30 Sep)", () => {
  // As OpenRouter words the writer route's upstream limit (HTTP 200, code 429 in the body → `httpStatus` 429).
  const LIMITED = "openai/gpt-6.1-sol is temporarily rate-limited upstream. Please retry shortly.";
  const limited = (retryAfterMs?: number): OpenRouterCallResult => ({ ...fail(LIMITED, 429), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  const timeouts = (requests: Request[]) => requests.map((request) => request.timeoutMs);
  const written = (records: CallRecord[], role: "writer" | "judge" = "writer") => records.filter((record) => record.role === role)
    .map((record) => [record.call.ok, record.call.usage?.costUsd ?? 0, record.result]);
  /** What a rate-limited attempt records besides its error: when its request was sent, and the wait that followed (if any). */
  const sent = (waitedMs?: number) => ({ attemptAt: expect.any(String), ...(waitedMs === undefined ? {} : { waitedMs }) });

  it("writes and judges the draft in the same run when the writer is rate limited once or twice", async () => {
    for (const times of [1, 2]) {
      const { promise, records, requests, waits } = run({ writers: [...Array(times).fill(limited()), SOL(writerJson)], judge: [GLM(FAITHFUL)] });
      expect(await promise, `${times}`).toMatchObject({ kind: "draft", arm: "sol", judge: { ...PASSING, levels: { medium: PASSING, high: PASSING } } });
      // The same request again, to the same model and with the same time-out — then the judges, as for any draft.
      const writes = writerRequests(requests);
      expect(writes, `${times}`).toHaveLength(times + 1);
      for (const request of writes) expect(request).toEqual(writes[0]);
      expect(requests.map((request) => request.model), `${times}`).toEqual([
        ...Array(times + 1).fill("openai/gpt-6.1-sol"), "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash",
      ]);
      expect(waits, `${times}`).toEqual([4_000, 10_000].slice(0, times));
      // One call record per attempt: a rate-limited one cost nothing, and every retry says which retry it was.
      expect(written(records), `${times}`).toEqual([
        [false, 0, { error: LIMITED, evidence: "summary", ...sent(4_000) }],
        ...(times === 2 ? [[false, 0, { error: LIMITED, evidence: "summary", rateLimitRetry: 1, ...sent(10_000) }]] : []),
        [true, usage.costUsd, { validation: "ok", evidence: "summary", rateLimitRetry: times }],
      ]);
      // A call that was never rate limited carries no mark.
      for (const record of records.filter((entry) => entry.role === "judge")) expect(record.result).not.toHaveProperty("rateLimitRetry");
    }
  });

  it("gives up after three retries with the outcome it had before: retried later, not the writer's failure, no fallback writer", async () => {
    for (const evidence of ["summary", "transcript"] as const) {
      const { promise, records, requests, waits } = run({ writers: Array(4).fill(limited()) }, { evidence });
      // `modelFailure: false`: transcript first never counts it toward `writer_failed`.
      expect(await promise, evidence).toEqual({ kind: "infra", error: `sol:${LIMITED}`, modelFailure: false, stage: "writer", rateLimited: true });
      expect(requests.map((request) => request.model), evidence).toEqual(Array(4).fill("openai/gpt-6.1-sol"));
      expect(waits, evidence).toEqual([4_000, 10_000, 25_000]);
      // No wait follows the last attempt.
      expect(written(records), evidence).toEqual([
        [false, 0, { error: LIMITED, evidence, ...sent(4_000) }],
        [false, 0, { error: LIMITED, evidence, rateLimitRetry: 1, ...sent(10_000) }],
        [false, 0, { error: LIMITED, evidence, rateLimitRetry: 2, ...sent(25_000) }],
        [false, 0, { error: LIMITED, evidence, rateLimitRetry: 3, ...sent() }],
      ]);
    }
  });

  it("spreads every wait ±30% at random, and never waits more than 45 s for one call", async () => {
    const attempt = async (random: () => number) => {
      const { promise, waits } = run({ writers: Array(4).fill(limited()) }, { random });
      await promise;
      return waits;
    };
    expect(await attempt(() => 0)).toEqual([2_800, 7_000, 17_500]);
    // At the top of the spread the third wait (up to 32.5 s) is cut to what is left of the 45 s.
    const longest = await attempt(() => 0.999_999);
    expect(longest).toEqual([5_200, 13_000, 26_800]);
    expect(longest.reduce((sum, wait) => sum + wait, 0)).toBe(45_000);
    // With the real random source: every wait inside its band, and never two classes on the same beat.
    const bands = [[2_800, 5_200], [7_000, 13_000], [17_500, 32_500]];
    const seen = new Set<string>();
    for (let sample = 0; sample < 25; sample += 1) {
      const waits = await attempt(Math.random);
      expect(waits).toHaveLength(3);
      for (const [index, wait] of waits.entries()) {
        expect(wait).toBeGreaterThanOrEqual(bands[index][0]);
        expect(wait).toBeLessThanOrEqual(bands[index][1]);
      }
      expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(45_000);
      seen.add(waits.join());
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it("waits as long as OpenRouter asks when it says: never less than it, nor than the schedule's wait, and up to 30 s", async () => {
    const attempt = async (retryAfterMs: number, random?: () => number) => {
      const { promise, waits, records } = run({ writers: [limited(retryAfterMs), SOL(writerJson)], judge: [GLM(FAITHFUL)] }, { random });
      expect(await promise).toMatchObject({ kind: "draft" });
      // The record of the rate-limited attempt keeps what was asked and what was waited.
      expect(written(records)[0]).toEqual([false, 0, { error: LIMITED, evidence: "summary", retryAfterMs, ...sent(waits[0]) }]);
      return waits;
    };
    expect(await attempt(7_000, () => 0)).toEqual([7_000]);
    // The spread only adds to it: trying before the time OpenRouter named would be rate limited again.
    expect(await attempt(7_000)).toEqual([8_050]);
    // A wait shorter than the schedule's is not taken: the schedule's first wait (4 s − 30% here) stands.
    expect(await attempt(1_500, () => 0)).toEqual([2_800]);
    expect(await attempt(200)).toEqual([4_000]);
    expect(await attempt(29_000, () => 0.999_999)).toEqual([30_000]);
    expect(await attempt(30_000)).toEqual([30_000]);
  });

  it("does not try again when OpenRouter asks for a wait that does not fit: the rate limit stands, as without retries", async () => {
    // Over 30 s: a retry after 30 s would come before the time it named.
    const { promise, waits, requests, records } = run({ writers: [limited(120_000)] });
    expect(await promise).toEqual({ kind: "infra", error: `sol:${LIMITED}`, modelFailure: false, stage: "writer", rateLimited: true });
    expect(waits).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(written(records)).toEqual([[false, 0, { error: LIMITED, evidence: "summary", retryAfterMs: 120_000, ...sent() }]]);
    // Asked 20 s three times: two waits as asked; the third would need 20 s of the 5 s left of the call's 45 s.
    const thrice = run({ writers: Array(3).fill(limited(20_000)) }, { random: () => 0 });
    expect(await thrice.promise).toMatchObject({ kind: "infra", rateLimited: true });
    expect(thrice.waits).toEqual([20_000, 20_000]);
    expect(thrice.requests).toHaveLength(3);
  });

  it("never waits past the run's time: without room for the wait and the call's time-out, the rate limit stands at once", async () => {
    const margin = AUTOWRITER_CALL_DEADLINE_MARGIN_MS;
    const stands = { kind: "infra", error: `sol:${LIMITED}`, modelFailure: false, stage: "writer", rateLimited: true };
    // The writer's 180 s fit; the 4 s wait on top of them does not, by one millisecond.
    const noRoom = run({ writers: [limited()] }, { remainingMs: 4_000 + AUTOWRITER_WRITER_TIMEOUT_MS + margin - 1 });
    expect(await noRoom.promise).toEqual(stands);
    expect(noRoom.waits).toEqual([]);
    expect(timeouts(noRoom.requests)).toEqual([180_000]);
    expect(written(noRoom.records)).toEqual([[false, 0, { error: LIMITED, evidence: "summary", ...sent() }]]);
    // Exactly enough: tried again with the same, full time-out — and the judges still get theirs.
    const room = run({ writers: [limited(), SOL(writerJson)], judge: [GLM(FAITHFUL)] }, { remainingMs: 4_000 + AUTOWRITER_WRITER_TIMEOUT_MS + margin });
    expect(await room.promise).toMatchObject({ kind: "draft" });
    expect(room.waits).toEqual([4_000]);
    expect(timeouts(room.requests)).toEqual([180_000, 180_000, 120_000, 120_000]);
    // Time for the first retry, not for the second (10 s): it stops there, one wait made.
    const halfway = run({ writers: [limited(), limited()] }, { remainingMs: 4_000 + 10_000 + AUTOWRITER_WRITER_TIMEOUT_MS + margin - 1 });
    expect(await halfway.promise).toEqual(stands);
    expect(halfway.waits).toEqual([4_000]);
    expect(written(halfway.records)).toEqual([
      [false, 0, { error: LIMITED, evidence: "summary", ...sent(4_000) }], [false, 0, { error: LIMITED, evidence: "summary", rateLimitRetry: 1, ...sent() }],
    ]);
    // A writer call already cut to what is left cannot be sent again with that time-out: no wait.
    const cut = run({ writers: [limited()] }, { remainingMs: 100_000 });
    expect(await cut.promise).toEqual(stands);
    expect(cut.waits).toEqual([]);
    expect(timeouts(cut.requests)).toEqual([100_000 - margin]);
    // A wait OpenRouter asks for is held to the same rule.
    const asked = run({ writers: [limited(20_000)] }, { remainingMs: 20_000 + AUTOWRITER_WRITER_TIMEOUT_MS + margin - 1, random: () => 0 });
    expect(await asked.promise).toEqual(stands);
    expect(asked.waits).toEqual([]);
  });

  it("never starts a judge's retry without its full time-out after the wait", async () => {
    const margin = AUTOWRITER_CALL_DEADLINE_MARGIN_MS;
    const script = () => ({ writers: [SOL(writerJson)], medium: [limited(), GLM(FAITHFUL)], high: [GLM(FAITHFUL)] });
    // The transcript judges' 240 s fit, the 4 s wait on top does not: the class retries with a fresh function.
    const noRoom = run(script(), { evidence: "transcript", remainingMs: 4_000 + 240_000 + margin - 1 });
    expect(await noRoom.promise).toEqual({ kind: "infra", error: `judge:medium:${LIMITED}`, modelFailure: false, stage: "judge", rateLimited: true });
    expect(noRoom.waits).toEqual([]);
    expect(timeouts(judgeRequests(noRoom.requests))).toEqual([240_000, 240_000]);
    const room = run(script(), { evidence: "transcript", remainingMs: 4_000 + 240_000 + margin });
    expect(await room.promise).toMatchObject({ kind: "draft" });
    expect(room.waits).toEqual([4_000]);
    expect(timeouts(judgeRequests(room.requests))).toEqual([240_000, 240_000, 240_000]);
  });

  it("tries a rate-limited judge level again: both levels are still required, and their verdicts combined as before", async () => {
    const passed = run({ writers: [SOL(writerJson)], medium: [limited(), GLM(FAITHFUL)], high: [GLM(FAITHFUL)] });
    expect(await passed.promise).toEqual({
      kind: "draft", arm: "sol", output: expect.anything(), fields: expect.anything(),
      judge: { ...PASSING, levels: { medium: PASSING, high: PASSING } },
    });
    // Only the level that was rate limited is asked again, on the same messages.
    const [medium, high, again] = judgeRequests(passed.requests);
    expect([medium.effort, high.effort, again.effort]).toEqual(["medium", "high", "medium"]);
    expect(again).toBe(medium);
    expect(passed.waits).toEqual([4_000]);
    const judgeResult = { ...PASSING, problems: [], judgedArm: "sol", judgedGeneration: "g", evidence: "summary" };
    expect(written(passed.records, "judge")).toEqual(expect.arrayContaining([
      [false, 0, { effort: "medium", error: LIMITED, judgedArm: "sol", judgedGeneration: "g", evidence: "summary", ...sent(4_000) }],
      [true, usage.costUsd, { ...judgeResult, effort: "medium", rateLimitRetry: 1 }],
      [true, usage.costUsd, { ...judgeResult, effort: "high" }],
    ]));
    expect(written(passed.records, "judge")).toHaveLength(3);

    // The verdict a level gives after its retries counts like any: it alone rejects the draft, so Luna writes.
    const rejected = run({
      writers: [SOL(writerJson), LUNA(writerJson)], medium: [GLM(FAITHFUL), GLM(FAITHFUL)], high: [limited(), limited(), GLM(MISATTRIBUTED), GLM(FAITHFUL)],
    });
    expect(await rejected.promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(rejected.waits).toEqual([4_000, 10_000]);

    // Both levels rate limited at once wait at the same time, each on its own clock.
    const both = run({ writers: [SOL(writerJson)], judge: [limited(), GLM(FAITHFUL)] });
    expect(await both.promise).toMatchObject({ kind: "draft", judge: { faithful: true } });
    expect(both.waits).toEqual([4_000, 4_000]);

    // Still rate limited after its retries: no verdict from that level, so no draft — the class retries later, the
    // writer having delivered (`stage: "judge"`), and the fallback writer is not asked.
    const stuck = run({ writers: [SOL(writerJson)], medium: [GLM(FAITHFUL)], high: Array(4).fill(limited()) });
    expect(await stuck.promise).toEqual({ kind: "infra", error: `judge:high:${LIMITED}`, modelFailure: false, stage: "judge", rateLimited: true });
    expect(stuck.requests.map((request) => request.model)).not.toContain("openai/gpt-6-luna");
    expect(stuck.waits).toEqual([4_000, 10_000, 25_000]);
  });

  it("tries the fallback writer again too when it is the one rate limited", async () => {
    const { promise, requests, waits } = run({
      writers: [SOL(writerJson), fail("openai/gpt-6-luna is temporarily rate-limited upstream.", 429), LUNA(writerJson)],
      judge: [GLM(UNFAITHFUL), GLM(FAITHFUL)],
    });
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna" });
    expect(writerRequests(requests).map((request) => request.model)).toEqual(["openai/gpt-6.1-sol", "openai/gpt-6-luna", "openai/gpt-6-luna"]);
    expect(waits).toEqual([4_000]);
  });

  it("retries rate limits only: any other failure is handled at once, as before", async () => {
    const once = async (writer: OpenRouterCallResult) => {
      const { promise, requests, waits } = run({ writers: [writer] });
      const result = await promise;
      return [result.kind === "infra" ? result.error : result.kind, requests.length, waits.length];
    };
    expect(await once(fail("timeout", null))).toEqual(["sol:timeout", 1, 0]);
    expect(await once(fail("Provider returned error", 500))).toEqual(["sol:Provider returned error", 1, 0]);
    expect(await once(fail("HTTP 503", 503))).toEqual(["sol:HTTP 503", 1, 0]);
    expect(await once(fail("invalid_json_response", 502))).toEqual(["sol:invalid_json_response", 1, 0]);
    expect(await once(fail("Insufficient credits", 402))).toEqual(["sol:Insufficient credits", 1, 0]);
    expect(await once(fail("network_TypeError", null))).toEqual(["sol:network_TypeError", 1, 0]);
    expect(await once(ok(writerJson, "Azure", "openai/gpt-6-luna"))).toEqual(["sol:model_mismatch:openai/gpt-6-luna", 1, 0]);

    // A retry that ends another way is that outcome: here a real time-out of the model, counted as the writer's.
    const thenTimeout = run({ writers: [limited(), fail("timeout", null)] });
    expect(await thenTimeout.promise).toEqual({ kind: "infra", error: "sol:timeout", modelFailure: true, stage: "writer" });
    expect(thenTimeout.waits).toEqual([4_000]);
    expect(written(thenTimeout.records)).toEqual([
      [false, 0, { error: LIMITED, evidence: "summary", ...sent(4_000) }], [false, 0, { error: "timeout", evidence: "summary", rateLimitRetry: 1 }],
    ]);
  });

  it("retries both forms of the rate limit through the real client: inside a 200 response, and a plain HTTP 429", async () => {
    const answer = (model: string, provider: string, content: string) => new Response(JSON.stringify({
      id: "gen-1", model, provider, choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.04 },
    }), { status: 200 });
    const replies = [
      () => new Response(JSON.stringify({ error: { message: LIMITED, code: 429, metadata: { error_type: "rate_limit_exceeded" } } }), { status: 200 }),
      () => new Response(JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }), { status: 429 }),
    ];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const limitedReply = replies.shift();
      if (limitedReply) return limitedReply();
      const body = JSON.parse(init.body as string) as { model: string };
      return body.model === "openai/gpt-6.1-sol" ? answer(body.model, "Azure", writerJson) : answer(body.model, "Together", FAITHFUL);
    });
    const waits: number[] = [];
    const records: CallRecord[] = [];
    const result = await runWritingPipeline({
      apiKey: "k",
      session: {
        wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
        classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] },
      },
      tutorNames: ["Kevin Hsieh", "Kev"],
      priorFeedback: [],
      record: async (record) => { records.push(record); },
      remainingMs: () => 700_000,
      callModel: (request) => callOpenRouter({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch }),
      sleep: async (ms) => { waits.push(ms); },
      random: () => 0.5,
    });
    expect(result).toMatchObject({ kind: "draft", arm: "sol" });
    // Writer: rate limited twice, then answered; then the two judge levels.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(waits).toEqual([4_000, 10_000]);
    expect(records.filter((record) => record.role === "writer").map((record) => [record.call.ok, record.call.usage?.costUsd ?? 0, record.result.rateLimitRetry]))
      .toEqual([[false, 0, undefined], [false, 0, 1], [true, 0.04, 2]]);
  });
});

describe("hardening follow-ups (30 Sep reviews of #113 and #114)", () => {
  const LIMITED = "openai/gpt-6.1-sol is temporarily rate-limited upstream. Please retry shortly.";
  const limited = (retryAfterMs?: number): OpenRouterCallResult => ({ ...fail(LIMITED, 429), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  afterEach(() => { vi.useRealTimers(); });

  it("makes no in-run retries at a stage the sweep has switched them off for: a rate limit stands at once, as before them", async () => {
    const NONE = { writer: false, judge: false };
    const writer = run({ writers: [limited()] }, { rateLimitRetries: NONE });
    expect(await writer.promise).toEqual({ kind: "infra", error: `sol:${LIMITED}`, modelFailure: false, stage: "writer", rateLimited: true });
    expect(writer.requests).toHaveLength(1);
    expect(writer.waits).toEqual([]);
    expect(writer.records.map((record) => record.result)).toEqual([{ error: LIMITED, evidence: "summary", attemptAt: expect.any(String) }]);
    // A judge level too: no wait, and the run stops on it (the fallback writer is not asked).
    const judge = run({ writers: [SOL(writerJson)], medium: [GLM(FAITHFUL)], high: [limited()] }, { rateLimitRetries: NONE });
    expect(await judge.promise).toEqual({ kind: "infra", error: `judge:high:${LIMITED}`, modelFailure: false, stage: "judge", rateLimited: true });
    expect(judge.waits).toEqual([]);
    expect(judgeRequests(judge.requests)).toHaveLength(2);
    // Everything else is as with retries on: a call that answers is a draft.
    expect(await run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }, { rateLimitRetries: NONE }).promise).toMatchObject({ kind: "draft", arm: "sol" });
  });

  it("switches the retries off one stage at a time: the writers' route and the judge's are limited apart", async () => {
    // Off for the writers (a sweep met a lasting limit on their route): a rate-limited writer stands at once …
    const writerOff = { writer: false, judge: true };
    const stands = run({ writers: [limited()] }, { rateLimitRetries: writerOff });
    expect(await stands.promise).toMatchObject({ kind: "infra", stage: "writer", rateLimited: true });
    expect(stands.waits).toEqual([]);
    // … the fallback writer's too …
    const fallback = run({ writers: [SOL(writerJson), limited()], judge: [GLM(UNFAITHFUL)] }, { rateLimitRetries: writerOff });
    expect(await fallback.promise).toMatchObject({ kind: "infra", error: `luna:${LIMITED}`, stage: "writer", rateLimited: true });
    expect(fallback.waits).toEqual([]);
    // … while a rate-limited judge level is still tried again, and the draft passes in the same run.
    const judged = run({ writers: [SOL(writerJson)], medium: [limited(), GLM(FAITHFUL)], high: [GLM(FAITHFUL)] }, { rateLimitRetries: writerOff });
    expect(await judged.promise).toMatchObject({ kind: "draft", arm: "sol" });
    expect(judged.waits).toEqual([4_000]);

    // Off for the judge: a rate-limited writer is still tried again, and the judge level that is rate limited is not.
    const judgeOff = { writer: true, judge: false };
    const written = run({ writers: [limited(), SOL(writerJson)], medium: [GLM(FAITHFUL)], high: [limited()] }, { rateLimitRetries: judgeOff });
    expect(await written.promise).toEqual({ kind: "infra", error: `judge:high:${LIMITED}`, modelFailure: false, stage: "judge", rateLimited: true });
    expect(written.waits).toEqual([4_000]);
    expect(writerRequests(written.requests)).toHaveLength(2);
    expect(judgeRequests(written.requests)).toHaveLength(2);
  });

  it("says when the judges had given their verdict on a draft before the run failed: the judge's failures in a row ended there", async () => {
    const answered = async (script: Script) => {
      const result = await run(script).promise;
      return result.kind === "infra" ? [result.error, result.stage, result.judgeAnswered ?? false] : result.kind;
    };
    const rejectedAtOneLevel = { medium: [GLM(UNFAITHFUL)], high: [GLM(FAITHFUL)] };
    // Sol's draft was judged and rejected; then the Luna fallback failed at the writer stage: a time-out, the wrong
    // model, or no time left to call it.
    expect(await answered({ writers: [SOL(writerJson), fail("timeout", null)], ...rejectedAtOneLevel })).toEqual(["luna:timeout", "writer", true]);
    expect(await answered({ writers: [SOL(writerJson), fail("Insufficient credits", 402)], judge: [GLM(UNFAITHFUL)] }))
      .toEqual(["luna:Insufficient credits", "writer", true]);
    const outOfTime = await run(
      { writers: [SOL(writerJson)], judge: [GLM(UNFAITHFUL)] },
      { remainingMs: 200_000, latencyMs: (request) => request.schemaName === "feedback_faithfulness" ? 150_000 : 0 },
    ).promise;
    expect(outOfTime).toEqual({ kind: "infra", error: "function_budget_exhausted", modelFailure: false, stage: "writer", judgeAnswered: true });
    // Luna's draft was written, and its judge then failed: a failure after an answer, in the same run.
    expect(await answered({
      writers: [SOL(writerJson), LUNA(writerJson)], medium: [GLM(UNFAITHFUL), fail("timeout", null)], high: [GLM(FAITHFUL), GLM(FAITHFUL)],
    })).toEqual(["judge:medium:timeout", "judge", true]);
    // One level rejecting the draft is an answer even when the other gave none it could use (it then left off).
    expect(await answered({ writers: [SOL(writerJson), fail("timeout", null)], medium: [GLM(UNFAITHFUL)], high: [GLM("not json")] }))
      .toEqual(["luna:timeout", "writer", true]);

    // No verdict on any draft in the run: nothing is said. The first writer failed; or a level failed on the first
    // draft — also when the other level had passed it (the draft was not checked: both levels are required).
    expect(await answered({ writers: [fail("timeout", null)] })).toEqual(["sol:timeout", "writer", false]);
    expect(await answered({ writers: [SOL(writerJson)], medium: [GLM(FAITHFUL)], high: [fail("timeout", null)] })).toEqual(["judge:high:timeout", "judge", false]);
    expect(await answered({ writers: [SOL(writerJson)], medium: [GLM("not json"), GLM("{}")], high: [GLM(FAITHFUL)] }))
      .toEqual(["judge:medium:judge_unparseable", "judge", false]);
    // A draft and a hold carry no such flag: the job knows the judges answered (or that the class is settled).
    expect(await run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] }).promise).not.toHaveProperty("judgeAnswered");
    expect(await run({ writers: [SOL(writerJson), LUNA("not json")], judge: [GLM(UNFAITHFUL)] }).promise).toEqual({ kind: "held", reasons: expect.any(Array) });
  });

  it("says a run ended on a rate limit only when its last call was still rate limited", async () => {
    const flag = async (script: Script) => {
      const result = await run(script).promise;
      return result.kind === "infra" ? result.rateLimited ?? false : result.kind;
    };
    expect(await flag({ writers: Array(4).fill(limited()) })).toBe(true);
    expect(await flag({ writers: [SOL(writerJson)], medium: [GLM(FAITHFUL)], high: Array(4).fill(limited()) })).toBe(true);
    // Rate limited, then a time-out: the run ended on the time-out.
    expect(await flag({ writers: [limited(), fail("timeout", null)] })).toBe(false);
    expect(await flag({ writers: [fail("Insufficient credits", 402)] })).toBe(false);
    expect(await flag({ writers: [fail("timeout", null)] })).toBe(false);
    expect(await flag({ writers: [limited(), SOL(writerJson)], judge: [GLM(FAITHFUL)] })).toBe("draft");
  });

  it("records when each rate-limited request was really sent, though its record is written after the waits", async () => {
    const NOW = Date.parse("2026-09-30T13:00:00.000Z");
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const replies = [limited(7_000), limited(), SOL(writerJson)];
    const records: CallRecord[] = [];
    const writtenAt: number[] = [];
    const result = await runWritingPipeline({
      apiKey: "k",
      session: {
        wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
        classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] },
      },
      tutorNames: ["Kevin Hsieh", "Kev"],
      priorFeedback: [],
      record: async (record) => { records.push(record); writtenAt.push(Date.now() - NOW); },
      remainingMs: () => 700_000,
      // A request takes 1 s, a wait its own time, on the clock the attempts are timed by.
      callModel: (async (request: Request) => {
        vi.setSystemTime(Date.now() + 1_000);
        return request.schemaName === "post_class_feedback" ? replies.shift()! : GLM(FAITHFUL);
      }) as never,
      sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      random: () => 0.5,
    });
    expect(result.kind).toBe("draft");
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    const writer = records.filter((record) => record.role === "writer");
    // Sent at 0 s and at 9.05 s (1 s for the reply, then the 8.05 s asked for with its spread); the answer at 20.05 s.
    expect(writer.map((record) => record.result)).toEqual([
      { error: LIMITED, evidence: "summary", attemptAt: at(0), retryAfterMs: 7_000, waitedMs: 8_050 },
      { error: LIMITED, evidence: "summary", rateLimitRetry: 1, attemptAt: at(9_050), waitedMs: 10_000 },
      { validation: "ok", evidence: "summary", rateLimitRetry: 2 },
    ]);
    // All three were written when the call ended (21.05 s): without `attemptAt` the first would be dated 21 s late.
    expect(writtenAt.slice(0, 3)).toEqual([21_050, 21_050, 21_050]);
    // The extra fields stay in `result`: the recorded call is the reply as OpenRouter gave it.
    expect(writer[0].call).toEqual(limited(7_000));
    for (const record of records.filter((entry) => entry.role === "judge")) expect(record.result).not.toHaveProperty("attemptAt");
  });

  it("gives each draft a key of its own when the writer's reply has no generation id, so a rejected draft counts once", async () => {
    const noId = (reply: OpenRouterCallResult): OpenRouterCallResult => reply.ok ? { ...reply, generationId: null } : reply;
    const { promise, records } = run({ writers: [noId(SOL(writerJson)), noId(LUNA(writerJson))], judge: [GLM(UNFAITHFUL), GLM(UNFAITHFUL)] });
    expect((await promise).kind).toBe("held");
    const judged = records.filter((record) => record.role === "judge");
    const keys = judged.map((record) => [record.result.judgedArm, record.result.judgedGeneration]);
    // Both levels' calls on a draft carry that draft's key; the two drafts have different ones.
    expect(keys).toEqual([["sol", keys[0][1]], ["sol", keys[0][1]], ["luna", keys[2][1]], ["luna", keys[2][1]]]);
    expect(keys[0][1]).toEqual(expect.stringMatching(/^draft:[0-9a-f-]{36}$/u));
    expect(keys[2][1]).toEqual(expect.stringMatching(/^draft:[0-9a-f-]{36}$/u));
    expect(keys[2][1]).not.toBe(keys[0][1]);
    // Four rejecting judge calls, two rejected drafts on the dashboard.
    const calls: DashboardCallRow[] = judged.map((record) => ({
      wiseSessionId: record.wiseSessionId, role: "judge", arm: "glm", requestedModel: record.requestedModel, ok: true, costUsd: 0,
      createdAt: new Date("2026-09-30T03:02:00.000Z"), result: record.result,
    }));
    const control = {
      id: "default", mode: "live" as const, disabledTutors: [], haltedAt: null, haltReason: null, leaseToken: null, leaseUntil: null,
      updatedBy: null, updatedAt: new Date("2026-09-30T01:00:00.000Z"),
    };
    expect(buildAutowriterDashboard({
      now: new Date("2026-09-30T05:00:00.000Z"), windowDays: 7, control, system: buildSystemStatus({}), holds: [], sessions: [], calls, webhooks: [],
    }).judgeRejections).toBe(2);
    // A reply with a generation id keeps it as the key.
    const withId = run({ writers: [SOL(writerJson)], judge: [GLM(FAITHFUL)] });
    await withId.promise;
    expect(withId.records.filter((record) => record.role === "judge").map((record) => record.result.judgedGeneration)).toEqual(["g", "g"]);
  });

  describe("a judge level leaves off once the other level has rejected the draft or stopped the run", () => {
    /**
     * Like `run`, with the order of the judges' first replies under control: the level `first` answers first, and the
     * other level's first reply arrives only once that call is on record (so `first` has decided by then).
     */
    function ordered(script: Script, first: "medium" | "high", options: Options = {}) {
      const records: CallRecord[] = [];
      const requests: Request[] = [];
      const waits: number[] = [];
      let open = () => {};
      const firstRecorded = new Promise<void>((resolve) => { open = resolve; });
      const queues = { writer: [...script.writers], medium: [...(script.medium ?? [])], high: [...(script.high ?? [])] };
      const heldBack = new Set<string>();
      const callModel = async (request: Request) => {
        requests.push(request);
        if (request.schemaName === "post_class_feedback") return queues.writer.shift()!;
        const level = request.effort as "medium" | "high";
        if (level !== first && !heldBack.has(level)) {
          heldBack.add(level);
          await firstRecorded;
        }
        const reply = queues[level].shift();
        if (!reply) throw new Error(`unexpected judge call at ${level}`);
        return reply;
      };
      const promise = runWritingPipeline({
        apiKey: "k",
        session: {
          wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
          classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] },
        },
        tutorNames: ["Kevin Hsieh", "Kev"],
        priorFeedback: [],
        record: async (record) => {
          records.push(record);
          if (record.role === "judge" && record.result.effort === first) open();
        },
        remainingMs: () => 700_000,
        callModel: callModel as never,
        sleep: async (ms) => { waits.push(ms); },
        random: () => 0.5,
        rateLimitRetries: options.rateLimitRetries,
      });
      return { promise, records, requests, waits };
    }
    const efforts = (requests: Request[]) => judgeRequests(requests).map((request) => request.effort);
    /** Sol's draft is judged; the Luna fallback's reply is not JSON, so a rejected Sol draft ends in a hold. */
    const writers = () => [SOL(writerJson), LUNA("not json")];
    const rejected = { kind: "held", reasons: ["sol:unfaithful:scored 95%", "luna:output_not_json"] };

    it("makes no second try after an unusable reply: the draft is rejected on the other level's verdict", async () => {
      const { promise, requests, records } = ordered({ writers: writers(), high: [GLM(UNFAITHFUL)], medium: [GLM("not json"), GLM(FAITHFUL)] }, "high");
      expect(await promise).toEqual(rejected);
      // Medium's one reply was unusable; its second try (which would have passed) is not made.
      expect(efforts(requests)).toEqual(["medium", "high"]);
      expect(records.filter((record) => record.role === "judge").map((record) => [record.result.effort, record.result.error ?? record.result.faithful]))
        .toEqual([["high", false], ["medium", "judge_unparseable"]]);
      // The same the other way round.
      const mirrored = ordered({ writers: writers(), medium: [GLM(UNFAITHFUL)], high: [GLM("{}"), GLM(FAITHFUL)] }, "medium");
      expect(await mirrored.promise).toEqual(rejected);
      expect(efforts(mirrored.requests)).toEqual(["medium", "high"]);
    });

    it("makes no second try once the other level has stopped the run: that stop is the outcome", async () => {
      const { promise, requests } = ordered({ writers: writers(), high: [fail("timeout", null)], medium: [GLM("not json"), GLM(FAITHFUL)] }, "high");
      expect(await promise).toEqual({ kind: "infra", error: "judge:high:timeout", modelFailure: true, stage: "judge" });
      expect(efforts(requests)).toEqual(["medium", "high"]);
      expect(requests.map((request) => request.model)).not.toContain("openai/gpt-6-luna");
    });

    it("makes no in-run retry of a rate-limited level: no wait, and its rate limit is not a failure of its own", async () => {
      // The other level rejected the draft: rejected on that verdict, and the fallback writer goes on.
      const afterVerdict = ordered({ writers: writers(), high: [GLM(UNFAITHFUL)], medium: [limited(), GLM(FAITHFUL)] }, "high");
      expect(await afterVerdict.promise).toEqual(rejected);
      expect(afterVerdict.waits).toEqual([]);
      expect(efforts(afterVerdict.requests)).toEqual(["medium", "high"]);
      // The request was made, so it is on record — with when it was sent, and no wait after it.
      expect(afterVerdict.records.find((record) => record.result.effort === "medium")?.result)
        .toEqual({ effort: "medium", error: LIMITED, attemptAt: expect.any(String), judgedArm: "sol", judgedGeneration: "g", evidence: "summary" });
      // The other level stopped the run: its stop is the outcome, not this level's rate limit.
      const afterStop = ordered({ writers: writers(), high: [fail("timeout", null)], medium: [limited(), GLM(FAITHFUL)] }, "high");
      expect(await afterStop.promise).toEqual({ kind: "infra", error: "judge:high:timeout", modelFailure: true, stage: "judge" });
      expect(afterStop.waits).toEqual([]);
      expect(efforts(afterStop.requests)).toEqual(["medium", "high"]);
    });

    it("still tries again while the other level has only passed the draft, and still stops on a level's own failure", async () => {
      // High passed it: medium's verdict is still needed, so its second try and its retry are made.
      const secondTry = ordered({ writers: writers(), high: [GLM(FAITHFUL)], medium: [GLM("not json"), GLM(FAITHFUL)] }, "high");
      expect(await secondTry.promise).toMatchObject({ kind: "draft", arm: "sol" });
      expect(efforts(secondTry.requests)).toEqual(["medium", "high", "medium"]);
      const retried = ordered({ writers: writers(), high: [GLM(FAITHFUL)], medium: [limited(), GLM(FAITHFUL)] }, "high");
      expect(await retried.promise).toMatchObject({ kind: "draft", arm: "sol" });
      expect(retried.waits).toEqual([4_000]);
      // A call that fails on its own (a time-out) after the other level's verdict is a judge failure, as before.
      const failed = ordered({ writers: writers(), high: [GLM(UNFAITHFUL)], medium: [fail("timeout", null)] }, "high");
      expect(await failed.promise).toEqual({ kind: "infra", error: "judge:medium:timeout", modelFailure: true, stage: "judge" });
      // So is a rate limit in a sweep whose judge retries are off: nothing was left off on the other level's account.
      const retriesOff = ordered({ writers: writers(), high: [GLM(UNFAITHFUL)], medium: [limited()] }, "high", { rateLimitRetries: { writer: true, judge: false } });
      expect(await retriesOff.promise).toEqual({ kind: "infra", error: `judge:medium:${LIMITED}`, modelFailure: false, stage: "judge", rateLimited: true });
    });

    it("sends no retry when the other level decided while this one waited: asked again after the wait", async () => {
      // Medium is rate limited and waits; high's verdict (unfaithful) arrives during that wait.
      const records: CallRecord[] = [];
      const requests: Request[] = [];
      const waits: number[] = [];
      let mediumWaits = () => {};
      const mediumWaiting = new Promise<void>((resolve) => { mediumWaits = resolve; });
      let highRecorded = () => {};
      const highOnRecord = new Promise<void>((resolve) => { highRecorded = resolve; });
      const queues = { writer: writers(), medium: [limited(), GLM(FAITHFUL)], high: [GLM(UNFAITHFUL)] };
      const result = await runWritingPipeline({
        apiKey: "k",
        session: {
          wiseSessionId: "6a0000000000000000000002", studentFullName: STUDENT_NAME, studentDisplayName: "Somchai",
          classDetails: [], scheduledMinutes: 60, summary: { text: SUMMARY, meetingUUIDs: [] },
        },
        tutorNames: ["Kevin Hsieh", "Kev"],
        priorFeedback: [],
        record: async (record) => {
          records.push(record);
          if (record.role === "judge" && record.result.effort === "high") highRecorded();
        },
        remainingMs: () => 700_000,
        callModel: (async (request: Request) => {
          requests.push(request);
          if (request.schemaName === "post_class_feedback") return queues.writer.shift()!;
          const level = request.effort as "medium" | "high";
          if (level === "high") await mediumWaiting;
          const reply = queues[level].shift();
          if (!reply) throw new Error(`unexpected judge call at ${level}`);
          return reply;
        }) as never,
        // The wait ends only once high's verdict is on record.
        sleep: async (ms) => { waits.push(ms); mediumWaits(); await highOnRecord; },
        random: () => 0.5,
      });
      // Rejected on high's verdict, and the fallback writer went on. Medium's retry (which would have passed) was never
      // sent: by the end of its wait it could change nothing.
      expect(result).toEqual(rejected);
      expect(waits).toEqual([4_000]);
      expect(efforts(requests)).toEqual(["medium", "high"]);
      // Its one request is on record with when it was sent and the wait it made — not as a failure of its own.
      expect(records.find((record) => record.result.effort === "medium")?.result)
        .toEqual({ effort: "medium", error: LIMITED, attemptAt: expect.any(String), waitedMs: 4_000, judgedArm: "sol", judgedGeneration: "g", evidence: "summary" });
    });
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


describe("Mimi presentation guide in the production pipeline", () => {
  const options = { canonicalTutorKey: "Mimi", styleGuide: MIMI_STYLE_GUIDE };
  const numbered = JSON.stringify({ ...JSON.parse(writerJson), performance: JSON.parse(writerJson).performance + " We reviewed the errors together and practised checking each denominator before combining terms. The next step is to keep the same careful checking routine when working independently.", topics: "1. Adding fractions\n2. Mixed numbers", improvement: "1. Check simplification" });
  it("gives both writers the same guide and keeps the examples out of both factual judges", async () => {
    const { promise, requests, records } = run({ writers: [SOL(writerJson), LUNA(numbered)], judge: [GLM(FAITHFUL)] }, options);
    expect(await promise).toMatchObject({ kind: "draft", arm: "luna", styleGuide: { id: "mimi", version: 1 } });
    const writers = writerRequests(requests);
    expect(writers).toHaveLength(2);
    expect(writers[0].messages).toEqual(writers[1].messages);
    expect(writers[0].messages[0].content).toContain("Historical presentation example 1");
    expect(writers[0].messages[0].content).not.toContain("between 120 and 600");
    for (const request of judgeRequests(requests)) expect(JSON.stringify(request.messages)).not.toContain("Historical presentation");
    expect(records[0].result).toMatchObject({ styleGuide: { id: "mimi", version: 1 } });
  });
  it("holds for a human when both writers fail the format check, without asking a factual judge to waive it", async () => {
    const { promise, requests } = run({ writers: [SOL(writerJson), LUNA(writerJson)] }, options);
    expect(await promise).toMatchObject({ kind: "held", reasons: expect.arrayContaining(["sol:style:list_structure:topics", "luna:style:list_structure:topics"]) });
    expect(judgeRequests(requests)).toHaveLength(0);
  });
  it.each(["not JSON", JSON.stringify({ ...JSON.parse(numbered), topics: undefined })])("classifies missing fields and malformed JSON as format failures", async content => {
    const { promise, requests } = run({ writers: [SOL(content), LUNA(content)] }, options);
    expect(await promise).toMatchObject({ kind: "held", reasons: [expect.stringContaining("sol:style:"), expect.stringContaining("luna:style:")] });
    expect(judgeRequests(requests)).toHaveLength(0);
  });
  it("does not let good formatting bypass an invented score or homework verdict", async () => {
    const verdict = JSON.stringify({ faithful: false, unsupported: ["scored 95%"], misattributed: [], homeworkNotSet: ["Complete worksheet 8"] });
    const invented = JSON.stringify({ ...JSON.parse(numbered), topics: "1. Fractions; scored 95%", homework: "1. Complete worksheet 8" });
    const { promise } = run({ writers: [SOL(invented), LUNA(invented)], judge: [GLM(verdict), GLM(verdict)] }, options);
    expect(await promise).toMatchObject({ kind: "held" });
  });
  it("holds historical facts that are not supported by the current lesson, even in the correct layout", async () => {
    const copiedFact = JSON.stringify({ ...JSON.parse(numbered), topics: "1. Fractions; scored 19/27" });
    const verdict = JSON.stringify({ faithful: false, unsupported: ["19/27 is from a historical example, not this lesson"], misattributed: [], homeworkNotSet: [] });
    const { promise } = run({ writers: [SOL(copiedFact), LUNA(copiedFact)], judge: [GLM(verdict), GLM(verdict)] }, options);
    expect(await promise).toMatchObject({ kind: "held", reasons: expect.arrayContaining([expect.stringContaining("unfaithful:")]) });
  });
  it("never accepts a malformed primary draft when the fallback service fails", async () => {
    const { promise, requests } = run({ writers: [SOL(writerJson), fail("timeout", null)] }, options);
    expect(await promise).toMatchObject({ kind: "infra", error: "luna:timeout", stage: "writer" });
    expect(writerRequests(requests)).toHaveLength(2);
    expect(judgeRequests(requests)).toHaveLength(0);
  });
});
