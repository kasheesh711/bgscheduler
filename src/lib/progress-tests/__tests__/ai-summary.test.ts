import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateProgressTestSummary,
  isProgressTestAiConfigured,
  progressTestAiModel,
  type ProgressTestFeedbackNote,
} from "@/lib/progress-tests/ai-summary";

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ENABLE_AI_SCHEDULER: process.env.ENABLE_AI_SCHEDULER,
  OPENAI_PROGRESS_TEST_MODEL: process.env.OPENAI_PROGRESS_TEST_MODEL,
};

const VALID_SUMMARY = {
  headline: "Strong arithmetic, building confidence with word problems.",
  strengths: ["Mental math", "Engaged in class"],
  focusAreas: ["Multi-step word problems"],
  recommendation: "Cover ratio word problems before the test.",
};

function note(overrides: Partial<ProgressTestFeedbackNote> = {}): ProgressTestFeedbackNote {
  return {
    scheduledStartTime: new Date("2026-05-12T09:00:00.000Z"),
    teacherFeedback:
      "Student worked through fractions confidently and asked thoughtful questions about ratios.",
    ...overrides,
  };
}

describe("generateProgressTestSummary", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.ENABLE_AI_SCHEDULER = "true";
    delete process.env.OPENAI_PROGRESS_TEST_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns skipped and makes NO fetch when the OpenAI key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateProgressTestSummary([note(), note()]);

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns skipped when AI is disabled via ENABLE_AI_SCHEDULER", async () => {
    process.env.ENABLE_AI_SCHEDULER = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateProgressTestSummary([note(), note()]);

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("short-circuits to sparse with NO fetch when there is too little feedback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Only one non-empty note (the other is blank) → below the meaningful-note floor.
    const result = await generateProgressTestSummary([
      note({ teacherFeedback: "Great work today, very focused." }),
      note({ teacherFeedback: "   " }),
    ]);

    expect(result.status).toBe("sparse");
    if (result.status === "sparse") {
      expect(result.sessionsUsed).toBe(1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("short-circuits to sparse with NO fetch when total feedback is under the char floor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateProgressTestSummary([
      note({ teacherFeedback: "ok" }),
      note({ teacherFeedback: "fine" }),
    ]);

    expect(result.status).toBe("sparse");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns failed when the model output is not valid JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: "not json at all" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateProgressTestSummary([note(), note(), note()]);

    expect(result.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns failed when the JSON does not match the strict summary schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ headline: "only a headline" }) }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateProgressTestSummary([note(), note(), note()]);

    expect(result.status).toBe("failed");
  });

  it("returns failed when the OpenAI request is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "boom" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateProgressTestSummary([note(), note(), note()]);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("boom");
    }
  });

  it("returns ok with the parsed summary on valid structured output", async () => {
    process.env.OPENAI_PROGRESS_TEST_MODEL = "gpt-5.4-mini";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(VALID_SUMMARY) }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateProgressTestSummary([note(), note(), note()]);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.summary).toEqual(VALID_SUMMARY);
      expect(result.model).toBe("gpt-5.4-mini");
      expect(result.sessionsUsed).toBe(3);
    }

    // Mirrors the scheduler's Responses-API contract.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
  });

  it("never sends more than the last 8 notes to the model", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(VALID_SUMMARY) }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const manyNotes = Array.from({ length: 12 }, (_, i) =>
      note({
        scheduledStartTime: new Date(2026, 4, i + 1, 9, 0, 0),
        teacherFeedback: `Class ${i + 1}: solid progress on the current topic this week.`,
      }),
    );

    const result = await generateProgressTestSummary(manyNotes);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sessionsUsed).toBe(8);
    }
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const userContent = body.input[1].content as string;
    // The 8 freshest classes only; the oldest 4 (Class 1-4) are dropped.
    expect(userContent).toContain("solid progress");
    expect(userContent).not.toContain("Class 1:");
    expect(userContent).not.toContain("Class 4:");
  });
});

describe("isProgressTestAiConfigured", () => {
  const original = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ENABLE_AI_SCHEDULER: process.env.ENABLE_AI_SCHEDULER,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("is true with a key and AI not disabled", () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ENABLE_AI_SCHEDULER;
    expect(isProgressTestAiConfigured()).toBe(true);
  });

  it("is false without a key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(isProgressTestAiConfigured()).toBe(false);
  });

  it("is false when explicitly disabled", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.ENABLE_AI_SCHEDULER = "false";
    expect(isProgressTestAiConfigured()).toBe(false);
  });
});

describe("progressTestAiModel", () => {
  const original = process.env.OPENAI_PROGRESS_TEST_MODEL;

  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_PROGRESS_TEST_MODEL;
    else process.env.OPENAI_PROGRESS_TEST_MODEL = original;
  });

  it("defaults to the scheduler model when unset", () => {
    delete process.env.OPENAI_PROGRESS_TEST_MODEL;
    expect(progressTestAiModel()).toBe("gpt-5.4-mini");
  });

  it("uses the override when set", () => {
    process.env.OPENAI_PROGRESS_TEST_MODEL = "gpt-custom";
    expect(progressTestAiModel()).toBe("gpt-custom");
  });
});
