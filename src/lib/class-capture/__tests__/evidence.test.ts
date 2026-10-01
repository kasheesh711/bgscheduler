import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateCaptureDraft } from "../evidence";

const base = {
  topic: "Fractions", tutorNotes: "The student explained equivalent fractions with one prompt.",
  assets: [
    { id: "audio-1", kind: "recording" as const, transcript: "Today we compare fractions. วันนี้ฝึกเศษส่วน Please try questions two and three." },
    { id: "debrief-1", kind: "debrief" as const, transcript: "I observed difficulty finding a common denominator." },
    { id: "photo-1", kind: "worksheet" as const, transcript: "This worksheet must not be sent to any model." },
  ],
  prior: [{ date: "2026-09-25", text: "Earlier feedback: addition was discussed." }],
};

function selections() {
  return {
    topicsCovered: [{ sourceId: "recording:audio-1", quote: "วันนี้ฝึกเศษส่วน" }],
    demonstratedUnderstanding: [{ sourceId: "tutor-notes", quote: "The student explained equivalent fractions with one prompt." }],
    difficulties: [{ sourceId: "debrief:debrief-1", quote: "I observed difficulty finding a common denominator." }],
    homeworkNextSteps: [{ sourceId: "recording:audio-1", quote: "Please try questions two and three." }],
  };
}

function modelReply(content: unknown, status = 200) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(status === 200 ? {
    model: "openai/gpt-6.1-sol", provider: "Azure", id: "synthetic-generation", usage: {},
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
  } : content), { status }));
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

beforeEach(() => {
  vi.stubEnv("ENABLE_CLASS_CAPTURE", "true");
  vi.stubEnv("CLASS_CAPTURE_PROCESSING_APPROVED", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("capture evidence draft", () => {
  it("renders exact current-source excerpts with distinct class, tutor note, and debrief attribution", async () => {
    const fetchImpl = modelReply(selections());
    const draft = await generateCaptureDraft(base);
    expect(draft.topicsCovered).toContain("Class audio (speaker unverified; recording:audio-1): “วันนี้ฝึกเศษส่วน”");
    expect(draft.demonstratedUnderstanding).toContain("Tutor observation (tutor-notes): “The student explained equivalent fractions with one prompt.”");
    expect(draft.difficulties).toContain("Tutor debrief (debrief:debrief-1): “I observed difficulty finding a common denominator.”");
    expect(draft.homeworkNextSteps).toContain("Confirm the assignment before submitting.");
    const request = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(request.provider).toMatchObject({ zdr: true, data_collection: "deny", require_parameters: true });
    expect(request.model).toBe("openai/gpt-6.1-sol");
    expect(request.response_format.json_schema.strict).toBe(true);
    const user = JSON.parse(request.messages[1].content);
    expect(user.priorContextOnly).toEqual([{ date: "2026-09-25", text: "Earlier feedback: addition was discussed." }]);
    expect(JSON.stringify(user)).not.toContain("worksheet must not");
    expect(JSON.stringify(user)).not.toContain("photo-1");
  });

  it("rejects invented quotes, prior-feedback citations, and extra model-authored claims", async () => {
    for (const claim of [
      { sourceId: "recording:audio-1", quote: "The student mastered all fractions." },
      { sourceId: "prior:0", quote: "Earlier feedback: addition was discussed." },
      { sourceId: "recording:audio-1", quote: "Today we compare fractions.", claim: "Mastery is proven." },
    ]) {
      modelReply({ ...selections(), topicsCovered: [claim] });
      await expect(generateCaptureDraft(base)).rejects.toMatchObject({ status: 422 });
    }
  });

  it("refuses understanding from unverified class speakers even when the quote exists", async () => {
    modelReply({ ...selections(), demonstratedUnderstanding: [{ sourceId: "recording:audio-1", quote: "Today we compare fractions." }] });
    await expect(generateCaptureDraft(base)).rejects.toMatchObject({ status: 422 });
  });

  it("does not invent evidence when the model finds none or only worksheets are available", async () => {
    const empty = { topicsCovered: [], demonstratedUnderstanding: [], difficulties: [], homeworkNextSteps: [] };
    modelReply(empty);
    const draft = await generateCaptureDraft(base);
    expect(draft.demonstratedUnderstanding).toContain("No tutor observation supports a claim yet.");
    expect(draft.difficulties).toContain("Insufficient current evidence");
    const fetchImpl = modelReply(empty);
    await expect(generateCaptureDraft({ ...base, tutorNotes: "", assets: [base.assets[2]] })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds current and historical inputs and rejects ambiguous asset identifiers before spending", async () => {
    const fetchImpl = modelReply(selections());
    await expect(generateCaptureDraft({ ...base, assets: [{ ...base.assets[0], transcript: "a".repeat(90_001) }] })).rejects.toMatchObject({ status: 413 });
    await expect(generateCaptureDraft({ ...base, assets: [base.assets[0], base.assets[0]] })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
    modelReply(selections());
    const bounded = vi.mocked(fetch);
    await generateCaptureDraft({ ...base, prior: Array.from({ length: 5 }, () => ({ date: "2026-09-25", text: "x".repeat(3_000) })) });
    const body = JSON.parse(String(bounded.mock.calls[0][1]?.body));
    const user = JSON.parse(body.messages[1].content);
    expect(user.priorContextOnly).toHaveLength(3);
    expect(user.priorContextOnly[0].text).toHaveLength(2_000);
  });

  it("returns a safe error for missing approval/key or provider failure without a fallback call", async () => {
    const fetchImpl = modelReply({ error: { message: "private student transcript" } }, 402);
    await expect(generateCaptureDraft(base)).rejects.toMatchObject({ status: 503, message: "Draft generation is unavailable. Keep your evidence and try again later." });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.stubEnv("CLASS_CAPTURE_PROCESSING_APPROVED", "false");
    await expect(generateCaptureDraft(base)).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.stubEnv("CLASS_CAPTURE_PROCESSING_APPROVED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(generateCaptureDraft(base)).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a response from an unexpected model even if its quotes are valid", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: "unexpected-model", provider: "Azure", usage: {},
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(selections()) } }],
    })));
    vi.stubGlobal("fetch", fetchImpl);
    await expect(generateCaptureDraft(base)).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects total rendered output above 8000 characters", async () => {
    const quote = "a".repeat(900);
    const notes = Array.from({ length: 3 }, (_, i) => `${i}${quote}`).join(" ");
    const quotes = Array.from({ length: 3 }, (_, i) => ({ sourceId: "tutor-notes", quote: `${i}${quote}` }));
    modelReply({ topicsCovered: quotes, demonstratedUnderstanding: quotes, difficulties: quotes, homeworkNextSteps: quotes });
    await expect(generateCaptureDraft({ topic: "Fictional topic", tutorNotes: notes, assets: [], prior: [] })).rejects.toMatchObject({ status: 422 });
  });
});
