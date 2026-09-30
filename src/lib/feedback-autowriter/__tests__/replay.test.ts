import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { OpenRouterCallResult } from "../openrouter";
import {
  reasonCategory,
  renderReplayMarkdown,
  replayClass,
  runReplay,
  summarizeReplay,
  type ReplayDeps,
  type ReplaySample,
  type ReplayWiseReads,
} from "../replay";
import { KEVIN_ONLINE_WISE_USER_ID, rosterTutor } from "../roster";
import { sonioxJobInput } from "../transcript";
import { GOOD_FIELDS, SESSION_ID, STUDENT_NAME, sessionDetail } from "./fixtures";

const usage = { promptTokens: 1000, completionTokens: 2000, reasoningTokens: 1700, cachedTokens: 0, costUsd: 0.002 };
const glm = (content: string, latencyMs = 5): OpenRouterCallResult => ({
  ok: true, content, model: "z-ai/glm-5.3-flash", provider: "Together", generationId: "g", finishReason: "stop", usage, latencyMs,
});
const WRITER_JSON = JSON.stringify({
  topics: GOOD_FIELDS.topics,
  performance: GOOD_FIELDS.performance.replaceAll("Somchai", "[STUDENT_1]"),
  improvement: GOOD_FIELDS.improvement.replaceAll("Somchai", "[STUDENT_1]"),
  homework: "",
  studentAttended: true,
  lessonHappened: true,
});
const PASSING = JSON.stringify({ faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] });
const UNFAITHFUL = JSON.stringify({ faithful: false, unsupported: [], misattributed: ["[STUDENT_1] finished; then left early"], homeworkNotSet: ["the last two pages"] });

const RECORDING = { rawRecordings: [{ url: "https://files.wiseapp.live/rec.mp4", partIndex: 1 }], rawTranscript: [{ url: "https://files.wiseapp.live/rec.vtt" }] };
const ZOOM_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:30.000
Kevin (Kev) Y. Hsieh Online: Today we look at fractions

2
00:00:31.000 --> 00:01:00.000
${STUDENT_NAME}: I think the answer is three quarters
`;
const THAI_SUMMARY = [{
  summaryOverview: "นักเรียนและครูทบทวนเรื่องเศษส่วน การบวกเศษส่วนที่มีตัวส่วนต่างกัน และการทำให้เป็นเศษส่วนอย่างต่ำ " +
    "นักเรียนตอบคำถามได้ถูกต้องเกือบทั้งหมด แต่ยังลืมทำให้เป็นอย่างต่ำในบางข้อ ครูให้ฝึกเพิ่มเติมเรื่องการหา ห.ร.ม. " +
    "และทบทวนโจทย์ปัญหาเกี่ยวกับการแบ่งพิซซ่า นักเรียนอธิบายวิธีคิดได้ชัดเจน",
  summaryDetails: [{ label: "เศษส่วน", summary: "ฝึกโจทย์หกข้อ แก้ไขข้อผิดพลาดสองข้อหลังจากครูให้ตรวจสอบ ห.ร.ม." }],
  meetingUUID: "uuid-th",
}];

function lessonTokens(minutes = 12) {
  const tokens: Array<{ text: string; start_ms: number; end_ms: number; speaker: string }> = [];
  for (let i = 0; i < minutes; i += 1) {
    const at = i * 60_000;
    tokens.push({ text: " Today we add fractions with unlike denominators and simplify the answer to its lowest terms, step by step.", start_ms: at, end_ms: at + 25_000, speaker: "1" });
    tokens.push({ text: " I got three quarters because I found the common denominator first and then simplified.", start_ms: at + 31_000, end_ms: at + 55_000, speaker: "2" });
  }
  return tokens;
}

/** Soniox fake: every job id handed out and every delete, with failures on demand. */
function fakeSoniox(options: {
  status?: "completed" | "error" | "processing";
  transcriptThrows?: boolean;
  removeFailures?: number;
  audioDurationMs?: number;
  tokens?: ReturnType<typeof lessonTokens>;
} = {}) {
  const created: Array<Parameters<ReplayDeps["soniox"]["create"]>[0]> = [];
  const removed: string[] = [];
  let removeFailures = options.removeFailures ?? 0;
  const tokens = options.tokens ?? lessonTokens();
  const client: ReplayDeps["soniox"] = {
    create: vi.fn(async (input) => { created.push(input); return { id: `job-${created.length}` }; }),
    get: vi.fn(async () => options.status === "error"
      ? { status: "error" as const, audioDurationMs: null, errorMessage: "audio_url could not be fetched" }
      : options.status === "processing"
        ? { status: "processing" as const, audioDurationMs: null, errorMessage: null }
        : { status: "completed" as const, audioDurationMs: options.audioDurationMs ?? 3_600_000, errorMessage: null }),
    transcript: vi.fn(async () => {
      if (options.transcriptThrows) throw new Error("network_TimeoutError");
      return { text: tokens.map((token) => token.text).join(""), tokens };
    }),
    remove: vi.fn(async (id: string) => {
      if (removeFailures > 0) {
        removeFailures -= 1;
        throw new Error("HTTP 503");
      }
      removed.push(id);
      return "deleted" as const;
    }),
    list: vi.fn(async () => []),
  };
  return { client, created, removed };
}

/** Wise that answers only the session-detail GET; touching anything else fails the test. */
function readOnlyWise(detail: ReturnType<typeof sessionDetail>) {
  const touched: string[] = [];
  const wise = new Proxy({} as ReplayWiseReads, {
    get(_target, property) {
      touched.push(String(property));
      if (property !== "getSessionDetailById") throw new Error(`replay touched Wise ${String(property)}`);
      return async () => ({ data: structuredClone(detail) });
    },
  });
  return { wise, touched };
}

type ModelRequest = { schemaName: string; effort: string; messages: Array<{ role: string; content: string }> };

function fakeModel(options: { judge?: (request: ModelRequest) => string; writerThrows?: boolean } = {}) {
  const requests: ModelRequest[] = [];
  const callModel = vi.fn(async (request: ModelRequest) => {
    requests.push(request);
    if (request.schemaName === "post_class_feedback") {
      if (options.writerThrows) throw new Error("socket hang up");
      return glm(WRITER_JSON, 60_000);
    }
    return glm(options.judge ? options.judge(request) : PASSING, request.effort === "medium" ? 20_000 : 45_000);
  });
  return { callModel, requests };
}

function replayDeps(overrides: Partial<ReplayDeps> & Pick<ReplayDeps, "wise" | "soniox">): ReplayDeps {
  return {
    apiKey: "test-key",
    priorFeedback: async () => [],
    fetchText: async () => ZOOM_VTT,
    callModel: fakeModel().callModel as never,
    sleep: async () => {},
    ...overrides,
  };
}

const SAMPLE: ReplaySample = { wiseSessionId: SESSION_ID, rowState: "verified", postedFields: null, postedSource: null };

describe("replay: read-only by construction", () => {
  it("can only read Wise's session detail: no write method is reachable", async () => {
    expectTypeOf<keyof ReplayWiseReads>().toEqualTypeOf<"getSessionDetailById">();
    const { wise, touched } = readOnlyWise(sessionDetail(RECORDING));
    const record = await replayClass(replayDeps({ wise, soniox: fakeSoniox().client }), SAMPLE);
    expect(record.outcome).toBe("draft");
    expect(new Set(touched)).toEqual(new Set(["getSessionDetailById"]));
  });

  it("deletes every Soniox job, even when a step fails", async () => {
    const cases: Array<[string, Parameters<typeof fakeSoniox>[0], Partial<ReplayDeps>, string]> = [
      ["transcript fetch throws", { transcriptThrows: true }, {}, "fallback:soniox_failed"],
      ["Soniox reports an error", { status: "error" }, {}, "fallback:soniox_failed"],
      ["the job never finishes", { status: "processing" }, { transcribeTimeoutMs: -1 }, "fallback:soniox_failed"],
      ["the writer throws after the transcript", {}, { callModel: fakeModel({ writerThrows: true }).callModel as never }, "error:socket hang up"],
      ["a delete fails twice first", { removeFailures: 2 }, {}, "draft"],
    ];
    for (const [label, sonioxOptions, overrides, outcome] of cases) {
      const soniox = fakeSoniox(sonioxOptions);
      const record = await replayClass(replayDeps({ wise: readOnlyWise(sessionDetail(RECORDING)).wise, soniox: soniox.client, ...overrides }), SAMPLE);
      expect(record.outcome, label).toBe(outcome);
      expect(soniox.created.length, label).toBeGreaterThan(0);
      expect(soniox.removed, label).toEqual(soniox.created.map((_, index) => `job-${index + 1}`));
      expect(record.soniox?.undeletedJobs, label).toEqual([]);
    }
    // Production allows three Soniox failures before it falls back; so does the replay.
    const failing = fakeSoniox({ status: "error" });
    await replayClass(replayDeps({ wise: readOnlyWise(sessionDetail(RECORDING)).wise, soniox: failing.client }), SAMPLE);
    expect(failing.created).toHaveLength(3);

    // A delete that keeps failing is reported, never silently dropped.
    const stuck = fakeSoniox({ removeFailures: 99 });
    const record = await replayClass(replayDeps({ wise: readOnlyWise(sessionDetail(RECORDING)).wise, soniox: stuck.client }), SAMPLE);
    expect(record.soniox?.undeletedJobs).toEqual(["job-1"]);
    expect(summarizeReplay([record]).soniox.undeletedJobs).toEqual(["job-1"]);
  });

  it("never throws: a failed Wise read is a skip", async () => {
    const wise: ReplayWiseReads = { getSessionDetailById: async () => { throw new Error("HTTP 502"); } };
    const soniox = fakeSoniox();
    expect(await replayClass(replayDeps({ wise, soniox: soniox.client }), SAMPLE)).toMatchObject({ outcome: "skip:wise_read_failed:HTTP 502" });
    expect(soniox.created).toEqual([]);
  });
});

describe("replay: the same evidence and decisions as production", () => {
  it("transcribes like production and judges the transcript draft at high and at medium on the same messages", async () => {
    const soniox = fakeSoniox();
    const model = fakeModel();
    const detail = sessionDetail(RECORDING);
    const record = await replayClass(replayDeps({ wise: readOnlyWise(detail).wise, soniox: soniox.client, callModel: model.callModel as never }), SAMPLE);
    expect(soniox.created).toEqual([sonioxJobInput({
      wiseSessionId: SESSION_ID, audioUrl: "https://files.wiseapp.live/rec.mp4", detail: { classSubject: "Mathematics", title: undefined },
      tutorNames: rosterTutor(KEVIN_ONLINE_WISE_USER_ID)!.tutorNames, studentName: STUDENT_NAME,
    })]);
    expect(record).toMatchObject({
      outcome: "draft", tutor: "Kevin", scheduledMinutes: 60,
      soniox: { audioMinutes: 60, costUsd: expect.closeTo(0.1, 6), jobIds: ["job-1"], undeletedJobs: [] },
      speakers: { method: "zoom_alignment", labels: "verified" },
      transcriptDraft: { outcome: "draft", arm: "glm", judgeHigh: { faithful: true }, judgeMedium: { faithful: true } },
      summaryDraft: { outcome: "draft" },
    });
    expect(record.transcript).toBeUndefined();
    const judges = model.requests.filter((request) => request.schemaName === "feedback_faithfulness");
    const transcriptJudges = judges.filter((request) => request.messages[1].content.includes("Lesson transcript:"));
    expect(transcriptJudges.map((request) => request.effort)).toEqual(["high", "medium"]);
    expect(transcriptJudges[1].messages).toEqual(transcriptJudges[0].messages);
    // The summary draft is judged at production's effort only.
    expect(judges.filter((request) => request.messages[1].content.includes("Lesson summary:")).map((request) => request.effort)).toEqual(["high"]);
    expect(record.calls.filter((call) => call.shadow)).toHaveLength(1);
  });

  it("judges the posted draft against the transcript, with the student's name redacted", async () => {
    const model = fakeModel({ judge: (request) => request.messages[1].content.includes("the last two pages") ? UNFAITHFUL : PASSING });
    const posted = { ...GOOD_FIELDS, performance: `${GOOD_FIELDS.performance.replaceAll("Somchai", "Tom")}`, homework: "Finish the last two pages." };
    const record = await replayClass(
      replayDeps({ wise: readOnlyWise(sessionDetail(RECORDING)).wise, soniox: fakeSoniox().client, callModel: model.callModel as never }),
      { ...SAMPLE, postedFields: posted, postedSource: "pre_correction_version" },
    );
    const postedJudge = model.requests.find((request) => request.messages[1].content.includes("the last two pages"));
    expect(postedJudge?.effort).toBe("high");
    expect(postedJudge?.messages[1].content).toContain("[STUDENT_1] found common denominators");
    expect(postedJudge?.messages[1].content).not.toMatch(/\bTom\b|Somchai/u);
    expect(record.posted).toMatchObject({
      source: "pre_correction_version",
      verdict: { faithful: false },
      problems: ["wrong person: [STUDENT_1] finished; then left early", "homework not set: the last two pages"],
      error: null,
    });
  });

  it("falls back where production would, and records what the summary path then gives", async () => {
    const parts = { rawRecordings: [{ url: "https://files.wiseapp.live/a.mp4" }, { url: "https://files.wiseapp.live/b.mp4" }] };
    const even = lessonTokens().map((token, index) => ({ ...token, speaker: String((index % 3) + 1) }));
    const cases: Array<[string, ReturnType<typeof sessionDetail>, Partial<ReplayDeps>, Parameters<typeof fakeSoniox>[0], string, string]> = [
      ["no recording", sessionDetail(), {}, {}, "fallback:no_recording", "draft"],
      ["several parts", sessionDetail(parts), {}, {}, "fallback:recording_multiple_parts", "draft"],
      ["no recording, Thai summary", sessionDetail({ rawMeetingSummary: THAI_SUMMARY }), {}, {}, "fallback:no_recording", "hold:thai_summary_no_transcript"],
      ["no recording, no summary", sessionDetail({ rawMeetingSummary: [] }), {}, {}, "fallback:no_recording", "retry:no_summary"],
      ["speakers unclear", sessionDetail(RECORDING), { fetchText: async () => "WEBVTT\n" }, { tokens: even }, "fallback:speakers_unclear", "draft"],
    ];
    for (const [label, detail, overrides, sonioxOptions, outcome, afterFallback] of cases) {
      const soniox = fakeSoniox(sonioxOptions);
      const record = await replayClass(replayDeps({ wise: readOnlyWise(detail).wise, soniox: soniox.client, ...overrides }), SAMPLE);
      expect(record.outcome, label).toBe(outcome);
      expect(record.afterFallback, label).toBe(afterFallback);
      expect(record.transcriptDraft, label).toBeNull();
      expect(soniox.removed, label).toEqual(soniox.created.map((_, index) => `job-${index + 1}`));
    }
  });

  it("holds a recording or transcript too short for the class, and skips a class that would not have passed the gates", async () => {
    const short = { ...RECORDING, rawRecordings: [{ ...RECORDING.rawRecordings[0], duration: 1_200 }] };
    const absent = sessionDetail({
      ...RECORDING,
      participants: sessionDetail().participants.map((participant) => participant.isTeacher
        ? participant : { ...participant, inMeetingDuration: 300, absolutePercentAttendance: 8 }),
    });
    const cases: Array<[string, ReturnType<typeof sessionDetail>, Parameters<typeof fakeSoniox>[0], string, number]> = [
      ["Wise's recording is short", sessionDetail(short), {}, "hold:recording_too_short", 0],
      ["Soniox hears a short recording", sessionDetail(RECORDING), { audioDurationMs: 20 * 60_000 }, "hold:recording_too_short", 1],
      ["the transcript is short", sessionDetail(RECORDING), { tokens: lessonTokens(2) }, "hold:transcript_too_short", 1],
      ["the student was absent", absent, {}, "skip:gate:attendance_8pct", 0],
    ];
    for (const [label, detail, sonioxOptions, outcome, jobs] of cases) {
      const soniox = fakeSoniox(sonioxOptions);
      const record = await replayClass(replayDeps({ wise: readOnlyWise(detail).wise, soniox: soniox.client }), SAMPLE);
      expect(record.outcome, label).toBe(outcome);
      expect(soniox.created, label).toHaveLength(jobs);
      expect(soniox.removed, label).toHaveLength(jobs);
    }
  });

  it("keeps a held transcript draft's text and both verdicts for review", async () => {
    const model = fakeModel({ judge: (request) => request.messages[1].content.includes("Lesson transcript:") ? UNFAITHFUL : PASSING });
    const record = await replayClass(
      replayDeps({ wise: readOnlyWise(sessionDetail(RECORDING)).wise, soniox: fakeSoniox().client, callModel: model.callModel as never }),
      SAMPLE,
    );
    expect(record.outcome).toMatch(/^hold:glm:unfaithful:/u);
    expect(record.transcriptDraft).toMatchObject({
      judgeHigh: { faithful: false }, judgeMedium: { faithful: false },
      fields: { topics: GOOD_FIELDS.topics, performance: expect.stringContaining("Tom found common denominators") },
    });
  });

  it("keeps the rendered transcript only when asked", async () => {
    const record = await replayClass(replayDeps({ wise: readOnlyWise(sessionDetail(RECORDING)).wise, soniox: fakeSoniox().client, keepTranscripts: true }), SAMPLE);
    expect(record.transcript).toContain("[00:00] TUTOR: Today we add fractions");
  });
});

describe("replay summary", () => {
  it("measures holds, fallbacks, judge efforts and cost, and its markdown holds no lesson text", async () => {
    const soniox = fakeSoniox();
    const unparseableMedium = fakeModel({ judge: (request) => request.effort === "medium" ? "{\"faithful\": true}" : PASSING });
    const samples: ReplaySample[] = [
      SAMPLE,
      { ...SAMPLE, wiseSessionId: "6a0000000000000000000022" },
      { ...SAMPLE, wiseSessionId: "6a0000000000000000000023" },
      { ...SAMPLE, wiseSessionId: "6a0000000000000000000024" },
    ];
    const details = [sessionDetail(RECORDING), sessionDetail(RECORDING), sessionDetail(), sessionDetail({ ...RECORDING, type: "OFFLINE" })];
    const seen: number[] = [];
    const records = await runReplay({
      ...replayDeps({ wise: readOnlyWise(sessionDetail()).wise, soniox: soniox.client, callModel: unparseableMedium.callModel as never }),
      wise: { getSessionDetailById: async (id) => ({ data: details[samples.findIndex((sample) => sample.wiseSessionId === id)] }) },
    }, samples, { concurrency: 2, onRecord: (_record, index) => seen.push(index) });
    expect(records.map((record) => record.outcome)).toEqual(["draft", "draft", "fallback:no_recording", "skip:gate:session_type_OFFLINE"]);
    expect(seen.toSorted()).toEqual([0, 1, 2, 3]);

    const summary = summarizeReplay(records);
    expect(summary).toMatchObject({
      classes: 4, decided: 3,
      outcomes: { draft: 2, hold: 0, fallback: 1, skip: 1, error: 0 },
      fallbacks: [{ cause: "no_recording", count: 1, afterFallback: ["draft"] }],
      soniox: { jobs: 2, audioMinutes: 120, perTranscribedClassUsd: expect.closeTo(0.1, 6), undeletedJobs: [] },
      judge: { pairs: 0, medium: { calls: 2, parseFailures: 2 }, high: { parseFailures: 0, p90LatencyMs: 45_000 } },
      acceptance: {
        transcriptHoldsAtMost15Percent: true, fallbacksAtMost20Percent: false, noJudgeParseFailures: false,
        judgeP90AtMost90Seconds: true, sonioxAboutTenCentsPerClass: true,
      },
    });
    expect(summary.fallbackRate).toBeCloseTo(1 / 3, 6);

    const markdown = renderReplayMarkdown({ summary, records, commit: "local:abc", generatedAt: new Date("2026-09-30T05:00:00.000Z") });
    expect(markdown).toContain("| fallback | 1 |");
    expect(markdown).toContain("acceptance ≤ 20%: **NO**");
    for (const text of [GOOD_FIELDS.topics, GOOD_FIELDS.performance.slice(0, 40), "Tom", "Somchai", "three quarters"]) {
      expect(markdown).not.toContain(text);
    }
  });

  it("drops the judge's quotes from hold reasons, even quotes with semicolons in them", () => {
    expect(reasonCategory("hold:glm:unfaithful:he finished; then left | the last pages; luna:unfaithful:it was late"))
      .toBe("hold:glm:unfaithful; luna:unfaithful");
    expect(reasonCategory("hold:glm:placeholder_token:topics; luna:unfaithful:x; y")).toBe("hold:glm:placeholder_token:topics; luna:unfaithful");
    expect(reasonCategory("fallback:no_recording")).toBe("fallback:no_recording");
  });
});
